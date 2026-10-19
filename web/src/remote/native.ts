// Мост к нативной части APK (Capacitor). В браузере всё это просто недоступно — пульт работает без него.

export interface FoundPc { id: string; name: string; host: string; port: number; via: 'mdns' | 'udp' }
export interface SharedFile { uri: string; name: string; size: number; type: string }

const cap = (): any => (globalThis as any).Capacitor
const plugin = (name: string): any => cap()?.Plugins?.[name]

export const isNative = (): boolean => !!cap()?.isNativePlatform?.()

/** Поиск ПК в сети: mDNS (_dotlink._tcp) + широковещательный UDP-запрос. */
export async function discover(timeout = 2500): Promise<FoundPc[]> {
  const p = plugin('DotLink')
  if (!p) return []
  try { return (await p.discover({ timeout })).pcs || [] } catch { return [] }
}

/** Файлы, присланные в DotLink через «Поделиться» Android. */
export async function sharedFiles(): Promise<SharedFile[]> {
  const p = plugin('DotLink')
  if (!p) return []
  try { return (await p.getShared()).files || [] } catch { return [] }
}

export function onShared(fn: () => void): () => void {
  const p = plugin('DotLink')
  if (!p?.addListener) return () => {}
  const h = p.addListener('shared', fn)
  return () => { void Promise.resolve(h).then((x: any) => x?.remove?.()) }
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
