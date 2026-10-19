import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Button, Card, Chip, DotDisplay, DotField, DotIcon, QrDots, Sheet, Segmented, StatusDot, Tile, Toasts, Toggle, toast, ICON_NAMES, type IconName } from '../ui'
import { Link } from '../lib/link'
import { LinkCtx } from '../lib/linkctx'
import { fileToPayload, formatBytes, pickFiles, timeAgo } from '../lib/format'
import type { Payload } from '../lib/qrstream'
import { MediaCard, SysCards, VolumeCard, WindowCard, useTicker, TimerCard } from '../remote/Home'
import { QrReceiveView, QrSendView } from '../features/QrStream'
import { Notifications, PhoneTab } from './Phone'
import './dashboard.css'

const link = new Link()
const token = (() => {
  const h = new URLSearchParams(location.hash.slice(1)).get('admin')
  if (h) { sessionStorage.setItem('dotlink.admin', h); history.replaceState(null, '', location.pathname) }
  return h || sessionStorage.getItem('dotlink.admin') || ''
})()

link.on('ok', (m) => { if (m.msg) toast(m.msg) })
link.on('error', (m) => { if (m.msg) toast(m.msg, 'err') })

function cmd(t: string, rest: Record<string, unknown> = {}) { link.json({ t, ...rest }) }

/** Загрузка файла в «исходящие» ядра — оттуда он уходит на телефон или в «Загрузки». */
async function toOutbox(name: string, body: Blob): Promise<string> {
  const r = await fetch(`/api/admin/outbox?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'x-dotlink-admin': token }, body })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j.id
}

// ───────── боковая панель: QR, PIN, адреса ─────────

const KIND_ICON: Record<string, IconName> = { wifi: 'wifi', lan: 'link', usb: 'usb', hotspot: 'hotspot', other: 'link' }
const KIND_LABEL: Record<string, string> = { wifi: 'Wi-Fi', lan: 'Кабель', usb: 'USB-модем', hotspot: 'Хотспот', other: 'Сеть' }

/** Дописать к QR ссылку или текст: телефон подключится и сразу откроет/скопирует их. */
export function withContext(url: string, go: string): string {
  const v = go.trim()
  return v ? `${url}&go=${encodeURIComponent(v.slice(0, 600))}` : url
}

function Pairing() {
  const [go, setGo] = useState('')
  const p = link.get<any>('pairing').value
  const net = link.get<any>('net').value
  const devices = link.get<any[]>('devices').value || []
  useTicker(1000)
  const left = p ? Math.max(0, Math.round((p.expires - Date.now()) / 1000)) : 0
  const online = devices.filter((d) => d.online).length
  return (
    <aside class="side">
      <DotField mode="hero" />
      <div class="side-in">
        <div class="side-top" data-dots-avoid>
          <DotDisplay text="DOTLINK" pitch={4} />
          <h1 class="title">{link.get<any>('pc').value?.name || 'ПК'}</h1>
          <div class="row">
            <StatusDot state={link.status.value === 'online' ? 'ok' : 'err'} live={link.status.value === 'online'} />
            <span class="muted">{link.status.value !== 'online' ? 'Ядро не отвечает' : online ? `Подключено устройств: ${online}` : 'Ждёт телефон'}</span>
          </div>
        </div>
        <div class="pair-card" data-dots-avoid>
          {p ? <QrDots text={withContext(p.url, go)} size={208} /> : <div class="qr-ph" />}
          <div class="pair-meta">
            <span class="label">PIN</span>
            <DotDisplay text={p ? `${p.pin.slice(0, 3)} ${p.pin.slice(3)}` : '--- ---'} pitch={5} />
            <span class="muted small num">Обновится через {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
            <Button size="sm" variant="ghost" icon="restart" onClick={() => cmd('pair-refresh')}>Новый код</Button>
          </div>
          <p class="small muted pair-how">Наведите камеру телефона на QR — откроется пульт. В приложении DotLink для Android можно ввести PIN.</p>
          <label class="pair-go">
            <span class="label">Передать вместе с QR</span>
            <input class="input" placeholder="Ссылка или текст — откроется на телефоне" value={go} onInput={(e) => setGo((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <div class="addrs" data-dots-avoid>
          <span class="label">Адреса ПК</span>
          {(net?.addrs || []).length === 0 && <span class="muted small">Нет сети. Подключите Wi-Fi, хотспот телефона или USB-модем.</span>}
          {(net?.addrs || []).slice(0, 5).map((a: any) => (
            <div key={a.ip} class="addr"><DotIcon name={KIND_ICON[a.kind] || 'link'} size={14} /><b class="num">{a.ip}:{net.port}</b><span class="muted small ellipsis">{KIND_LABEL[a.kind]} · {a.iface}</span></div>
          ))}
        </div>
        {net?.public && (
          <div class="warn" data-dots-avoid>
            <b>Сеть отмечена как общественная</b>
            <span class="small">Брандмауэр Windows может не пустить телефон. Разрешите DotLink — потребуется подтверждение администратора.</span>
            <Button size="sm" variant="primary" icon="shield" onClick={() => cmd('firewall-fix')}>Разрешить в брандмауэре</Button>
          </div>
        )}
      </div>
    </aside>
  )
}

// ───────── устройства ─────────

const PERMS: [string, string][] = [['input', 'Мышь и клавиатура'], ['media', 'Звук и музыка'], ['power', 'Питание'], ['macros', 'Макросы'], ['clipboard', 'Буфер обмена'], ['files', 'Файлы']]

const VIA: Record<string, string> = { lan: 'Wi-Fi', relay: 'Интернет', bt: 'Bluetooth' }

function Devices({ compact }: { compact?: boolean }) {
  const list = link.get<any[]>('devices').value || []
  const [open, setOpen] = useState<string | null>(null)
  return (
    <Card label="Устройства" icon="phone" span={2} aside={<span class="muted small">{list.length}</span>}>
      {list.length === 0 && <p class="muted" style={{ margin: 0 }}>Пока ни одного. Отсканируйте QR слева камерой телефона.</p>}
      {list.map((d) => (
        <div key={d.id} class={'dev' + (open === d.id ? ' open' : '')}>
          <button type="button" class="dev-row" onClick={() => setOpen(open === d.id ? null : d.id)}>
            <DotIcon name="phone" size={18} />
            <span class="grow"><b>{d.name}</b><small class="muted">{d.online ? `${VIA[d.via] || 'в сети'}${d.p2p ? ' · напрямую' : ''} · ${d.addr}${d.rtt ? ` · ${d.rtt} мс` : ''}` : `был ${timeAgo(d.last_seen)}`}</small></span>
            <StatusDot state={d.online ? 'ok' : 'off'} live={d.online} />
          </button>
          {open === d.id && !compact && (
            <div class="dev-body">
              <div class="perm-grid">
                {PERMS.map(([k, label]) => <Toggle key={k} checked={!!d.perms[k]} label={label} onChange={(v) => cmd('device-perms', { id: d.id, perms: { ...d.perms, [k]: v } })} />)}
              </div>
              <div class="row">
                <Button size="sm" icon="edit" onClick={() => { const n = prompt('Имя устройства', d.name); if (n) cmd('device-rename', { id: d.id, name: n }) }}>Переименовать</Button>
                <Button size="sm" variant="danger" icon="trash" onClick={() => { if (confirm(`Отключить «${d.name}»? Ему понадобится новое сопряжение.`)) cmd('device-remove', { id: d.id }) }}>Отключить</Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </Card>
  )
}

// ───────── макросы ─────────

const KINDS = [
  { value: 'keys', label: 'Клавиши', hint: 'ctrl+shift+esc · несколько шагов: win+r; wait 300; text: notepad; enter' },
  { value: 'app', label: 'Программа', hint: 'notepad.exe, C:\\Program Files\\…\\app.exe или путь к файлу' },
  { value: 'url', label: 'Ссылка', hint: 'https://… или ms-settings:' },
  { value: 'shell', label: 'PowerShell', hint: 'Команда PowerShell, выполняется скрыто' },
  { value: 'text', label: 'Текст', hint: 'Напечатать этот текст в активном окне' },
] as const
const PICK_ICONS: IconName[] = ['bolt', 'apps', 'terminal', 'files', 'desktop', 'scan', 'media', 'cpu', 'link', 'search', 'camera', 'display', 'window', 'send', 'edit', 'timer', 'lock', 'eye', 'shield', 'copy']

function Macros() {
  const list = link.get<any[]>('macros').value || []
  const [edit, setEdit] = useState<any | null>(null)
  const save = (next: any[]) => cmd('macros-save', { macros: next })
  const iconOf = (n: string): IconName => ((ICON_NAMES as string[]).includes(n) ? (n as IconName) : 'bolt')
  return (
    <Card label="Быстрые действия на телефоне" icon="bolt" span="all" aside={<Button size="sm" icon="plus" onClick={() => setEdit({ id: '', name: '', icon: 'bolt', kind: 'keys', value: '' })}>Добавить</Button>}>
      <div class="grid macro-grid-d">
        {list.map((m) => <Tile key={m.id} icon={iconOf(m.icon)} label={m.name} sub={m.value} onClick={() => setEdit({ ...m })} />)}
      </div>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Макрос' : 'Новый макрос'}>
        {edit && (
          <div class="stack">
            <label class="field"><span class="label">Название</span><input class="input" value={edit.name} onInput={(e) => setEdit({ ...edit, name: (e.target as HTMLInputElement).value })} /></label>
            <div class="field"><span class="label">Значок</span>
              <div class="icon-pick">{PICK_ICONS.map((n) => <button key={n} type="button" class={edit.icon === n ? 'on' : ''} onClick={() => setEdit({ ...edit, icon: n })} aria-label={n}><DotIcon name={n} size={18} /></button>)}</div>
            </div>
            <div class="field"><span class="label">Что делает</span><Segmented value={edit.kind} onChange={(k) => setEdit({ ...edit, kind: k })} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} /></div>
            <label class="field"><span class="label">{KINDS.find((k) => k.value === edit.kind)?.hint}</span>
              <textarea class="input" rows={3} value={edit.value} onInput={(e) => setEdit({ ...edit, value: (e.target as HTMLTextAreaElement).value })} />
            </label>
            <div class="row wrap">
              <Button variant="primary" icon="check" disabled={!edit.name.trim() || !edit.value.trim()} onClick={() => { save(edit.id ? list.map((m) => (m.id === edit.id ? edit : m)) : [...list, edit]); setEdit(null) }}>Сохранить</Button>
              {edit.id && <Button icon="play" onClick={() => cmd('macro-run', { id: edit.id })}>Проверить</Button>}
              {edit.id && <Button variant="danger" icon="trash" onClick={() => { save(list.filter((m) => m.id !== edit.id)); setEdit(null) }}>Удалить</Button>}
            </div>
          </div>
        )}
      </Sheet>
    </Card>
  )
}

// ───────── файлы ─────────

function Files() {
  const received = link.get<any[]>('received').value || []
  const devices = (link.get<any[]>('devices').value || []).filter((d) => d.online)
  const [send, setSend] = useState<Payload | null>(null)
  const [recv, setRecv] = useState(false)
  const [busy, setBusy] = useState(false)
  const toPhone = async (dev: string) => {
    const files = await pickFiles()
    if (!files.length) return
    setBusy(true)
    try { for (const f of files) cmd('offer-file', { device: dev, file: await toOutbox(f.name, f) }) }
    catch (e) { toast('Не удалось: ' + (e as Error).message, 'err') }
    finally { setBusy(false) }
  }
  return <>
    <Card label="На телефон" icon="send" span={2}>
      {devices.length === 0 ? <p class="muted" style={{ margin: 0 }}>Нет подключённых телефонов.</p> :
        devices.map((d) => <div key={d.id} class="row"><DotIcon name="phone" size={16} /><b class="grow">{d.name}</b><Button size="sm" icon="upload" disabled={busy} onClick={() => void toPhone(d.id)}>Отправить файлы</Button></div>)}
      <p class="muted small" style={{ margin: 0 }}>С телефона файлы приходят в папку «Загрузки\DotLink».</p>
    </Card>
    <Card label="QR-поток · без сети" icon="qr" span={2}>
      <p class="muted small" style={{ margin: 0 }}>Файл передаётся сеткой сменяющихся QR-кодов: с этого экрана на камеру телефона или с экрана телефона на веб-камеру ПК. Сеть не нужна.</p>
      <div class="row wrap">
        <Button variant="primary" icon="qr" onClick={async () => { const [f] = await pickFiles(false); if (f) setSend(await fileToPayload(f)) }}>Показать файл QR-кодами</Button>
        <Button icon="camera" onClick={() => setRecv(true)}>Принять веб-камерой</Button>
      </div>
    </Card>
    <Card label="Принятые файлы" icon="download" span="all" aside={<Button size="sm" variant="ghost" icon="files" onClick={() => cmd('open-folder')}>Открыть папку</Button>}>
      {received.length === 0 ? <p class="muted" style={{ margin: 0 }}>Пока пусто.</p> : (
        <div class="recv-list">{received.map((r, i) => (
          <div key={i} class="recv"><DotIcon name="files" size={16} /><b class="ellipsis grow">{r.name}</b><span class="muted small">{formatBytes(r.size)} · {r.from} · {timeAgo(r.at)}</span></div>
        ))}</div>
      )}
    </Card>
    {send && <QrSendView payload={send} onClose={() => setSend(null)} />}
    {recv && <QrReceiveView facing="user" onClose={() => setRecv(false)} onFile={async (p) => {
      try { cmd('save-qr-file', { file: await toOutbox(p.name, new Blob([p.bytes as BlobPart], { type: p.type })) }); setRecv(false) }
      catch (e) { toast('Не удалось сохранить: ' + (e as Error).message, 'err') }
    }} />}
  </>
}

// ───────── настройки ─────────

function Settings() {
  const s = link.get<any>('settings').value
  const pc = link.get<any>('pc').value
  if (!s) return null
  const set = (k: string, v: unknown) => cmd('settings-save', { settings: { ...s, [k]: v } })
  return <>
    <Card label="Запуск и поведение" icon="settings" span={2}>
      <Toggle checked={s.autostart} onChange={(v) => set('autostart', v)} label="Запускать вместе с Windows" hint="DotLink стартует свёрнутым в трей" />
      <Toggle checked={s.clip_sync} onChange={(v) => set('clip_sync', v)} label="Буфер обмена → телефон" hint="Скопированный на ПК текст сразу виден на телефоне" />
      <Toggle checked={s.notify} onChange={(v) => set('notify', v)} label="Уведомления" hint="О новых устройствах и принятых файлах" />
      <Toggle checked={s.phone_notifications} onChange={(v) => set('phone_notifications', v)} label="Уведомления телефона в Windows" hint="Сообщения и звонки с телефона — всплывающими уведомлениями" />
      <div class="field"><span class="label">Мышь уходит на телефон через край экрана</span>
        <Segmented value={s.uc_edge} onChange={(v) => set('uc_edge', v)} options={[{ value: 'left', label: 'Слева' }, { value: 'right', label: 'Справа' }, { value: 'top', label: 'Сверху' }, { value: 'bottom', label: 'Снизу' }, { value: 'off', label: 'Нет' }]} />
      </div>
    </Card>
    <Connectivity s={s} set={set} />
    <Card label="Компьютер" icon="desktop" span={2}>
      <label class="field"><span class="label">Имя в списке на телефоне</span>
        <input class="input" value={pc?.name || ''} onChange={(e) => cmd('pc-rename', { name: (e.target as HTMLInputElement).value })} />
      </label>
      <dl class="kv">
        <dt>Порт</dt><dd class="num">{s.port} (TCP), 47801 (UDP, поиск)</dd>
        <dt>Версия</dt><dd>{pc?.version} · {pc?.platform}</dd>
      </dl>
      <p class="muted small" style={{ margin: 0 }}>Чтобы управлять окнами, запущенными от администратора, запустите DotLink от имени администратора: Windows не даёт обычным программам нажимать в таких окнах.</p>
    </Card>
  </>
}

/** STUN/TURN построчно: `stun:host:port` или `turn:логин:пароль@host:port`. */
export function parseIce(text: string): { urls: string[]; username?: string; credential?: string }[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(turns?):([^:@]+):([^@]+)@(.+)$/)
    return m ? { urls: [`${m[1]}:${m[4]}`], username: m[2], credential: m[3] } : { urls: [l] }
  })
}
export function iceText(list: { urls: string[]; username?: string; credential?: string }[]): string {
  return list.flatMap((s) => s.urls.map((u) => (s.username ? u.replace(/^(turns?):/, `$1:${s.username}:${s.credential}@`) : u))).join('\n')
}

const RELAY_STATE: Record<string, [string, 'ok' | 'warn' | 'err' | 'off']> = {
  online: ['Комната открыта', 'ok'], connecting: ['Подключение', 'warn'], error: ['Нет связи', 'err'], off: ['Выключен', 'off'],
}

function Connectivity({ s, set }: { s: any; set: (k: string, v: unknown) => void }) {
  const relay = link.get<any>('relay').value
  const bt = link.get<any>('bt').value
  const [st, label] = [RELAY_STATE[relay?.state || 'off'][1], RELAY_STATE[relay?.state || 'off'][0]]
  return (
    <Card label="Связь из любой сети" icon="link" span={2}>
      <label class="field"><span class="label">Ретранслятор · {label}{relay?.msg ? ` · ${relay.msg}` : ''}</span>
        <div class="row"><StatusDot state={st} live={st === 'ok'} />
          <input class="input grow" placeholder="wss://relay.example.com" defaultValue={s.relay_url} onChange={(e) => set('relay_url', (e.target as HTMLInputElement).value.trim())} />
        </div>
      </label>
      <p class="muted small" style={{ margin: 0 }}>Телефон в мобильном интернете или другой сети найдёт ПК через ретранслятор, а затем по возможности соединится напрямую (WebRTC). Свой ретранслятор — docs/RELAY.md; данные идут сквозным шифром.</p>
      <label class="field"><span class="label">STUN / TURN для прямого канала</span>
        <textarea class="input" rows={3} defaultValue={iceText(s.ice_servers || [])} onChange={(e) => set('ice_servers', parseIce((e.target as HTMLTextAreaElement).value))} />
      </label>
      <Toggle checked={s.bluetooth} onChange={(v) => set('bluetooth', v)} label="Bluetooth" hint={bt?.state === 'online' ? `Ждёт телефон · ${bt.addr || 'адаптер найден'}` : bt?.msg || 'Связь без Wi-Fi и интернета (нужен Bluetooth на ПК)'} />
    </Card>
  )
}

// ───────── каркас ─────────

type Tab = 'overview' | 'phone' | 'devices' | 'macros' | 'files' | 'settings'
const TABS: { id: Tab; icon: IconName; label: string }[] = [
  { id: 'overview', icon: 'home', label: 'Обзор' }, { id: 'phone', icon: 'phone', label: 'Телефон' }, { id: 'devices', icon: 'link', label: 'Устройства' },
  { id: 'macros', icon: 'bolt', label: 'Макросы' }, { id: 'files', icon: 'files', label: 'Файлы' }, { id: 'settings', icon: 'settings', label: 'Настройки' },
]

function App() {
  const [tab, setTab] = useState<Tab>('overview')
  useEffect(() => {
    if (!token) return
    // если ядро перезапустится, Link переподключится сам
    void link.connect({ kind: 'admin', token }, [location.host]).catch(() => {})
    let known = -1
    const off = link.on('*', (m) => {
      if (m.t === 'state' && m.k === 'devices') {
        const n = m.v.length
        if (known >= 0 && n > known) toast(`Подключено новое устройство: ${m.v[n - 1].name}`)
        known = n
      }
      if (m.t === 'snapshot') known = (m.v.devices || []).length
      if (m.t === 'state' && m.k === 'received' && m.v[0] && Date.now() - m.v[0].at < 5000) toast(`Принят файл «${m.v[0].name}»`)
    })
    return off
  }, [])

  if (!token) return (
    <div class="no-token"><DotDisplay text="DOTLINK" pitch={6} /><p class="muted">Откройте дашборд из приложения DotLink в трее — он защищён одноразовым токеном.</p></div>
  )

  return (
    <LinkCtx.Provider value={link}>
      <div class="dash">
        <Pairing />
        <main class="dash-main">
          <nav class="dash-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}><DotIcon name={t.icon} size={15} />{t.label}</button>
            ))}
            <span class="grow" />
            <Chip state={link.status.value === 'online' ? 'ok' : 'err'}>{link.status.value === 'online' ? 'Ядро работает' : 'Нет связи с ядром'}</Chip>
          </nav>
          <div class="grid dash-grid">
            {tab === 'overview' && <>
              <TimerCard i={0} />
              <Devices compact />
              <SysCards i={1} />
              <MediaCard i={3} />
              <VolumeCard i={4} />
              <WindowCard i={5} />
              <Notifications link={link} cmd={cmd} />
            </>}
            {tab === 'phone' && <PhoneTab link={link} cmd={cmd} />}
            {tab === 'devices' && <Devices />}
            {tab === 'macros' && <Macros />}
            {tab === 'files' && <Files />}
            {tab === 'settings' && <Settings />}
          </div>
        </main>
        <Toasts />
      </div>
    </LinkCtx.Provider>
  )
}

render(<App />, document.getElementById('app')!)
