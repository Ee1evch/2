// Жесты по экрану ПК на телефоне — как в приложениях удалённого рабочего стола:
//   касание — клик в этой точке, удержание — правый клик, касание и провести — перетаскивание
//   (выделение, перенос окон); два пальца — щипок увеличивает картинку, сдвиг двигает увеличенную,
//   а на неувеличенной — прокрутка колесом.
// Логика без DOM: координаты — пиксели области просмотра; ПК получает доли кадра 0..1.

import type { PointerAction } from './proto'

export interface Rect { x: number; y: number; w: number; h: number }

export interface ScreenOut {
  pointer(fx: number, fy: number, a: PointerAction): void
  scroll(v: number, h: number): void
  /** Где сейчас картинка в области просмотра (после щипка и сдвига). */
  view(r: Rect): void
  haptic?(kind: 'tick' | 'tap' | 'heavy'): void
}

const TAP_SLOP = 9
const LONG_MS = 550
const MAX_ZOOM = 5
/** Колесо: пикселей пальца на «щелчок» (120 единиц). */
const SCROLL_PX = 40

interface P { x: number; y: number }

export class ScreenGestures {
  rect: Rect = { x: 0, y: 0, w: 1, h: 1 }
  private box = { w: 1, h: 1 }
  private frame = { w: 16, h: 9 }
  private pts = new Map<number, P>()
  private start: (P & { t: number }) | null = null
  private moved = false
  private consumed = false
  private dragging = false
  private longTimer: ReturnType<typeof setTimeout> | null = null
  private two: { dist: number; mid: P; rect: Rect; mode: '' | 'zoom' | 'pan' | 'scroll'; acc: number; accH: number } | null = null

  constructor(private readonly out: ScreenOut, private readonly now: () => number = () => performance.now()) {}

  /** Размер области просмотра или кадра изменился — картинка снова вписывается целиком. */
  layout(boxW: number, boxH: number, frameW = this.frame.w, frameH = this.frame.h) {
    const changed = boxW !== this.box.w || boxH !== this.box.h || frameW / frameH !== this.frame.w / this.frame.h
    this.box = { w: boxW, h: boxH }
    this.frame = { w: frameW, h: frameH }
    // размер холста мог смениться — вид применяется заново в любом случае
    if (changed) this.fit()
    else this.out.view(this.rect)
  }

  fit() {
    const k = Math.min(this.box.w / this.frame.w, this.box.h / this.frame.h)
    const w = this.frame.w * k, h = this.frame.h * k
    this.setRect({ x: (this.box.w - w) / 2, y: (this.box.h - h) / 2, w, h })
  }

  get zoomed() { return this.rect.w > this.fitW() * 1.05 }
  private fitW() { return this.frame.w * Math.min(this.box.w / this.frame.w, this.box.h / this.frame.h) }

  private setRect(r: Rect) {
    const base = this.fitW()
    const w = Math.max(base, Math.min(base * MAX_ZOOM, r.w)), h = w * (this.frame.h / this.frame.w)
    // не даём картинке уехать: меньше области — по центру, больше — края не отрываются
    const clamp = (pos: number, size: number, box: number) => (size <= box ? (box - size) / 2 : Math.min(0, Math.max(box - size, pos)))
    this.rect = { x: clamp(r.x, w, this.box.w), y: clamp(r.y, h, this.box.h), w, h }
    this.out.view(this.rect)
  }

  /** Точка области просмотра → доли кадра. */
  toFrame(p: P): [number, number] {
    return [Math.max(0, Math.min(1, (p.x - this.rect.x) / this.rect.w)), Math.max(0, Math.min(1, (p.y - this.rect.y) / this.rect.h))]
  }

  private ptr(p: P, a: PointerAction) {
    const [fx, fy] = this.toFrame(p)
    this.out.pointer(fx, fy, a)
  }

  private clearLong() { if (this.longTimer) { clearTimeout(this.longTimer); this.longTimer = null } }

  down(id: number, x: number, y: number) {
    this.pts.set(id, { x, y })
    if (this.pts.size === 1) {
      this.start = { x, y, t: this.now() }
      this.moved = this.consumed = this.dragging = false
      this.longTimer = setTimeout(() => {
        this.longTimer = null
        if (this.pts.size === 1 && !this.moved && this.start) {
          this.consumed = true
          this.out.haptic?.('heavy')
          this.ptr(this.start, 'right')
        }
      }, LONG_MS)
      return
    }
    // второй палец: перетаскивание заканчиваем, начинается щипок, сдвиг или прокрутка
    this.clearLong()
    if (this.dragging) { const [a] = this.pts.values(); this.ptr(a, 'up'); this.dragging = false }
    this.consumed = true
    const [a, b] = [...this.pts.values()]
    this.two = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rect: { ...this.rect }, mode: '', acc: 0, accH: 0 }
  }

  move(id: number, x: number, y: number) {
    const p = this.pts.get(id)
    if (!p) return
    p.x = x; p.y = y
    if (this.pts.size >= 2 && this.two) { this.twoMove(); return }
    if (this.pts.size !== 1 || this.consumed || !this.start) return
    if (!this.moved && Math.hypot(x - this.start.x, y - this.start.y) > TAP_SLOP) {
      this.moved = true
      this.clearLong()
      this.dragging = true
      this.out.haptic?.('tick')
      this.ptr(this.start, 'down')
    }
    if (this.dragging) this.ptr(p, 'move')
  }

  private twoMove() {
    const g = this.two!
    const [a, b] = [...this.pts.values()]
    const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const k = dist / Math.max(1, g.dist)
    if (!g.mode) {
      if (Math.abs(k - 1) > 0.12) g.mode = 'zoom'
      else if (Math.hypot(mid.x - g.mid.x, mid.y - g.mid.y) > 10) {
        g.mode = this.zoomed ? 'pan' : 'scroll'
        if (g.mode === 'scroll') this.ptr(g.mid, 'move') // колесо крутит то, что под пальцами
      } else return
    }
    if (g.mode === 'scroll') {
      g.acc += (mid.y - g.mid.y); g.accH += (mid.x - g.mid.x)
      g.mid = mid
      const v = Math.trunc(g.acc / SCROLL_PX * 120 / 30) * 30, h = Math.trunc(g.accH / SCROLL_PX * 120 / 30) * 30
      if (v || h) {
        // естественная прокрутка: палец вверх — страница вниз
        this.out.scroll(v, -h)
        g.acc -= (v / 120) * SCROLL_PX; g.accH -= (h / 120) * SCROLL_PX
      }
      return
    }
    // щипок и сдвиг: точка картинки под серединой пальцев остаётся под ней
    const scale = g.mode === 'zoom' ? k : 1
    const r = g.rect
    const w = r.w * scale, h = r.h * scale
    const ox = (g.mid.x - r.x) / r.w, oy = (g.mid.y - r.y) / r.h
    this.setRect({ x: mid.x - ox * w, y: mid.y - oy * h, w, h })
  }

  up(id: number) {
    const p = this.pts.get(id)
    if (!p) return
    this.pts.delete(id)
    if (this.pts.size === 1 && this.two) { this.two = null; return } // остался один палец после щипка — ничего не делаем
    if (this.pts.size > 0) return
    this.two = null
    this.clearLong()
    if (this.dragging) { this.ptr(p, 'up'); this.dragging = false; return }
    if (!this.consumed && !this.moved && this.start) {
      this.out.haptic?.('tap')
      this.ptr(this.start, 'click')
    }
    this.start = null
  }

  cancel(id: number) {
    if (this.dragging && this.pts.size === 1) { const p = this.pts.get(id); if (p) this.ptr(p, 'up') }
    this.dragging = false
    this.pts.delete(id)
    this.clearLong()
    if (this.pts.size === 0) { this.two = null; this.start = null }
  }
}
