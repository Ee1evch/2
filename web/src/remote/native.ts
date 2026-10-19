// Мост к нативной части APK (Capacitor). В браузере всё это просто недоступно — пульт работает без него.

export interface FoundPc { id: string; name: string; host: string; port: number; via: 'mdns' | 'udp' }
export interface SharedFile { uri: string; name: string; size: number; type: string }

import { Capacitor, registerPlugin } from '@capacitor/core'
import { unb64, b64 } from '../lib/b64'
import type { Pipe } from '../lib/pipe'

// плагины регистрируются один раз; в браузере их вызовы недоступны — проверяем isNative()
const PLUGINS = { DotLink: registerPlugin<any>('DotLink'), Filesystem: registerPlugin<any>('Filesystem'), Haptics: registerPlugin<any>('Haptics') }
const plugin = (name: keyof typeof PLUGINS): any => (Capacitor.isNativePlatform() ? PLUGINS[name] : undefined)

export const isNative = (): boolean => Capacitor.isNativePlatform()

/** Поиск ПК в сети: mDNS (_dotlink._tcp) + широковещательный UDP-запрос. */
export async function discover(timeout = 2500): Promise<FoundPc[]> {
  const p = plugin('DotLink')
  if (!p) return []
  try { return (await p.discover({ timeout })).pcs || [] } catch { return [] }
}

/** Файлы и ссылки/текст, присланные в DotLink через «Поделиться» Android. */
export async function sharedItems(): Promise<{ files: SharedFile[]; texts: string[] }> {
  const p = plugin('DotLink')
  if (!p) return { files: [], texts: [] }
  try { const r = await p.getShared(); return { files: r.files || [], texts: r.texts || [] } } catch { return { files: [], texts: [] } }
}

export function onShared(fn: () => void): () => void {
  const p = plugin('DotLink')
  if (!p?.addListener) return () => {}
  const h = p.addListener('shared', fn)
  return () => { void Promise.resolve(h).then((x: any) => x?.remove?.()) }
}

/** Прочитать присланный файл целиком (для передачи внутри сессии, когда HTTP до ПК нет). */
export async function readShared(uri: string, type: string): Promise<Blob> {
  const r = await plugin('Filesystem').readFile({ path: uri })
  return new Blob([unb64(r.data) as BlobPart], { type })
}

/** Загрузка присланного файла прямо из натива — без перегонки байтов через WebView. */
export async function uploadShared(uri: string, url: string): Promise<void> {
  await plugin('DotLink').upload({ uri, url })
}

/** Сохранить по ссылке в «Документы/DotLink» (в APK) — браузер скачивает сам. */
export async function saveFromUrl(url: string, name: string): Promise<string> {
  const fs = plugin('Filesystem')
  if (!fs) {
    const a = document.createElement('a')
    a.href = url; a.download = name; a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
    return 'Загрузки'
  }
  await fs.downloadFile({ url, path: `DotLink/${name}`, directory: 'DOCUMENTS', recursive: true })
  return 'Документы/DotLink'
}

/** Сохранить байты (файл, принятый по QR). */
export async function saveBytes(bytes: Uint8Array, name: string, type: string): Promise<string> {
  const fs = plugin('Filesystem')
  if (!fs) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
    const a = document.createElement('a')
    a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return 'Загрузки'
  }
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  await fs.writeFile({ path: `DotLink/${name}`, data: btoa(s), directory: 'DOCUMENTS', recursive: true })
  return 'Документы/DotLink'
}

/** Скопировать текст в буфер телефона (navigator.clipboard работает только в защищённом контексте). */
export async function copyText(text: string): Promise<boolean> {
  const p = plugin('DotLink')
  if (p) { try { await p.writeClipboard({ text }); return true } catch { /* ниже — запасной путь */ } }
  try { await navigator.clipboard.writeText(text); return true } catch { /* ниже — запасной путь */ }
  const t = document.createElement('textarea')
  t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'
  document.body.appendChild(t); t.select()
  const ok = document.execCommand('copy')
  t.remove()
  return ok
}

export async function readText(): Promise<string | null> {
  try { return await navigator.clipboard.readText() } catch { return null }
}

/** Открыть ссылку: в APK — в приложении по умолчанию (браузер, YouTube…), в браузере — новой вкладкой. */
export async function openUrl(url: string): Promise<void> {
  const p = plugin('DotLink')
  if (p) { await p.openUrl({ url }); return }
  window.open(url, '_blank', 'noopener')
}

/** Текст из буфера телефона. Android отдаёт буфер только приложению на экране — читаем при возвращении в него. */
export async function readClip(): Promise<string | null> {
  const p = plugin('DotLink')
  if (p) { try { return (await p.readClipboard()).text ?? null } catch { return null } }
  return readText()
}

// ───────── трансляция экрана, управление, уведомления, Bluetooth ─────────

export interface NativeStatus { control: boolean; controlEnabled: boolean; notifications: boolean; mirror: boolean; bluetooth: boolean }

export async function nativeStatus(): Promise<NativeStatus | null> {
  const p = plugin('DotLink')
  if (!p) return null
  try { return await p.status() } catch { return null }
}

export async function openSettings(what: 'accessibility' | 'notifications' | 'bluetooth'): Promise<void> {
  await plugin('DotLink')?.openSettings({ what })
}

export interface MirrorFrame { d: string; f: number; t: number; w: number; h: number }
export interface MirrorState { on: boolean; w: number; h: number; codec: string; error?: string }

export const mirror = {
  start: (o: { max?: number; bitrate?: number; fps?: number }) => plugin('DotLink').mirrorStart(o) as Promise<void>,
  stop: () => plugin('DotLink').mirrorStop() as Promise<void>,
  key: (bitrate?: number) => plugin('DotLink').mirrorKey({ bitrate }) as Promise<void>,
}

/** Подписка на события нативной части; в браузере — ничего. */
export function onNative(event: 'mirrorFrame' | 'mirrorState' | 'notification' | 'shared', fn: (e: any) => void): () => void {
  const p = plugin('DotLink')
  if (!p?.addListener) return () => {}
  const h = p.addListener(event, fn)
  return () => { void Promise.resolve(h).then((x: any) => x?.remove?.()) }
}

/** Жест или кнопка на телефоне по команде с ПК. */
export async function control(cmd: Record<string, unknown>): Promise<void> {
  await plugin('DotLink').control(cmd)
}

export function cursor(a: 'show' | 'hide' | 'move' | 'button' | 'scroll', args: Record<string, number | boolean> = {}): Promise<void> {
  return plugin('DotLink').cursor({ a, ...args })
}

/** Канал Bluetooth RFCOMM до ПК как обычная труба сессии. */
export async function btPipe(addr: string): Promise<Pipe> {
  const p = plugin('DotLink')
  if (!p) throw new Error('bluetooth')
  const { id } = await p.btConnect({ addr })
  let queued = 0
  const pipe: Pipe = {
    via: 'bt',
    where: `Bluetooth · ${addr}`,
    send: (d) => {
      const k = typeof d === 'string' ? 0 : 1
      const body = typeof d === 'string' ? new TextEncoder().encode(d) : d
      queued += body.length
      p.btSend({ id, k, d: b64(body) }).then(() => { queued -= body.length }, () => pipe.close())
      return true
    },
    buffered: () => queued,
    onmessage: null,
    onclose: null,
    close: () => { void p.btClose({ id }); off() },
  }
  const msg = p.addListener('bt', (e: any) => {
    if (e.id !== id) return
    const body = unb64(e.d)
    pipe.onmessage?.(e.k === 0 ? new TextDecoder().decode(body) : body)
  })
  const closed = p.addListener('btClose', (e: any) => { if (e.id === id) { off(); pipe.onclose?.() } })
  const off = () => { for (const h of [msg, closed]) void Promise.resolve(h).then((x: any) => x?.remove?.()) }
  return pipe
}