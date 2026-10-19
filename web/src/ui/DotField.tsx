import { useEffect, useRef } from 'preact/hooks'

// Живое поле точек — фирменный элемент из Page AI Agent: две бегущие волны, отклик на палец,
// круговая волна от касания, «пульс» при работе. В DotLink к нему добавлены пальцы тачпада:
// под каждым касанием поле подсвечивается акцентом.

export interface DotFieldApi {
  ripple(x: number, y: number): void
  touch(id: number, x: number, y: number): void
  release(id: number): void
  busy(on: boolean): void
}

type Mode = 'hero' | 'ambient' | 'pad'
interface Props { mode?: Mode; pitch?: number; apiRef?: { current: DotFieldApi | null }; class?: string }

type RGB = [number, number, number]
const parseRgb = (v: string): RGB => {
  const s = v.trim()
  if (s.startsWith('#')) {
    const h = s.length === 4 ? s.slice(1).split('').map((c) => c + c).join('') : s.slice(1, 7)
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const m = s.match(/[\d.]+/g)
  return m ? [+m[0], +m[1], +m[2]] : [128, 128, 128]
}
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

const SCALE: Record<Mode, number> = { hero: 1, ambient: 0.32, pad: 0.5 }

export function DotField({ mode = 'hero', pitch = 9, apiRef, class: cls }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current!
    const g = cv.getContext('2d')!
    const host = cv.parentElement!
    const st = {
      raf: 0, last: 0, phase: 0, boost: 0, busy: false, px: -999, py: -999,
      ripples: [] as { x: number; y: number; t: number }[],
      touches: new Map<number, { x: number; y: number; a: number }>(),
      col: null as null | { mu: RGB; fg: RGB; ac: RGB }, colAt: 0,
      rects: [] as number[][], rectAt: 0,
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')

    const frame = (now: number) => {
      st.raf = requestAnimationFrame(frame)
      const W = cv.clientWidth, H = cv.clientHeight
      if (document.hidden || !W || !H) return
      const calm = reduced.matches || document.documentElement.classList.contains('dl-calm')
      const hot = st.touches.size > 0 || st.ripples.length > 0
      if (now - st.last < (calm ? 500 : hot ? 15 : 33)) return
      const dt = Math.min(0.1, (now - (st.last || now)) / 1000)
      st.last = now
      st.boost += ((st.busy ? 1 : 0) - st.boost) * Math.min(1, dt * 2.2)
      st.phase += dt * (calm ? 0 : 0.5 + st.boost * 1.4)
      const dpr = Math.min(2.5, Math.max(1.5, devicePixelRatio || 2))
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      if (!st.col || now - st.colAt > 1000) {
        const cs = getComputedStyle(cv)
        st.col = { mu: parseRgb(cs.getPropertyValue('--muted')), fg: parseRgb(cs.getPropertyValue('--text')), ac: parseRgb(cs.getPropertyValue('--accent')) }
        st.colAt = now
      }
      if (now - st.rectAt > 600) {
        const o = cv.getBoundingClientRect()
        st.rects = [...host.querySelectorAll('[data-dots-avoid]')].map((e) => {
          const r = e.getBoundingClientRect()
          return [r.left - o.left - 6, r.top - o.top - 6, r.right - o.left + 6, r.bottom - o.top + 6]
        })
        st.rectAt = now
      }
      for (const t of st.touches.values()) t.a = Math.min(1, t.a + dt * 6)
      st.ripples = st.ripples.filter((r) => now - r.t < 1600)

      const { mu, fg, ac } = st.col
      const step = pitch, cols = Math.ceil(W / step) + 1, rows = Math.ceil(H / step) + 1
      const ox = (W - (cols - 1) * step) / 2, oy = (H - (rows - 1) * step) / 2
      const ph = st.phase, scale = SCALE[mode], cx = W / 2, cy = H * 0.45
      const pulseR = ((ph * 70) % (Math.hypot(W, H) / 2 + 100)) - 30
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const px = ox + x * step, py = oy + y * step
        const v = 0.5 + 0.5 * Math.sin(px * 0.021 + ph * 0.9 + 1.7 * Math.sin(py * 0.013 - ph * 0.5))
        const w = 0.5 + 0.5 * Math.sin(py * 0.027 - ph * 0.72 + 2 * Math.sin(px * 0.016 + ph * 0.35))
        let f = Math.pow(v * w, 1.35) * 1.5 * scale
        let a = 0
        if (st.boost > 0.02) { const d = Math.hypot(px - cx, py - cy) - pulseR; f += Math.exp(-(d * d) / 700) * 0.8 * st.boost }
        for (const r of st.ripples) {
          const k = (now - r.t) / 1000, d = Math.hypot(px - r.x, py - r.y) - k * 260
          a += Math.exp(-(d * d) / 480) * (1 - k / 1.6)
        }
        for (const t of st.touches.values()) {
          const d = Math.hypot(px - t.x, py - t.y)
          if (d < 110) a += Math.pow(1 - d / 110, 2) * 1.2 * t.a
        }
        const dm = Math.hypot(px - st.px, py - st.py)
        if (dm < 90) f += Math.pow(1 - dm / 90, 2) * 0.8
        f = Math.min(1, f); a = Math.min(1, a)
        let env = 1
        for (const r of st.rects) if (px > r[0] && px < r[2] && py > r[1] && py < r[3]) { env = 0.18; break }
        const alpha = (0.07 + 0.55 * f + 0.85 * a) * env
        if (alpha < 0.02) continue
        const c = mix(mix(mu, fg, Math.min(1, f * 1.1)), ac, a)
        const rad = step * (0.07 + 0.27 * Math.max(f, a))
        g.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.min(1, alpha).toFixed(3)})`
        g.beginPath(); g.arc(px, py, rad, 0, 6.2832); g.fill()
      }
    }
    st.raf = requestAnimationFrame(frame)

    const rel = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
    const onMove = (e: PointerEvent) => { if (e.pointerType === 'mouse') [st.px, st.py] = rel(e) }
    const onLeave = () => { st.px = st.py = -999 }
    const onDown = (e: PointerEvent) => { const [x, y] = rel(e); st.ripples.push({ x, y, t: performance.now() }); if (st.ripples.length > 6) st.ripples.shift() }
    if (mode !== 'pad') {
      addEventListener('pointermove', onMove, { passive: true })
      document.addEventListener('pointerleave', onLeave)
      addEventListener('pointerdown', onDown, { passive: true })
    }
    if (apiRef) apiRef.current = {
      ripple: (x, y) => { st.ripples.push({ x, y, t: performance.now() }); if (st.ripples.length > 6) st.ripples.shift() },
      touch: (id, x, y) => { const t = st.touches.get(id); if (t) { t.x = x; t.y = y } else st.touches.set(id, { x, y, a: 0 }) },
      release: (id) => { st.touches.delete(id) },
      busy: (on) => { st.busy = on },
    }
    return () => {
      cancelAnimationFrame(st.raf)
      removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      removeEventListener('pointerdown', onDown)
      if (apiRef) apiRef.current = null
    }
  }, [mode, pitch])

  return <canvas ref={ref} class={'dfield ' + (cls || '')} aria-hidden="true" />
}
