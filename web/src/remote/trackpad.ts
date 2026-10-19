// Жесты тачпада — как на ноутбуке:
//   один палец — курсор (с ускорением), тап — ЛКМ, долгое касание — ПКМ;
//   тап и сразу касание с движением — перетаскивание (кнопка зажата, пока палец на экране);
//   два пальца — прокрутка с инерцией, тап двумя — ПКМ, тремя — средняя кнопка.
// Логика без DOM: события подаются извне, действия уходят в PadOut — так её легко тестировать.
//
// Плавность: положение пальца проходит фильтр One Euro (дрожание сенсора гасится, быстрые
// движения — без задержки), ускорение считается по сглаженной скорости, а не по скачущим
// интервалам между событиями. Каждое движение несёт время касания — ПК проигрывает путь
// в том же ритме (crates/dotlink-core/src/motion.rs). Пока палец стоит, остаток пути
// фильтра доезжает в ритме кадров экрана.

import { OneEuro2D } from '../lib/oneeuro'

export interface PadOut {
  /** Смещение курсора в пикселях; `t` — время касания (мс, часы performance.now). */
  move(dx: number, dy: number, t?: number): void
  scroll(v: number, h: number): void
  button(b: 'left' | 'right' | 'middle', a: 'down' | 'up' | 'click'): void
  haptic(kind: 'tick' | 'tap' | 'heavy'): void
  touch?(id: number, x: number, y: number, on: boolean): void
}

export interface PadPrefs { speed: number; accel: number; natural: boolean; scrollSpeed: number }
export const DEFAULT_PREFS: PadPrefs = { speed: 1.6, accel: 1, natural: true, scrollSpeed: 2.4 }

interface Pt { x: number; y: number; x0: number; y0: number; t: number }

const TAP_MS = 220
const TAP_SLOP = 9
const DRAG_GAP_MS = 260
const LONG_MS = 520
const FRICTION = 0.92

const raf = (f: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : (setTimeout(f, 16) as unknown as number))
const caf = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))

export class Trackpad {
  prefs: PadPrefs = { ...DEFAULT_PREFS }
  private pts = new Map<number, Pt>()
  private maxFingers = 0
  private startT = 0
  private moved = false
  private mode: 'idle' | 'move' | 'scroll' | 'drag' = 'idle'
  private lastTap = { t: -1e9, x: 0, y: 0 }
  private dragArmed = false
  private longTimer: ReturnType<typeof setTimeout> | null = null
  private longFired = false
  private vel = { v: 0, h: 0 }
  private inertia: { v: number; h: number } | null = null
  private raf = 0
  private lastScrollT = 0
  private readonly flt = new OneEuro2D()
  private tracking = false
  private raw = { x: 0, y: 0, t: 0 }
  private settleId = 0

  constructor(private readonly out: PadOut, private readonly now: () => number = () => performance.now()) {}

  down(id: number, x: number, y: number) {
    this.stopInertia()
    const t = this.now()
    this.tracking = false
    if (this.pts.size === 0) {
      this.maxFingers = 0
      this.startT = t
      this.moved = false
      this.longFired = false
      // тап, затем сразу касание рядом — готовим перетаскивание
      this.dragArmed = t - this.lastTap.t < DRAG_GAP_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 60
      this.longTimer = setTimeout(() => this.onLong(), LONG_MS)
    } else if (this.longTimer) {
      clearTimeout(this.longTimer)
      this.longTimer = null
    }
    this.pts.set(id, { x, y, x0: x, y0: y, t })
    this.maxFingers = Math.max(this.maxFingers, this.pts.size)
    this.out.touch?.(id, x, y, true)
  }

  private onLong() {
    this.longTimer = null
    if (this.pts.size === 1 && !this.moved && this.mode !== 'drag') {
      this.longFired = true
      this.out.haptic('heavy')
      this.out.button('right', 'click')
    }
  }

  move(id: number, x: number, y: number, at?: number) {
    const p = this.pts.get(id)
    if (!p) return
    // у coalesced-событий своё время — по нему считаем скорость пальца
    const t = at ?? this.now()
    const dx = x - p.x, dy = y - p.y, dt = Math.max(1, t - p.t)
    const prev = { x: p.x, y: p.y, t: p.t }
    p.x = x; p.y = y; p.t = t
    this.out.touch?.(id, x, y, true)
    if (!this.moved && Math.hypot(x - p.x0, y - p.y0) > TAP_SLOP) {
      this.moved = true
      if (this.longTimer) { clearTimeout(this.longTimer); this.longTimer = null }
      if (this.pts.size === 1 && this.dragArmed) {
        this.mode = 'drag'
        this.out.button('left', 'down')
        this.out.haptic('tap')
      }
    }
    if (!this.moved) return

    if (this.pts.size >= 2) {
      // прокрутка: среднее смещение пальцев, каждый палец даёт половину
      if (this.mode !== 'scroll' && this.mode !== 'drag') this.mode = 'scroll'
      const k = this.prefs.scrollSpeed / this.pts.size
      const sign = this.prefs.natural ? 1 : -1
      const v = sign * dy * k, h = -sign * dx * k
      this.out.scroll(v, h)
      // скорость в единицах колеса за мс — для инерции
      const a = 0.35
      this.vel.v = this.vel.v * (1 - a) + (v / dt) * a
      this.vel.h = this.vel.h * (1 - a) + (h / dt) * a
      this.lastScrollT = t
      return
    }
    if (this.mode === 'scroll') return // второй палец поднят — не дёргаем курсор
    if (this.mode !== 'drag') this.mode = 'move'
    if (!this.tracking) { this.flt.reset(prev.x, prev.y, prev.t); this.tracking = true }
    this.raw = { x, y, t }
    this.step(x, y, t)
    this.scheduleSettle()
  }

  /** Ускорение по сглаженной скорости: медленно — точно, быстро — далеко. */
  private gain(): number {
    return this.prefs.speed * (1 + this.prefs.accel * Math.min(2.4, Math.max(0, (this.flt.speed - 0.25) * 1.5)))
  }

  private step(x: number, y: number, t: number) {
    const f = this.flt, x0 = f.x, y0 = f.y
    f.filter(x, y, t)
    const g = this.gain(), dx = (f.x - x0) * g, dy = (f.y - y0) * g
    if (dx || dy) this.out.move(dx, dy, t)
  }

  /** Палец замер, а событий нет — остаток пути доезжает в ритме кадров. */
  private scheduleSettle() {
    if (this.settleId) return
    this.settleId = raf(() => {
      this.settleId = 0
      if (!this.tracking) return
      const t = this.now()
      if (t - this.raw.t > 12) {
        this.step(this.raw.x, this.raw.y, t)
        if (Math.hypot(this.raw.x - this.flt.x, this.raw.y - this.flt.y) < 0.05) return
      }
      this.scheduleSettle()
    })
  }

  /** Палец поднят — остаток пути сразу, чтобы курсор встал туда, куда его довели. */
  private finishTrack() {
    if (!this.tracking) return
    this.tracking = false
    caf(this.settleId); this.settleId = 0
    const g = this.gain(), dx = (this.raw.x - this.flt.x) * g, dy = (this.raw.y - this.flt.y) * g
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) this.out.move(dx, dy, Math.max(this.raw.t, this.now()))
  }

  up(id: number) {
    const p = this.pts.get(id)
    if (!p) return
    this.pts.delete(id)
    this.out.touch?.(id, p.x, p.y, false)
    if (this.pts.size > 0) { this.tracking = false; return }
    this.finishTrack()
    if (this.longTimer) { clearTimeout(this.longTimer); this.longTimer = null }
    const t = this.now()
    const mode = this.mode
    this.mode = 'idle'
    if (mode === 'drag') {
      this.out.button('left', 'up')
      this.dragArmed = false
      return
    }
    if (!this.moved && !this.longFired && t - this.startT < TAP_MS) {
      const b = this.maxFingers >= 3 ? 'middle' : this.maxFingers === 2 ? 'right' : 'left'
      this.out.button(b, 'click')
      this.out.haptic('tap')
      if (b === 'left') this.lastTap = { t, x: p.x, y: p.y }
      return
    }
    if (mode === 'scroll' && t - this.lastScrollT < 80) this.startInertia()
  }

  cancel(id: number) {
    this.tracking = false
    if (this.mode === 'drag' && this.pts.size === 1) this.out.button('left', 'up')
    if (this.pts.has(id)) { this.pts.delete(id); this.out.touch?.(id, 0, 0, false) }
    if (this.pts.size === 0) { this.mode = 'idle'; if (this.longTimer) { clearTimeout(this.longTimer); this.longTimer = null } }
  }

  private startInertia() {
    if (Math.abs(this.vel.v) < 0.05 && Math.abs(this.vel.h) < 0.05) return
    this.inertia = { ...this.vel }
    let last = this.now()
    const step = () => {
      const i = this.inertia
      if (!i) return
      const t = this.now(), dt = Math.min(48, t - last)
      last = t
      const f = Math.pow(FRICTION, dt / 16)
      i.v *= f; i.h *= f
      this.out.scroll(i.v * dt, i.h * dt)
      if (Math.abs(i.v) < 0.02 && Math.abs(i.h) < 0.02) { this.inertia = null; return }
      this.raf = raf(step)
    }
    this.raf = raf(step)
  }

  stopInertia() {
    this.inertia = null
    caf(this.raf)
    this.vel = { v: 0, h: 0 }
  }
}
