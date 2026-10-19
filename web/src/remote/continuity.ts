// Непрерывность, как между устройствами Apple: ссылка или текст с ПК — сразу на телефоне,
// скопированное на телефоне — в буфере ПК, и наоборот (буфер ПК приходит состоянием «clip»).
import { toast } from '../ui'
import { copyText, openUrl, readClip } from './native'
import { link, prefs } from './state'

const isLink = (s: string) => /^(https?:\/\/|mailto:|tel:)\S+$/i.test(s.trim())

/** Ссылку — открыть, текст — положить в буфер телефона. */
export async function applyContext(v: string) {
  const s = v.trim()
  if (!s) return
  if (isLink(s)) {
    try { await openUrl(s); toast('Открыто с ПК') } catch { toast('Не удалось открыть ссылку', 'err') }
    return
  }
  const ok = await copyText(s)
  if (ok) lastSeen = s
  toast(ok ? 'Текст с ПК — в буфере телефона' : 'Не удалось скопировать', ok ? undefined : 'err')
}

link.on('open-url', (m) => void applyContext(String(m.url || '')))
link.on('clip-push', (m) => {
  const t = String(m.text || '')
  void copyText(t).then((ok) => { if (ok) lastSeen = t; toast(ok ? 'Текст с ПК — в буфере телефона' : 'Не удалось скопировать', ok ? undefined : 'err') })
})

// что уже было в буфере: своё и пришедшее с ПК обратно не отправляем
let lastSeen = ''
// ПК → телефон: скопированное на ПК сразу в буфере телефона (пока пульт открыт)
link.on('*', (m) => {
  if (m.t !== 'state' || m.k !== 'clip' || !m.v?.text || m.v.from === 'phone') return
  const t: string = m.v.text
  if (t === lastSeen) return
  lastSeen = t
  if (prefs.value.clipAuto && document.visibilityState === 'visible') void copyText(t)
})

/** Телефон → ПК: при возвращении в приложение смотрим буфер; новое — в буфер ПК. */
export async function pushClipboard(force = false): Promise<boolean> {
  if (!link.online || !link.perms.value?.clipboard) return false
  if (!force && !prefs.value.clipAuto) return false
  const t = (await readClip())?.trim()
  if (!t || (!force && t === lastSeen)) return false
  lastSeen = t
  return link.json({ t: 'clip-set', text: t })
}

/** «Открыть на ПК»: ссылка из буфера телефона открывается в браузере ПК. */
export async function handoffToPc(): Promise<void> {
  const t = (await readClip())?.trim() || ''
  if (!isLink(t)) { toast('В буфере телефона нет ссылки', 'err'); return }
  link.json({ t: 'open-url', url: t })
}

if (typeof document !== 'undefined') {
  const check = () => { if (document.visibilityState === 'visible') setTimeout(() => void pushClipboard(), 400) }
  document.addEventListener('visibilitychange', check)
  addEventListener('focus', check)
  link.status.subscribe((s) => { if (s === 'online') check() })
}
