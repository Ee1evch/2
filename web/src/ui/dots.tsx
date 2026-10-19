import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { glyphOf } from './dotglyphs.js'
import { ICONS, type IconName } from './doticons'

/** Точечная иконка 9×9. */
export function DotIcon({ name, size = 18, class: cls }: { name: IconName; size?: number; class?: string }) {
  const rows = ICONS[name]
  const dots: preact.JSX.Element[] = []
  rows.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      const ch = line[x]
      if (ch === '#' || ch === 'o') dots.push(<circle key={y * 9 + x} cx={x + 0.5} cy={y + 0.5} r={0.4} class={ch === 'o' ? 'o' : undefined} />)
    }
  })
  return <svg class={'dl-icon ' + (cls || '')} width={size} height={size} viewBox="0 0 9 9" aria-hidden="true">{dots}</svg>
}

// детерминированный «шум» для задержек — точки переключаются не разом, а россыпью
const jitter = (i: number) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1

/**
 * Табло: текст точечной матрицей 5×7, негорящие точки видны тускло.
 * При смене текста точки гаснут и загораются россыпью — как механическое табло.
 */
export function DotDisplay({ text, pitch = 5, lit = 'var(--text)', off = 'var(--dot-off)', label, class: cls }: {
  text: string; pitch?: number; lit?: string; off?: string; label?: string; class?: string
}) {
  const chars = [...text]
  const w = Math.max(1, chars.length * 6 - 1) * pitch, h = 7 * pitch, r = pitch * 0.4
  const dots: preact.JSX.Element[] = []
  chars.forEach((ch, ci) => {
    const rows = glyphOf(ch) || glyphOf(' ')!
    const top = rows.length === 8 ? -1 : 0
    for (let ry = 0; ry < 7; ry++) for (let cx = 0; cx < 5; cx++) {
      const on = rows[ry - top]?.[cx] === '#'
      const i = ci * 35 + ry * 5 + cx
      dots.push(<circle key={i} cx={(ci * 6 + cx + 0.5) * pitch} cy={(ry + 0.5) * pitch} r={r} fill={on ? lit : off} style={{ transitionDelay: `${(jitter(i) * 140) | 0}ms` }} />)
    }
    if (top === -1) for (let cx = 0; cx < 5; cx++) if (rows[0][cx] === '#') dots.push(<circle key={'a' + ci + cx} cx={(ci * 6 + cx + 0.5) * pitch} cy={-0.5 * pitch} r={r} fill={lit} />)
  })
  return (
    <svg class={'dl-display ' + (cls || '')} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label ?? text}>{dots}</svg>
  )
}

function useWidth<T extends HTMLElement | SVGElement>(): [preact.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setW(el.getBoundingClientRect().width))
    ro.observe(el)
    setW(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** Полоса нагрузки из точек: 0..1. Последняя горящая точка выше порога `hot` — акцентом. */
export function DotMeter({ value, pitch = 8, rows = 2, hot = 0.85 }: { value: number; pitch?: number; rows?: number; hot?: number }) {
  const [ref, w] = useWidth<SVGSVGElement>()
  const cols = Math.max(4, Math.floor((w + pitch * 0.2) / pitch))
  const lit = Math.round(Math.max(0, Math.min(1, value)) * cols)
  const dots: preact.JSX.Element[] = []
  for (let x = 0; x < cols; x++) for (let y = 0; y < rows; y++) {
    const on = x < lit
    dots.push(<circle key={x * rows + y} cx={x * pitch + pitch / 2} cy={y * pitch + pitch / 2} r={pitch * 0.32} class={on ? (value >= hot && x >= lit - 2 ? 'hot' : 'on') : undefined} />)
  }
  return <svg ref={ref} class="dmeter" height={rows * pitch} aria-hidden="true">{w > 0 && dots}</svg>
}

/** История значений столбиками точек (график нагрузки). */
export function DotSpark({ values, rows = 6, pitch = 7 }: { values: number[]; rows?: number; pitch?: number }) {
  const [ref, w] = useWidth<SVGSVGElement>()
  const cols = Math.max(4, Math.floor((w + pitch * 0.2) / pitch))
  const data = values.slice(-cols)
  const pad = cols - data.length
  const dots: preact.JSX.Element[] = []
  for (let x = 0; x < cols; x++) {
    const v = x < pad ? 0 : data[x - pad]
    const hgt = Math.round(Math.max(0, Math.min(1, v)) * rows)
    for (let y = 0; y < rows; y++) {
      const on = rows - y <= hgt
      const top = on && rows - y === hgt && x === cols - 1
      dots.push(<circle key={x * rows + y} cx={x * pitch + pitch / 2} cy={y * pitch + pitch / 2} r={pitch * 0.3} class={top ? 'hot' : on ? 'on' : undefined} />)
    }
  }
  return <svg ref={ref} class="dspark" height={rows * pitch} aria-hidden="true">{w > 0 && dots}</svg>
}

/** Матрица прогресса: каждая точка — блок файла; свежие — акцентом. */
export function DotGrid({ total, have, fresh, pitch = 9 }: { total: number; have: (i: number) => boolean; fresh?: (i: number) => boolean; pitch?: number }) {
  const [ref, w] = useWidth<SVGSVGElement>()
  const cols = Math.max(8, Math.floor(w / pitch))
  const shown = Math.min(total, cols * 24)
  const per = total / shown
  const rows = Math.ceil(shown / cols)
  const dots = useMemo(() => {
    const out: preact.JSX.Element[] = []
    for (let i = 0; i < shown; i++) {
      const from = Math.floor(i * per), to = Math.max(from + 1, Math.floor((i + 1) * per))
      let all = true, nw = false
      for (let j = from; j < to; j++) { if (!have(j)) all = false; if (fresh?.(j)) nw = true }
      out.push(<circle key={i} cx={(i % cols) * pitch + pitch / 2} cy={Math.floor(i / cols) * pitch + pitch / 2} r={pitch * 0.32} class={all ? (nw ? 'on new' : 'on') : undefined} />)
    }
    return out
  }, [shown, cols, per, have, fresh, pitch])
  return <svg ref={ref} class="dgrid" height={rows * pitch} aria-hidden="true">{w > 0 && dots}</svg>
}

/** Картинка как полутон из точек (обложка трека). */
export function Halftone({ src, size = 120, grid = 24, class: cls }: { src?: string | null; size?: number; grid?: number; class?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!
    const dpr = Math.min(3, devicePixelRatio || 2)
    cv.width = size * dpr; cv.height = size * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const cs = getComputedStyle(cv)
    const fg = cs.getPropertyValue('--text').trim() || '#fff', off = cs.getPropertyValue('--dot-off').trim()
    const step = size / grid
    const draw = (lum: (x: number, y: number) => number) => {
      g.clearRect(0, 0, size, size)
      for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
        const l = lum(x, y)
        g.fillStyle = l < 0.06 ? off : fg
        g.globalAlpha = l < 0.06 ? 1 : 0.35 + 0.65 * l
        g.beginPath(); g.arc((x + 0.5) * step, (y + 0.5) * step, Math.max(0.6, step * 0.46 * Math.sqrt(Math.max(l, 0.06))), 0, 6.2832); g.fill()
      }
      g.globalAlpha = 1
    }
    if (!src) {
      // заглушка: крупная нота из иконки media на тусклом поле
      const icon = ICONS.media, k = Math.max(1, Math.floor(grid / 12)), o = Math.floor((grid - 9 * k) / 2)
      draw((x, y) => { const ix = Math.floor((x - o) / k), iy = Math.floor((y - o) / k); return icon[iy]?.[ix] === '#' ? 0.55 : 0 })
      return
    }
    const img = new Image()
    img.onload = () => {
      const tmp = document.createElement('canvas'); tmp.width = grid; tmp.height = grid
      const t = tmp.getContext('2d')!
      t.drawImage(img, 0, 0, grid, grid)
      const d = t.getImageData(0, 0, grid, grid).data
      draw((x, y) => { const i = (y * grid + x) * 4; return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255 })
    }
    img.src = src
  }, [src, size, grid])
  return <canvas ref={ref} class={cls} style={{ width: size + 'px', height: size + 'px', display: 'block' }} aria-hidden="true" />
}
