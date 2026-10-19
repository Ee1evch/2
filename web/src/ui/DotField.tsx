import { useEffect, useRef } from 'preact/hooks'
import { createField, type FieldMsg, type Mode, type RGB } from './dotfield-core'

// Живое поле точек — фирменный элемент из Page AI Agent: две бегущие волны, отклик на палец,
// круговая волна от касания, «пульс» при работе. В DotLink к нему добавлены пальцы тачпада:
// под каждым касанием поле подсвечивается акцентом.
// Рисуется в отдельном потоке (OffscreenCanvas), где он есть; иначе — в основном.

export interface DotFieldApi {
  ripple(x: number, y: number): void
  touch(id: number, x: number, y: number): void
  release(id: number): void
  busy(on: boolean): void
}

interface Props { mode?: Mode; pitch?: number; apiRef?: { current: DotFieldApi | null }; class?: string }

const parseRgb = (v: string): RGB => {
  const s = v.trim()
  if (s.startsWith('#')) {
    const h = s.length === 4 ? s.slice(1).split('').map((c) => c + c).join('') : s.slice(1, 7)
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const m = s.match(/[\d.]+/g)
  return m ? [+m[0], +m[1], +m[2]] : [128, 128, 128]
}

const offscreen = () => typeof Worker === 'function' && typeof HTMLCanvasElement !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype

export function DotField({ mode = 'hero', pitch = 9, apiRef, class: cls }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current!
    const host = cv.parentElement!
    let post: (m: FieldMsg) => void
    let stop: () => void
    if (offscreen()) {
      const w = new Worker(new URL('./dotfield.worker.ts', import.meta.url), { type: 'module' })
      const canvas = cv.transferControlToOffscreen()
      w.postMessage({ t: 'init', canvas, mode, pitch }, [canvas])
      post = (m) => w.postMessage(m)
      stop = () => w.terminate()
    } else {
      const f = createField(cv, mode, pitch)
      let id = 0
      const loop = (now: number) => { f.frame(now); id = requestAnimationFrame(loop) }
      id = requestAnimationFrame(loop)
      post = (m) => f.handle(m, performance.now())
      stop = () => cancelAnimationFrame(id)
    }

    // размеры, цвета темы и «окна» под карточками считает основной поток — DOM есть только здесь
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const dpr = () => Math.min(2.5, Math.max(1.5, devicePixelRatio || 2))
    const size = () => post({ t: 'size', W: cv.clientWidth, H: cv.clientHeight, dpr: dpr() })
    const ro = new ResizeObserver(size)
    ro.observe(cv)
    size()
    let colKey = ''
    const env = () => {
      const cs = getComputedStyle(cv)
      const raw = ['--muted', '--text', '--accent'].map((k) => cs.getPropertyValue(k))
      const key = raw.join('|')
      const o = cv.getBoundingClientRect()
      const rects = [...host.querySelectorAll('[data-dots-avoid]')].map((e) => {
        const r = e.getBoundingClientRect()
        return [r.left - o.left - 6, r.top - o.top - 6, r.right - o.left + 6, r.bottom - o.top + 6]
      })
      const calm = reduced.matches || document.documentElement.classList.contains('dl-calm')
      post({ t: 'env', hidden: document.hidden, calm, rects, ...(key !== colKey ? { col: { mu: parseRgb(raw[0]), fg: parseRgb(raw[1]), ac: parseRgb(raw[2]) } } : {}) })
      colKey = key
    }
    env()
    const envTimer = setInterval(env, 600)
    document.addEventListener('visibilitychange', env)

    const rel = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
    const onMove = (e: PointerEvent) => { if (e.pointerType === 'mouse') { const [x, y] = rel(e); post({ t: 'pointer', x, y }) } }
    const onLeave = () => post({ t: 'pointer', x: -999, y: -999 })
    const onDown = (e: PointerEvent) => { const [x, y] = rel(e); post({ t: 'ripple', x, y }) }
    if (mode !== 'pad') {
      addEventListener('pointermove', onMove, { passive: true })
      document.addEventListener('pointerleave', onLeave)
      addEventListener('pointerdown', onDown, { passive: true })
    }
    if (apiRef) apiRef.current = {
      ripple: (x, y) => post({ t: 'ripple', x, y }),
      touch: (id, x, y) => post({ t: 'touch', id, x, y }),
      release: (id) => post({ t: 'release', id }),
      busy: (on) => post({ t: 'busy', on }),
    }
    return () => {
      stop()
      ro.disconnect()
      clearInterval(envTimer)
      document.removeEventListener('visibilitychange', env)
      removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      removeEventListener('pointerdown', onDown)
      if (apiRef) apiRef.current = null
    }
  }, [mode, pitch])

  // canvas пересоздаётся при смене режима: отданный воркеру холст второй раз не передать
  return <canvas key={`${mode}-${pitch}`} ref={ref} class={'dfield ' + (cls || '')} aria-hidden="true" />
}
