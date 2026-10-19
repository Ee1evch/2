// Файлы внутри сессии — когда до ПК нет прямого HTTP (связь через ретранслятор или Bluetooth).
// Кадр 0x0B: u8 вид (0 данные, 1 конец, 2 отмена), u8 длина билета, билет, данные.
// По Wi-Fi файлы по-прежнему идут отдельным HTTP-запросом — так быстрее.
import type { Link } from './link'

const OP_FILE = 0x0b
const CHUNK = 32 * 1024
const MAX_QUEUE = 512 * 1024

export function fileFrame(kind: 0 | 1 | 2, id: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const idb = new TextEncoder().encode(id).subarray(0, 255)
  const b = new Uint8Array(3 + idb.length + data.length)
  b[0] = OP_FILE; b[1] = kind; b[2] = idb.length
  b.set(idb, 3); b.set(data, 3 + idb.length)
  return b
}

export function parseFileFrame(b: Uint8Array): { kind: number; id: string; data: Uint8Array } | null {
  if (b[0] !== OP_FILE || b.length < 3 || b.length < 3 + b[2]) return null
  return { kind: b[1], id: new TextDecoder().decode(b.subarray(3, 3 + b[2])), data: b.subarray(3 + b[2]) }
}

const ticketOf = (url: string) => url.split('/').pop() || ''

/** Телефон → ПК: части файла по основному каналу, не обгоняя сеть. */
export async function sendInSession(link: Link, file: Blob, uploadUrl: string, onProgress: (n: number) => void): Promise<void> {
  const id = ticketOf(uploadUrl)
  const done = link.once('*', (m) => (m.t === 'ok' || m.t === 'error') && m.for === 'upload' && m.id === id, 10 * 60_000)
  for (let off = 0; off < file.size; off += CHUNK) {
    while (link.backlog > MAX_QUEUE) {
      if (!link.online) throw new Error('связь прервалась')
      await new Promise((r) => setTimeout(r, 15))
    }
    const part = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer())
    if (!link.bulk(fileFrame(0, id, part))) throw new Error('связь прервалась')
    onProgress(off + part.length)
  }
  link.bulk(fileFrame(1, id))
  const r = await done
  if (r.t === 'error') throw new Error(r.msg || 'ПК не принял файл')
}

/** ПК → телефон: попросить предложенный файл частями внутри сессии. */
export function fetchInSession(link: Link, downloadUrl: string, onProgress: (n: number) => void = () => {}): Promise<Uint8Array> {
  const id = ticketOf(downloadUrl)
  return new Promise((res, rej) => {
    const parts: Uint8Array[] = []
    let got = 0
    const stop = link.on('bin', (d: Uint8Array) => {
      const f = parseFileFrame(d)
      if (!f || f.id !== id) return
      if (f.kind === 0) { parts.push(f.data.slice()); got += f.data.length; onProgress(got); return }
      stop(); offErr()
      if (f.kind === 2) { rej(new Error('ПК не смог отдать файл')); return }
      const out = new Uint8Array(got)
      let o = 0
      for (const p of parts) { out.set(p, o); o += p.length }
      res(out)
    })
    const offErr = link.on('error', (m) => { if (m.msg && /файл/.test(m.msg)) { stop(); offErr(); rej(new Error(m.msg)) } })
    if (!link.json({ t: 'file-get', ticket: id })) { stop(); offErr(); rej(new Error('нет связи')) }
  })
}
