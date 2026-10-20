import { useEffect, useRef, useState } from 'preact/hooks'
import { Button, DotDisplay, DotField, DotIcon, IconButton, Sheet, StatusDot, toast } from '../ui'
import { AuthError, loadSaved, pairAuth, parsePairUrl, type SavedPc } from '../lib/link'
import { applyContext } from './continuity'
import { cameraAvailable, QrScanner } from '../lib/qrscan'
import { timeAgo } from '../lib/format'
import { discover, isNative, type FoundPc, wakePc } from './native'
import { link, servedFromPc } from './state'

export function explain(e: unknown): string {
  const code = e instanceof AuthError ? e.code : (e as Error)?.message || String(e)
  const map: Record<string, string> = {
    expired: 'Код устарел — обновите QR на ПК',
    'bad-pin': 'Неверный PIN. После пяти ошибок ПК покажет новый',
    'bad-secret': 'Этот QR уже использован — на ПК появился новый',
    revoked: 'ПК отключил этот телефон. Подключитесь заново',
    'unknown-device': 'ПК не знает этот телефон — подключитесь заново',
    'bad-auth': 'Ключ не подошёл — подключитесь заново',
    'server-proof': 'ПК не подтвердил подлинность. Проверьте, что это ваш компьютер',
    timeout: 'ПК не отвечает. Телефон и ПК должны быть в одной сети, DotLink — запущен',
    unreachable: 'ПК не отвечает. Телефон и ПК должны быть в одной сети, DotLink — запущен',
    closed: 'Связь оборвалась при подключении',
  }
  return map[code] || (code.includes('AggregateError') || code.includes('All promises') ? map.unreachable : `Не удалось подключиться: ${code}`)
}

function ScanQr({ onText, onClose }: { onText: (t: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    let done = false
    const s = new QrScanner(video.current!, (texts) => {
      const t = texts.find((x) => parsePairUrl(x))
      if (t && !done) { done = true; s.stop(); onText(t) }
    }, 1280)
    s.start().catch((e) => { toast('Камера недоступна: ' + e.message, 'err'); onClose() })
    return () => s.stop()
  }, [])
  return (
    <div class="qr-full dark">
      <video ref={video} class="qr-video" playsInline muted />
      <div class="qr-aim" aria-hidden="true"><i /><i /><i /><i /></div>
      <div class="qr-bar"><div class="row"><IconButton icon="close" label="Закрыть" onClick={onClose} /><b>Наведите на QR в DotLink на ПК</b></div></div>
    </div>
  )
}

export function Connect({ error, onDone }: { error?: string | null; onDone: () => void }) {
  const [found, setFound] = useState<FoundPc[]>([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState(error ?? null)
  const [pinFor, setPinFor] = useState<{ host: string; name: string } | null>(null)
  const [pin, setPin] = useState('')
  const [manual, setManual] = useState('')
  const [scan, setScan] = useState(false)
  const saved = loadSaved()

  const search = async () => {
    if (!isNative()) return
    setSearching(true)
    setFound(await discover(2500))
    setSearching(false)
  }
  useEffect(() => { void search(); const t = setInterval(search, 8000); return () => clearInterval(t) }, [])

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key); setErr(null)
    try { await f(); onDone() } catch (e) { setErr(explain(e)) } finally { setBusy(null) }
  }
  const viaSaved = (p: SavedPc, extra: string[] = []) => run(p.pc, () => link.connect({ kind: 'device', saved: p }, [...new Set([...extra, ...p.hosts])]))
  const viaPin = (host: string) => run('pin', () => link.connect({ kind: 'pin', pin }, [host]))
  const viaQr = (text: string) => {
    const p = parsePairUrl(text)
    if (!p) { setErr('Это не QR DotLink'); return }
    const { auth, hosts } = pairAuth(p)
    void run('qr', () => link.connect(auth, hosts).then(() => { if (p.go) void applyContext(p.go) }))
  }
  const pick = (f: FoundPc) => {
    const host = `${f.host}:${f.port}`
    const s = saved.find((x) => x.pc === f.id)
    if (s) void viaSaved(s, [host])
    else { setPin(''); setPinFor({ host, name: f.name }) }
  }

  return (
    <div class="connect">
      <div class="connect-hero">
        <DotField mode="hero" />
        <div class="connect-hero-in" data-dots-avoid>
          <DotDisplay text="DOTLINK" pitch={5} />
          <h1 class="title">Пульт<br />для вашего ПК</h1>
          <p class="sub">Тачпад, клавиатура, музыка, экран телефона и файлы — по Wi-Fi, через интернет из любой сети или по Bluetooth.</p>
        </div>
      </div>

      {err && <div class="note err" role="alert"><DotIcon name="close" size={14} />{err}</div>}

      {saved.length > 0 && (
        <section class="stack">
          <span class="label">Ваши ПК</span>
          {saved.map((p) => (
            <div key={p.pc} class="pc-line">
              <button type="button" class="pc-row" disabled={!!busy} onClick={() => void viaSaved(p, servedFromPc ? [location.host] : [])}>
                <DotIcon name="desktop" size={20} />
                <span class="grow"><b>{p.name}</b><small>{p.hosts[0]} · {timeAgo(p.at)}</small></span>
                {busy === p.pc ? <StatusDot state="warn" live /> : <DotIcon name="right" size={14} />}
              </button>
              {isNative() && !!p.routes?.wol?.length && (
                <button type="button" class="pc-wake" aria-label={`Включить ${p.name}`} disabled={!!busy} onClick={async () => {
                  if (!(await wakePc(p))) { setErr('Не получилось отправить сигнал включения'); return }
                  toast('Бужу ПК — обычно 10–40 секунд')
                  setTimeout(() => void viaSaved(p, []), 9000)
                }}><DotIcon name="power" size={18} /></button>
              )}
            </div>
          ))}
        </section>
      )}

      {isNative() && (
        <section class="stack">
          <span class="label row">В этой сети {searching && <StatusDot state="accent" live />}</span>
          {found.length === 0 && <span class="muted small">{searching ? 'Ищу ПК с DotLink…' : 'Не найдено. Убедитесь, что DotLink запущен на ПК и вы в одной сети.'}</span>}
          {found.map((f) => (
            <button key={f.id + f.host} type="button" class="pc-row" disabled={!!busy} onClick={() => pick(f)}>
              <DotIcon name={f.host.startsWith('192.168.42.') ? 'usb' : 'wifi'} size={20} />
              <span class="grow"><b>{f.name}</b><small>{f.host} · {f.via === 'mdns' ? 'mDNS' : 'UDP'}</small></span>
              <DotIcon name="right" size={14} />
            </button>
          ))}
        </section>
      )}

      <section class="stack">
        <span class="label">Новое подключение</span>
        {cameraAvailable() ? (
          <Button variant="primary" icon="scan" block onClick={() => setScan(true)}>Сканировать QR на ПК</Button>
        ) : (
          <div class="note">
            <b>Как подключиться</b>
            <ol>
              <li>Запустите DotLink на ПК — на экране будет QR-код.</li>
              <li>Наведите на него обычную камеру телефона и откройте ссылку.</li>
              <li>Пульт откроется в браузере и запомнит ПК.</li>
            </ol>
          </div>
        )}
        <div class="row">
          <input class="input grow" inputMode="decimal" placeholder="IP ПК, например 192.168.1.5" value={manual} onInput={(e) => setManual((e.target as HTMLInputElement).value.trim())} />
          <Button disabled={!manual} onClick={() => { setPin(''); setPinFor({ host: manual.includes(':') ? manual : `${manual}:47800`, name: manual }) }}>PIN</Button>
        </div>
      </section>

      <Sheet open={!!pinFor} onClose={() => setPinFor(null)} title={`PIN для ${pinFor?.name ?? ''}`}>
        <div class="stack">
          <p class="sub">Шесть цифр с экрана DotLink на ПК.</p>
          <label class="pin-box">
            <DotDisplay text={(pin + '······').slice(0, 6).replace(/·/g, '-')} pitch={8} lit="var(--text)" />
            <input class="pin-input" type="tel" inputMode="numeric" autoFocus maxLength={6} value={pin} aria-label="PIN"
              onInput={(e) => { const v = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6); setPin(v); if (v.length === 6 && pinFor) void viaPin(pinFor.host).then(() => setPinFor(null)) }} />
          </label>
          <Button variant="primary" block disabled={pin.length !== 6 || busy === 'pin'} onClick={() => pinFor && void viaPin(pinFor.host)}>{busy === 'pin' ? 'Подключаю…' : 'Подключить'}</Button>
        </div>
      </Sheet>
      {scan && <ScanQr onClose={() => setScan(false)} onText={(t) => { setScan(false); viaQr(t) }} />}
    </div>
  )
}
