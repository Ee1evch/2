// Приём трансляции экрана телефона: кадры MIRROR (H.264 Annex B с телефона или VP8) → WebCodecs →
// холст. Декодер в режиме низкой задержки; кадр рисуется сразу, без буфера воспроизведения.
// Потерялся кадр или декодер не успевает — ждём следующий ключевой и просим его у телефона.

export interface MirrorHead { flags: number; t: number; w: number; h: number; data: Uint8Array }

export function parseMirror(b: Uint8Array): MirrorHead | null {
  if (b.length <= 10 || b[0] !== 0x0a) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { flags: b[1], t: v.getUint32(2, true), w: v.getUint16(6, true), h: v.getUint16(8, true), data: b.subarray(10) }
}

/** Строка кодека из SPS: avc1.PPCCLL (профиль, ограничения, уровень). */
export function avcCodec(config: Uint8Array): string | null {
  for (let i = 0; i + 4 < config.length; i++) {
    const sc3 = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1
    if (!sc3) continue
    const n = i + 3
    if ((config[n] & 0x1f) === 7 && n + 3 < config.length) {
      const hx = (x: number) => x.toString(16).padStart(2, '0')
      return `avc1.${hx(config[n + 1])}${hx(config[n + 2])}${hx(config[n + 3])}`
    }
  }
  return null
}

const concat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o }

export const mirrorSupported = () => typeof VideoDecoder === 'function'

export class MirrorDecoder {
  private dec: VideoDecoder | null = null
  private config: Uint8Array | null = null
  private configured = ''
  private waitKey = true
  private lastAsk = 0
  /** Кадров показано — для индикатора и тестов. */
  frames = 0
  fps = 0
  private fpsAt = 0
  private fpsN = 0

  constructor(private readonly canvas: HTMLCanvasElement, private readonly kind: 'avc' | 'vp8', private readonly askKey: () => void) {}

  private ask() {
    const now = performance.now()
    if (now - this.lastAsk < 500) return
    this.lastAsk = now
    this.askKey()
  }

  private ensure(codec: string) {
    if (this.dec && this.dec.state === 'configured' && this.configured === codec) return
    if (!this.dec || this.dec.state === 'closed') {
      const g = this.canvas.getContext('2d', { alpha: false, desynchronized: true }) as CanvasRenderingContext2D
      this.dec = new VideoDecoder({
        output: (f) => {
          if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) {
            this.canvas.width = f.displayWidth
            this.canvas.height = f.displayHeight
          }
          g.drawImage(f, 0, 0)
          f.close()
          this.frames++
          this.fpsN++
          const now = performance.now()
          if (now - this.fpsAt >= 1000) { this.fps = Math.round((this.fpsN * 1000) / (now - this.fpsAt || 1)); this.fpsN = 0; this.fpsAt = now }
        },
        error: () => { this.dec = null; this.configured = ''; this.waitKey = true; this.ask() },
      })
    }
    this.dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' })
    this.configured = codec
    this.waitKey = true
  }

  push(b: Uint8Array) {
    const m = parseMirror(b)
    if (!m) return
    const key = (m.flags & 1) !== 0
    if (m.flags & 2) {
      // SPS/PPS: новая конфигурация (начало, поворот экрана) — ждём ключевой кадр
      this.config = m.data.slice()
      const c = avcCodec(this.config)
      if (c) this.ensure(c)
      return
    }
    if (this.kind === 'vp8') this.ensure('vp8')
    else if (!this.dec || this.dec.state !== 'configured') { this.ask(); return }
    const dec = this.dec!
    if (this.waitKey && !key) { this.ask(); return }
    // декодер не успевает — лучше пропустить до ключевого кадра, чем копить отставание
    if (!key && dec.decodeQueueSize > 4) { this.waitKey = true; this.ask(); return }
    const data = key && this.kind === 'avc' && this.config ? concat(this.config, m.data) : m.data
    try {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: m.t * 1000, data }))
      this.waitKey = false
    } catch {
      this.waitKey = true
      this.ask()
    }
  }

  close() {
    try { this.dec?.close() } catch { /* уже закрыт */ }
    this.dec = null
  }
}
