// Отрисовка поля точек без DOM: работает и в основном потоке, и в воркере (OffscreenCanvas).
// Две бегущие волны, отклик на палец, круговые волны от касаний, «пульс» при работе.

export type Mode = 'hero' | 'ambient' | 'pad'
export type RGB = [number, number, number]

export interface FieldInput {
  W: number
  H: number
  dpr: number
  hidden: boolean
  calm: boolean
  col: { mu: RGB; fg: RGB; ac: RGB } | null
  rects: number[][]
}

export type FieldMsg =
  | { t: 'size'; W: number; H: number; dpr: number }
  | { t: 'env'; hidden?: boolean; calm?: boolean; col?: { mu: RGB; fg: RGB; ac: RGB }; rects?: number[][] }
  | { t: 'ripple'; x: number; y: number }
  | { t: 'touch'; id: number; x: number; y: number }
  | { t: 'release'; id: number }
  | { t: 'busy'; on: boolean }
  | { t: 'pointer'; x: number; y: number }

const SCALE: Record<Mode, number> = { hero: 1, ambient: 0.32, pad: 0.5 }
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export function createField(cv: HTMLCanvasElement | OffscreenCanvas, mode: Mode, pitch: number) {
  const g = cv.getContext('2d') as Ctx
  const inp: FieldInput = { W: 0, H: 0, dpr: 2, hidden: false, calm: false, col: null, rects: [] }
  const st = {
    last: 0, phase: 0, boost: 0, busy: false, px: -999, py: -999,
    ripples: [] as { x: number; y: number; t: number }[],
    touches: new Map<number, { x: number; y: number; a: number }>(),
  }

  function handle(m: FieldMsg, now: number) {
    switch (m.t) {
      case 'size': inp.W = m.W; inp.H = m.H; inp.dpr = m.dpr; break
      case 'env':
        if (m.hidden !== undefined) inp.hidden = m.hidden
        if (m.calm !== undefined) inp.calm = m.calm
        if (m.col) inp.col = m.col
        if (m.rects) inp.rects = m.rects
        break
      case 'ripple': st.ripples.push({ x: m.x, y: m.y, t: now }); if (st.ripples.length > 6) st.ripples.shift(); break
      case 'touch': { const t = st.touches.get(m.id); if (t) { t.x = m.x; t.y = m.y } else st.touches.set(m.id, { x: m.x, y: m.y, a: 0 }); break }
      case 'release': st.touches.delete(m.id); break
      case 'busy': st.busy = m.on; break
      case 'pointer': st.px = m.x; st.py = m.y; break
    }
  }

  function frame(now: number) {
    const { W, H, col } = inp
    if (inp.hidden || !W || !H || !col) return
    const hot = st.touches.size > 0 || st.ripples.length > 0
    // в покое — 30 кадров/с, под пальцем — каждый кадр экрана
    if (now - st.last < (inp.calm ? 500 : hot ? 7 : 33)) return
    const dt = Math.min(0.1, (now - (st.last || now)) / 1000)
    st.last = now
    st.boost += ((st.busy ? 1 : 0) - st.boost) * Math.min(1, dt * 2.2)
    st.phase += dt * (inp.calm ? 0 : 0.5 + st.boost * 1.4)
    const dpr = inp.dpr
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    for (const t of st.touches.values()) t.a = Math.min(1, t.a + dt * 6)
    st.ripples = st.ripples.filter((r) => now - r.t < 1600)

    const { mu, fg, ac } = col
    const step = pitch, cols = Math.ceil(W / step) + 1, rows = Math.ceil(H / step) + 1
    const ox = (W - (cols - 1) * step) / 2, oy = (H - (rows - 1) * step) / 2
    const ph = st.phase, scale = SCALE[mode], cx = W / 2, cy = H * 0.45
    const pulseR = ((ph * 70) % (Math.hypot(W, H) / 2 + 100)) - 30
    const rects = inp.rects
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
      for (const r of rects) if (px > r[0] && px < r[2] && py > r[1] && py < r[3]) { env = 0.18; break }
      const alpha = (0.07 + 0.55 * f + 0.85 * a) * env
      if (alpha < 0.02) continue
      const c = mix(mix(mu, fg, Math.min(1, f * 1.1)), ac, a)
      const rad = step * (0.07 + 0.27 * Math.max(f, a))
      g.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.min(1, alpha).toFixed(3)})`
      g.beginPath(); g.arc(px, py, rad, 0, 6.2832); g.fill()
    }
  }

  return { handle, frame }
}
