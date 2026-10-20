import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Chip, DotIcon, IconButton, TabBar, Toasts, toast } from '../ui'
import { isNative, wakePc } from './native'
import { Palette } from './Palette'
import { AuthError, loadSaved, pairAuth, parsePairUrl } from '../lib/link'
import { applyContext } from './continuity'
import './phonectl'
import { Connect, explain } from './Connect'
import { Files } from './Files'
import { Home } from './Board'
import { PadTab } from './Pad'
import { Screen } from './Screen'
import { System } from './System'
import { link, servedFromPc } from './state'
import { LinkCtx } from '../lib/linkctx'
import './app.css'

type Tab = 'home' | 'pad' | 'screen' | 'files' | 'system'
const TABS = [
  { id: 'home' as const, icon: 'home' as const, label: 'Пульт' },
  { id: 'pad' as const, icon: 'pad' as const, label: 'Тачпад' },
  { id: 'screen' as const, icon: 'display' as const, label: 'Экран' },
  { id: 'files' as const, icon: 'files' as const, label: 'Файлы' },
  { id: 'system' as const, icon: 'power' as const, label: 'Система' },
]

function Status() {
  const st = link.status.value
  if (st === 'online') return <Chip state={link.rtt.value > 60 ? 'warn' : 'ok'} live>{link.rtt.value} мс</Chip>
  if (st === 'connecting') return <Chip state="warn" live>Подключение</Chip>
  const pc = link.savedPc
  const canWake = isNative() && !!pc?.routes?.wol?.length
  return (
    <div class="row">
      {canWake && <button type="button" class="chip" onClick={async () => {
        if (await wakePc(pc!)) { toast('Бужу ПК — обычно 10–40 секунд'); setTimeout(() => link.wake(), 8000) } else toast('Не получилось отправить сигнал', 'err')
      }}><DotIcon name="power" size={12} />Включить ПК</button>}
      <button type="button" class="chip" onClick={() => link.wake()}><i class="sdot err" />Нет связи · повторить</button>
    </div>
  )
}

function App() {
  const [view, setView] = useState<'boot' | 'connect' | 'main'>('boot')
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem('dotlink.tab') as Tab) || 'home')
  const [err, setErr] = useState<string | null>(null)
  const [pal, setPal] = useState(false)

  useEffect(() => {
    const pair = parsePairUrl(location.href)
    if (pair) {
      // открыто системной камерой по QR с экрана ПК
      history.replaceState(null, '', location.pathname)
      const { auth, hosts } = pairAuth(pair, servedFromPc ? [location.host] : [])
      link.connect(auth, hosts)
        .then(() => { setView('main'); if (pair.go) void applyContext(pair.go) }, (e) => { setErr(explain(e)); setView('connect') })
      return
    }
    const cur = loadSaved()[0]
    if (!cur) { setView('connect'); return }
    setView('main')
    link.connect({ kind: 'device', saved: cur }, [...new Set([...(servedFromPc ? [location.host] : []), ...cur.hosts])])
      .catch((e) => { if (e instanceof AuthError) { setErr(explain(e)); setView('connect') } })
  }, [])

  // вернулись в приложение / ожила сеть — переподключаемся сразу
  useEffect(() => {
    const wake = () => { if (document.visibilityState === 'visible') link.wake() }
    document.addEventListener('visibilitychange', wake)
    addEventListener('online', wake)
    addEventListener('focus', wake)
    return () => { document.removeEventListener('visibilitychange', wake); removeEventListener('online', wake); removeEventListener('focus', wake) }
  }, [])

  const e = link.error.value
  useEffect(() => {
    if (view === 'main' && (e === 'revoked' || e === 'unknown-device')) { setErr(explain(new AuthError(e))); setView('connect') }
  }, [e, view])
  useEffect(() => { sessionStorage.setItem('dotlink.tab', tab) }, [tab])

  if (view === 'boot') return <div class="r-boot" />
  if (view === 'connect') return <><Connect error={err} onDone={() => { setErr(null); setView('main') }} /><Toasts /></>

  return (
    <LinkCtx.Provider value={link}>
    <div class={'r-app tab-' + tab}>
      <header class="r-head">
        <div class="grow r-title">
          <span class="label">DotLink</span>
          <b class="ellipsis">{link.pcName.value || 'ПК'}</b>
        </div>
        <IconButton icon="search" label="Поиск на ПК" variant="flat" onClick={() => setPal(true)} />
        <Status />
      </header>
      <Palette open={pal} onClose={() => setPal(false)} />
      <main class="r-main">
        {tab === 'home' && <Home />}
        {tab === 'pad' && <PadTab />}
        {tab === 'screen' && <Screen />}
        {tab === 'files' && <Files />}
        {tab === 'system' && <System onSwitch={() => { link.disconnect(); setView('connect') }} />}
      </main>
      <div class="r-tabs"><TabBar items={TABS} value={tab} onChange={setTab} /></div>
      <Toasts />
    </div>
    </LinkCtx.Provider>
  )
}

render(<App />, document.getElementById('app')!)
// для e2e и отладки: замер задержки из консоли — dotlink.link.measure(200)
;(window as any).dotlink = { link }
