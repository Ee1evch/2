// Экран ПК на телефоне — удалённый рабочий стол: картинка живьём, касание — клик в этой точке,
// удержание — правый клик, перетаскивание, щипок — увеличение, два пальца — прокрутка.
// Каждый кадр подтверждается после отрисовки: в медленной сети частота падает сама, а не задержка растёт.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { DotIcon, haptic, type IconName } from '../ui'
import { pointerFrame, scrollFrame } from '../lib/proto'
import { ScreenGestures } from '../lib/screengest'
import { Keyboard } from './Pad'
import { link } from './state'

const QUALITY = [
  { id: 'fast', label: 'Быстро', max: 960, q: 50 },
  { id: 'sharp', label: 'Чётко', max: 1600, q: 70 },
  { id: 'max', label: 'Максимум', max: 2560, q: 85 },
] as const
type Q = (typeof QUALITY)[number]['id']

const loadQ = (): Q => { try { return (localStorage.getItem('dotlink.screenQ') as Q) || 'sharp' } catch { return 'sharp' } }

interface Mon { w: number; h: number; primary: boolean }

export function Screen() {
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const [mons, setMons] = useState<Mon[]>([])
  const [mon, setMon] = useState(0)
  const [quality, setQuality] = useState<Q>(loadQ)
  const [kbd, setKbd] = useState(false)
  const [stat, setStat] = useState({ fps: 0, kb: 0, w: 0, h: 0 })
  const [denied, setDenied] = useState(false)
  const [got, setGot] = useState(false)
  const online = link.status.value === 'online'

  const g = useMemo(() => new ScreenGestures({
    pointer: (x, y, a) => link.raw(pointerFrame(x, y, a)),
    scroll: (v, h) => link.raw(scrollFrame(v, h)),
    view: (r) => {
      const c = cv.current
      if (c) c.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.w / c.width}, ${r.h / c.height})`
    },
    haptic: (k) => haptic(k),
  }), [])

  // поток: включить при входе на вкладку и после переподключения, выключить при уходе
  useEffect(() => {
    if (!online) return
    const q = QUALITY.find((x) => x.id === quality)!
    link.json({ t: 'screen', on: true, monitor: mon, max: Math.round(q.max * Math.min(1.5, devicePixelRatio || 1) / 1.5), q: q.q })
    return () => { link.json({ t: 'screen', on: false }) }
  }, [online, mon, quality])

  useEffect(() => {
    const offInfo = link.on('screen-info', (m) => { setMons(m.monitors || []); setMon(m.monitor || 0) })
    const offDeny = link.on('denied', (m) => { if (m.what === 'screen') setDenied(true) })
    let frames = 0, bytes = 0, at = performance.now(), busy = false
    const offBin = link.on('bin', async (d: Uint8Array) => {
      if (d[0] !== 0x0c || busy) return
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
      const w = dv.getUint16(2, true), h = dv.getUint16(4, true)
      busy = true
      try {
        const bmp = await createImageBitmap(new Blob([d.subarray(6) as BlobPart], { type: 'image/jpeg' }))
        const c = cv.current
        if (c) {
          if (c.width !== w || c.height !== h) {
            c.width = w; c.height = h
            const b = box.current!.getBoundingClientRect()
            g.layout(b.width, b.height, w, h)
          }
          c.getContext('2d')!.drawImage(bmp, 0, 0)
          setGot(true)
        }
        bmp.close()
      } catch { /* битый кадр — следующий будет */ }
      busy = false
      link.json({ t: 'screen-ack' })
      frames++; bytes += d.length
      const now = performance.now()
      if (now - at >= 1000) { setStat({ fps: Math.round(frames * 1000 / (now - at)), kb: Math.round(bytes / 1024), w, h }); frames = 0; bytes = 0; at = now }
    })
    const ro = new ResizeObserver(() => {
      const b = box.current!.getBoundingClientRect()
      const c = cv.current!
      g.layout(b.width, b.height, c.width || 16, c.height || 9)
    })
    ro.observe(box.current!)
    return () => { offInfo(); offDeny(); offBin(); ro.disconnect() }
  }, [])

  const rel = (e: PointerEvent): [number, number] => { const r = box.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
  const tool = (icon: IconName, label: string, on: boolean, f: () => void) => (
    <button type="button" class={'scr-tool' + (on ? ' on' : '')} aria-label={label} aria-pressed={on} onClick={() => { haptic('tick'); f() }}>
      <DotIcon name={icon} size={18} />
    </button>
  )
  const qi = QUALITY.findIndex((x) => x.id === quality)

  return (
    <div class="scr-view">
      <div ref={box} class="scr-box" role="application" aria-label="Экран ПК"
        onPointerDown={(e) => { try { box.current!.setPointerCapture(e.pointerId) } catch { /* синтетическое событие */ } const [x, y] = rel(e); g.down(e.pointerId, x, y) }}
        onPointerMove={(e) => { const [x, y] = rel(e); g.move(e.pointerId, x, y) }}
        onPointerUp={(e) => g.up(e.pointerId)}
        onPointerCancel={(e) => g.cancel(e.pointerId)}
        onContextMenu={(e) => e.preventDefault()}>
        <canvas ref={cv} class="scr-cv" width={16} height={9} />
        {!got && !denied && <div class="scr-wait"><DotIcon name="display" size={28} /><span>{online ? 'Получаю экран ПК…' : 'Нет связи с ПК'}</span></div>}
        {denied && <div class="scr-wait"><DotIcon name="lock" size={28} /><span>Показ экрана запрещён на ПК<br /><small class="muted">Дашборд → Устройства → права</small></span></div>}
        {stat.w > 0 && <span class="scr-stat num">{stat.fps} к/с · {stat.kb} КБ/с</span>}
      </div>
      <div class="scr-bar">
        {tool('keyboard', 'Клавиатура', kbd, () => setKbd(!kbd))}
        {tool('search', 'Вписать целиком', false, () => g.fit())}
        {mons.length > 1 && tool('display', `Монитор ${mon + 1} из ${mons.length}`, false, () => setMon((mon + 1) % mons.length))}
        <button type="button" class="scr-q" onClick={() => { const n = QUALITY[(qi + 1) % QUALITY.length].id; setQuality(n); try { localStorage.setItem('dotlink.screenQ', n) } catch { /* приватный режим */ } }}>
          {QUALITY[qi].label}
        </button>
        {mons.length > 1 && <span class="scr-mon num">{mon + 1}/{mons.length}</span>}
      </div>
      {kbd && <Keyboard />}
    </div>
  )
}
