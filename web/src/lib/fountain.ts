// Фонтанный код RaptorQ (crates/dotlink-fountain), собранный в WebAssembly без wasm-bindgen.
import wasmUrl from './wasm/fountain.wasm?url'

interface Ex {
  memory: WebAssembly.Memory
  fx_alloc(n: number): number
  fx_free(p: number, n: number): void
  enc_new(p: number, len: number, symbol: number): number
  enc_oti(e: number, out: number): void
  enc_source_count(e: number): number
  enc_packet(e: number, i: number, out: number, cap: number): number
  enc_drop(e: number): void
  dec_new(oti: number): number
  dec_push(d: number, p: number, len: number): number
  dec_len(d: number): number
  dec_copy(d: number, out: number): void
  dec_drop(d: number): void
}

let mod: Promise<Ex> | null = null

/** `bytes` — для тестов в Node; в браузере модуль грузится с ПК/из APK. */
export function loadFountain(bytes?: BufferSource): Promise<Ex> {
  if (!mod) mod = (async () => {
    const src = bytes ?? (await (await fetch(wasmUrl)).arrayBuffer())
    const { instance } = await WebAssembly.instantiate(src, {})
    return instance.exports as unknown as Ex
  })()
  return mod
}

function withBuf<T>(ex: Ex, n: number, f: (p: number) => T): T {
  const p = ex.fx_alloc(n)
  try { return f(p) } finally { ex.fx_free(p, n) }
}

export class FountainEncoder {
  private readonly h: number
  readonly oti: Uint8Array
  readonly sourceCount: number
  private readonly cap: number

  constructor(private readonly ex: Ex, data: Uint8Array, readonly symbol: number) {
    this.h = withBuf(ex, data.length, (p) => {
      new Uint8Array(ex.memory.buffer, p, data.length).set(data)
      return ex.enc_new(p, data.length, symbol)
    })
    this.oti = withBuf(ex, 12, (p) => { ex.enc_oti(this.h, p); return new Uint8Array(ex.memory.buffer, p, 12).slice() })
    this.sourceCount = ex.enc_source_count(this.h)
    this.cap = symbol + 16
  }

  packet(i: number): Uint8Array {
    return withBuf(this.ex, this.cap, (p) => {
      const n = this.ex.enc_packet(this.h, i >>> 0, p, this.cap)
      return new Uint8Array(this.ex.memory.buffer, p, n).slice()
    })
  }

  free() { this.ex.enc_drop(this.h) }
}

export class FountainDecoder {
  private readonly h: number
  done = false

  constructor(private readonly ex: Ex, oti: Uint8Array) {
    this.h = withBuf(ex, 12, (p) => { new Uint8Array(ex.memory.buffer, p, 12).set(oti); return ex.dec_new(p) })
  }

  push(packet: Uint8Array): boolean {
    if (this.done) return true
    this.done = withBuf(this.ex, packet.length, (p) => {
      new Uint8Array(this.ex.memory.buffer, p, packet.length).set(packet)
      return this.ex.dec_push(this.h, p, packet.length) === 1
    })
    return this.done
  }

  result(): Uint8Array {
    const n = this.ex.dec_len(this.h)
    return withBuf(this.ex, n, (p) => { this.ex.dec_copy(this.h, p); return new Uint8Array(this.ex.memory.buffer, p, n).slice() })
  }

  free() { this.ex.dec_drop(this.h) }
}
