// Передача файла потоком QR-кодов — без какой-либо сети.
//
// Файл (+ имя и тип, сжатие при выгоде) кодируется RaptorQ в бесконечный поток пакетов.
// Каждый пакет — один QR (алфавитно-цифровой режим, Base45, коррекция L). На экране — сетка из многих
// QR одновременно; приёмнику хватает любых ~K+2 различных пакетов в любом порядке, обратная связь не нужна.
//
// Кадр: 'D' | версия 1 | id передачи u32 | OTI 12 байт | пакет RaptorQ (4 байта id + символ)
import qrcode from 'qrcode-generator'
import { b45decode, b45encode } from './base45'
import { FountainDecoder, FountainEncoder, loadFountain } from './fountain'

const MAGIC = 0x44
const HEADER = 18

export type Density = 'reliable' | 'fast' | 'max'
/** Версия QR и минимальный размер модуля на экране (px) для каждой плотности. */
export const DENSITY: Record<Density, { version: number; minModule: number; fps: number; label: string }> = {
  reliable: { version: 10, minModule: 6, fps: 8, label: 'Надёжно' },
  fast: { version: 15, minModule: 4, fps: 12, label: 'Быстро' },
  max: { version: 20, minModule: 3, fps: 15, label: 'Максимум' },
}

const capCache = new Map<number, number>()
/** Сколько байт (до Base45) помещается в QR данной версии с коррекцией L. */
export function capacity(version: number): number {
  const c = capCache.get(version)
  if (c) return c
  const fits = (bytes: number) => {
    try {
      const q = qrcode(version as any, 'L')
      q.addData(b45encode(new Uint8Array(bytes)), 'Alphanumeric')
      q.make()
      return true
    } catch { return false }
  }
  let lo = 16, hi = 3000
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(mid)) lo = mid; else hi = mid - 1 }
  capCache.set(version, lo)
  return lo
}

// ───────── упаковка файла ─────────

export interface Payload { name: string; type: string; bytes: Uint8Array }

const INCOMPRESSIBLE = /^(image\/(jpeg|png|webp|gif|avif|heic)|video\/|audio\/|application\/(zip|gzip|x-7z|x-rar|pdf))/

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

export async function pack(p: Payload): Promise<Uint8Array> {
  let data = p.bytes, z = 0
  if (p.bytes.length > 256 && !INCOMPRESSIBLE.test(p.type) && typeof CompressionStream !== 'undefined') {
    const c = await pipe(p.bytes, new CompressionStream('deflate-raw'))
    if (c.length < p.bytes.length * 0.95) { data = c; z = 1 }
  }
  const meta = new TextEncoder().encode(JSON.stringify({ n: p.name, t: p.type, s: p.bytes.length, z }))
  const out = new Uint8Array(2 + meta.length + data.length)
  new DataView(out.buffer).setUint16(0, meta.length, true)
  out.set(meta, 2)
  out.set(data, 2 + meta.length)
  return out
}

export async function unpack(blob: Uint8Array): Promise<Payload> {
  const ml = new DataView(blob.buffer, blob.byteOffset).getUint16(0, true)
  const meta = JSON.parse(new TextDecoder().decode(blob.subarray(2, 2 + ml)))
  let bytes = blob.subarray(2 + ml)
  if (meta.z) bytes = await pipe(bytes, new DecompressionStream('deflate-raw'))
  if (bytes.length !== meta.s) throw new Error('размер не совпал')
  return { name: meta.n, type: meta.t || 'application/octet-stream', bytes: bytes.slice() }
}

// ───────── отправитель ─────────

export interface QrMatrix { n: number; dark: Uint8Array }

export class QrSender {
  readonly id = (Math.random() * 2 ** 32) >>> 0
  readonly enc: FountainEncoder
  readonly version: number
  private next = 0

  private constructor(enc: FountainEncoder, version: number) { this.enc = enc; this.version = version }

  static async create(blob: Uint8Array, density: Density, wasm?: BufferSource): Promise<QrSender> {
    const ex = await loadFountain(wasm)
    const version = DENSITY[density].version
    // символ RaptorQ выравнивается на 8 байт; 4 байта — id пакета
    const symbol = Math.floor((capacity(version) - HEADER - 4) / 8) * 8
    return new QrSender(new FountainEncoder(ex, blob, symbol), version)
  }

  /** Сколько исходных пакетов (K): столько минимум нужно приёмнику. */
  get k() { return this.enc.sourceCount }
  get sent() { return this.next }

  frame(i: number): string {
    const pkt = this.enc.packet(i)
    const f = new Uint8Array(HEADER + pkt.length)
    const d = new DataView(f.buffer)
    f[0] = MAGIC; f[1] = 1
    d.setUint32(2, this.id, true)
    f.set(this.enc.oti, 6)
    f.set(pkt, HEADER)
    return b45encode(f)
  }

  matrix(text: string): QrMatrix {
    const q = qrcode(this.version as any, 'L')
    q.addData(text, 'Alphanumeric')
    q.make()
    const n = q.getModuleCount()
    const dark = new Uint8Array(n * n)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) dark[r * n + c] = 1
    return { n, dark }
  }

  /** Следующие `count` QR потока. */
  take(count: number): QrMatrix[] {
    const out: QrMatrix[] = []
    for (let i = 0; i < count; i++) out.push(this.matrix(this.frame(this.next++)))
    return out
  }

  free() { this.enc.free() }
}

/** Сетка: сколько QR помещается при модуле не меньше `minModule` пикселей. */
export function layout(w: number, h: number, n: number, minModule: number, quiet = 3): { cols: number; rows: number; module: number } {
  const cell = n + quiet * 2
  let best = { cols: 1, rows: 1, module: Math.max(1, Math.floor(Math.min(w, h) / cell)) }
  for (let cols = 1; cols <= 8; cols++) for (let rows = 1; rows <= 8; rows++) {
    const module = Math.floor(Math.min(w / (cols * cell), h / (rows * cell)))
    if (module >= minModule && cols * rows > best.cols * best.rows) best = { cols, rows, module }
  }
  return best
}

/** Рисует сетку QR: чёрные модули на белом, с тихой зоной вокруг каждого кода. */
export function drawGrid(g: CanvasRenderingContext2D, codes: QrMatrix[], w: number, h: number, cols: number, rows: number, module: number, quiet = 3) {
  g.fillStyle = '#fff'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#000'
  if (!codes.length) return
  const n = codes[0].n, cell = (n + quiet * 2) * module
  const ox = Math.floor((w - cols * cell) / 2), oy = Math.floor((h - rows * cell) / 2)
  codes.forEach((m, i) => {
    const x0 = ox + (i % cols) * cell + quiet * module, y0 = oy + Math.floor(i / cols) * cell + quiet * module
    for (let r = 0; r < n; r++) {
      let c = 0
      while (c < n) {
        if (!m.dark[r * n + c]) { c++; continue }
        const s = c
        while (c < n && m.dark[r * n + c]) c++
        g.fillRect(x0 + s * module, y0 + r * module, (c - s) * module, module)
      }
    }
  })
}

// ───────── приёмник ─────────

export interface RxProgress { id: number; have: number; k: number; done: boolean }

export class QrReceiver {
  private dec: FountainDecoder | null = null
  private id = -1
  private seen = new Set<number>()
  k = 0
  result: Payload | null = null
  onProgress: (p: RxProgress) => void = () => {}
  onDone: (p: Payload) => void = () => {}
  private finishing = false

  private constructor(private readonly ex: Awaited<ReturnType<typeof loadFountain>>) {}

  static async create(wasm?: BufferSource) { return new QrReceiver(await loadFountain(wasm)) }

  get have() { return this.seen.size }
  /** id исходных/ремонтных пакетов, принятых по порядку (для матрицы прогресса). */
  has(esi: number) { return this.seen.has(esi) }

  /** Принять текст одного QR. `true` — пакет новый. */
  accept(text: string): boolean {
    if (this.result || this.finishing) return false
    const f = b45decode(text.trim())
    if (!f || f.length < HEADER + 5 || f[0] !== MAGIC || f[1] !== 1) return false
    const d = new DataView(f.buffer)
    const id = d.getUint32(2, true)
    const pkt = f.subarray(HEADER)
    const pid = d.getUint32(HEADER, false) // SBN (1 байт) + ESI (3 байта)
    if (id !== this.id) {
      // новая передача — начинаем заново
      this.dec?.free()
      const oti = f.subarray(6, 18)
      this.dec = new FountainDecoder(this.ex, oti)
      this.id = id
      this.seen.clear()
      const od = new DataView(oti.buffer, oti.byteOffset)
      const len = od.getUint32(0, false) * 256 + oti[4]
      const t = od.getUint16(6, false)
      this.k = Math.max(1, Math.ceil(len / Math.max(1, t)))
    }
    if (this.seen.has(pid)) return false
    this.seen.add(pid)
    const done = this.dec!.push(pkt)
    this.onProgress({ id, have: this.seen.size, k: this.k, done })
    if (done) {
      this.finishing = true
      void unpack(this.dec!.result()).then((p) => { this.result = p; this.onDone(p) }, () => { this.finishing = false; this.id = -1 })
    }
    return true
  }

  free() { this.dec?.free(); this.dec = null }
}
