// Вкладка «Телефон» на ПК: экран телефона в окне (как iPhone Mirroring) с управлением мышью
// и клавиатурой ПК, кнопки Android, мышь ПК на телефоне (как Universal Control), ссылки и текст
// в один клик, уведомления телефона.
import { useEffect, useRef, useState } from 'preact/hooks'
import { Button, Card, DotIcon, StatusDot, toast, type IconName } from '../ui'
import type { Link } from '../lib/link'
import { MirrorDecoder, mirrorSupported } from '../lib/mirrordec'
import { timeAgo } from '../lib/format'

type Cmd = (t: string, rest?: Record<string, unknown>) => void

const NAV: { a: string; icon: IconName; label: string }[] = [
  { a: 'back', icon: 'left', label: 'Назад' },
  { a: 'home', icon: 'home', label: 'Домой' },
  { a: 'recents', icon: 'recents', label: 'Недавние' },
  { a: 'notifications', icon: 'bell', label: 'Шторка' },
  { a: 'screenshot', icon: 'camera', label: 'Скриншот' },
  { a: 'lock', icon: 'lock', label: 'Заблокировать' },
]

const KEYS: Record<string, string> = { Backspace: 'backspace', Delete: 'delete', Enter: 'enter', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home-line', End: 'end' }

/** Экран телефона: картинка + мышь и клавиатура ПК превращаются в касания, жесты и ввод. */
function Screen({ link, cmd, device, codec }: { link: Link; cmd: Cmd; device: string; codec: 'avc' | 'vp8' }) {
  const cv = useRef<HTMLCanvasElement>(null)
  const [fps, setFps] = useState(0)
  useEffect(() => {
    const dec = new MirrorDecoder(cv.current!, codec, () => cmd('mirror-key', { device }))
    const off = link.on('bin', (d: Uint8Array) => { if (d[0] === 0x0a) dec.push(d) })
    cmd('mirror-key', { device })
    const t = setInterval(() => setFps(dec.fps), 1000)
    return () => { off(); dec.close(); clearInterval(t) }
  }, [device, codec])

  // мышь: короткий клик — касание, долгий — долгое касание, с движением — свайп по пути
  const g = useRef<{ x: number; y: number; t: number; pts: number[] } | null>(null)
  const pos = (e: PointerEvent) => {
    const r = cv.current!.getBoundingClientRect()
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))]
  }
  const send = (a: string, rest: Record<string, unknown> = {}) => cmd('phone-ctl', { device, a, ...rest })
  const wheel = useRef({ dy: 0, dx: 0, x: 0.5, y: 0.5, timer: 0 })
  const text = useRef({ s: '', timer: 0 })

  return (
    <div class="mirror-wrap">
      <canvas ref={cv} class="mirror-cv" tabIndex={0} aria-label="Экран телефона"
        onPointerDown={(e) => {
          if (e.button === 2) { send('back'); return }
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          const [x, y] = pos(e)
          g.current = { x, y, t: performance.now(), pts: [x, y] }
        }}
        onPointerMove={(e) => {
          const s = g.current
          if (!s) return
          const [x, y] = pos(e)
          const n = s.pts.length
          if (Math.hypot(x - s.pts[n - 2], y - s.pts[n - 1]) > 0.01) s.pts.push(x, y)
        }}
        onPointerUp={(e) => {
          const s = g.current
          g.current = null
          if (!s) return
          const [x, y] = pos(e)
          const ms = Math.round(performance.now() - s.t)
          if (Math.hypot(x - s.x, y - s.y) < 0.012) {
            send(ms > 450 ? 'long' : 'tap', { x: s.x, y: s.y, ms })
            return
          }
          s.pts.push(x, y)
          // путь прореживаем до 24 точек — жест Android короче и надёжнее
          const step = Math.max(1, Math.ceil(s.pts.length / 2 / 24))
          const path: number[] = []
          for (let i = 0; i < s.pts.length; i += 2 * step) path.push(+s.pts[i].toFixed(4), +s.pts[i + 1].toFixed(4))
          path.push(+x.toFixed(4), +y.toFixed(4))
          send('path', { path, ms: Math.max(80, Math.min(3000, ms)) })
        }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          e.preventDefault()
          const w = wheel.current
          const r = cv.current!.getBoundingClientRect()
          w.x = (e.clientX - r.left) / r.width; w.y = (e.clientY - r.top) / r.height
          w.dy += -e.deltaY / 900; w.dx += -e.deltaX / 900
          if (!w.timer) w.timer = window.setTimeout(() => {
            send('scroll', { x: w.x, y: w.y, x2: Math.max(-0.45, Math.min(0.45, w.dx)), y2: Math.max(-0.45, Math.min(0.45, w.dy)) })
            w.dx = w.dy = 0; w.timer = 0
          }, 90)
        }}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key.toLowerCase() === 'v') {
            e.preventDefault()
            void navigator.clipboard.readText().then((t) => t && send('text', { text: t }), () => toast('Буфер ПК недоступен', 'err'))
            return
          }
          if (e.key === 'Escape') { e.preventDefault(); send('back'); return }
          const k = KEYS[e.key]
          if (k) { e.preventDefault(); send('key', { key: k }); return }
          if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault()
            // набор склеиваем: одна команда на слово, а не на букву
            const tx = text.current
            tx.s += e.key
            clearTimeout(tx.timer)
            tx.timer = window.setTimeout(() => { send('text', { text: tx.s }); tx.s = '' }, 60)
          }
        }} />
      <span class="mirror-fps muted small num">{fps} к/с</span>
    </div>
  )
}

export function PhoneTab({ link, cmd }: { link: Link; cmd: Cmd }) {
  const devices = (link.get<any[]>('devices').value || []).filter((d) => d.online)
  const mirror = link.get<any>('mirror').value
  const uc = link.get<any>('uc').value
  const [dev, setDev] = useState<string>('')
  const [handoff, setHandoff] = useState('')
  const device = devices.find((d) => d.id === dev)?.id || devices[devices.length - 1]?.id || ''
  const shown = mirror && mirror.device === device
  const name = devices.find((d) => d.id === device)?.name || 'Телефон'

  if (!devices.length) return <Card label="Телефон" icon="phone" span="all"><p class="muted" style={{ margin: 0 }}>Нет подключённых телефонов. Отсканируйте QR слева.</p></Card>

  return <>
    <Card label={`Экран · ${name}`} icon="phone" span={2} class="mirror-card"
      aside={devices.length > 1 ? <select class="input sm" value={device} onChange={(e) => setDev((e.target as HTMLSelectElement).value)}>{devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select> : undefined}>
      {shown && mirrorSupported() ? <Screen link={link} cmd={cmd} device={device} codec={mirror.codec === 'vp8' ? 'vp8' : 'avc'} /> : (
        <div class="mirror-empty">
          <DotIcon name="phone" size={40} />
          <p class="muted small">{mirrorSupported() ? 'Экран телефона появится здесь. На телефоне нужно подтвердить трансляцию — один раз за сеанс.' : 'Этот браузер не умеет декодировать видео (WebCodecs).'}</p>
          <Button variant="primary" icon="play" onClick={() => cmd('mirror-start', { device, max: 1280, bitrate: 6_000_000 })}>Показать экран телефона</Button>
        </div>
      )}
      <div class="row wrap mirror-nav">
        {NAV.map((n) => <Button key={n.a} size="sm" variant="ghost" icon={n.icon} onClick={() => cmd('phone-ctl', { device, a: n.a })}>{n.label}</Button>)}
        {shown && <Button size="sm" variant="danger" icon="close" onClick={() => cmd('mirror-stop', { device })}>Остановить</Button>}
      </div>
      {shown && <p class="muted small" style={{ margin: 0 }}>Клик — касание, удержание — долгое касание, перетаскивание — свайп, колесо — прокрутка, правая кнопка или Esc — «Назад». Печатайте прямо на клавиатуре ПК; Ctrl+V вставит буфер ПК.</p>}
    </Card>

    <Card label="Мышь ПК на телефоне" icon="mouse" span={2}>
      <div class="row"><StatusDot state={uc?.on ? 'accent' : 'off'} live={!!uc?.on} /><span class="grow">{uc?.on ? `Курсор на «${uc.name}»` : 'Курсор и клавиатура ПК управляют телефоном, как вторым экраном'}</span></div>
      <div class="row wrap">
        {uc?.on ? <Button icon="close" onClick={() => cmd('uc-stop')}>Вернуть на ПК</Button> : <Button variant="primary" icon="right" onClick={() => cmd('uc-start', { device })}>Перевести на телефон</Button>}
      </div>
      <p class="muted small" style={{ margin: 0 }}>Или уведите курсор за край экрана (настраивается в «Настройках») либо нажмите Ctrl+Alt+→. Вернуться — Esc или Ctrl+Alt+←. На телефоне должна быть включена служба «DotLink: управление с ПК».</p>
    </Card>

    <Card label="Передать на телефон" icon="send" span={2}>
      <textarea class="input" rows={2} placeholder="Ссылка или текст" value={handoff} onInput={(e) => setHandoff((e.target as HTMLTextAreaElement).value)} />
      <div class="row wrap">
        <Button variant="primary" icon="link" disabled={!/^https?:\/\//i.test(handoff.trim())} onClick={() => { cmd('phone-open-url', { device, url: handoff.trim() }); setHandoff('') }}>Открыть на телефоне</Button>
        <Button icon="copy" disabled={!handoff.trim()} onClick={() => { cmd('phone-text', { device, text: handoff }); setHandoff('') }}>В буфер телефона</Button>
      </div>
    </Card>

    <Notifications cmd={cmd} link={link} />
  </>
}

export function Notifications({ link, cmd }: { link: Link; cmd: Cmd }) {
  const list = link.get<any[]>('notifs').value || []
  return (
    <Card label="Уведомления телефона" icon="bell" span={2} aside={list.length ? <Button size="sm" variant="ghost" icon="trash" onClick={() => cmd('notifs-clear')}>Очистить</Button> : undefined}>
      {list.length === 0 && <p class="muted small" style={{ margin: 0 }}>Пока тихо. Уведомления появятся, если на телефоне включён доступ «DotLink: уведомления на ПК».</p>}
      <div class="notif-list">
        {list.slice(0, 12).map((n, i) => (
          <div key={i} class="notif">
            <b class="ellipsis">{n.title || n.app}</b>
            <span class="muted small">{n.app} · {n.device} · {timeAgo(n.at)}</span>
            {n.text && <p class="small">{n.text}</p>}
          </div>
        ))}
      </div>
    </Card>
  )
}
