// Телефон без браузера для сквозных тестов: то же сопряжение и шифрование, что в пульте
// (src/lib/crypto), но кадры можно слать руками — например, видео экрана.
import { b64, random, unb64, utf8 } from '../../src/lib/b64'
import { Channel, deviceKey, PairKeys, pairMac, pairTranscript } from '../../src/lib/crypto'

export class NodePhone {
  readonly msgs: any[] = []
  private waiters: (() => void)[] = []
  private constructor(private ws: WebSocket, private chan: Channel, early: MessageEvent[]) {
    ws.onmessage = (e) => this.take(e)
    for (const e of early) this.take(e)
  }

  private take(e: MessageEvent) {
    if (typeof e.data === 'string') return
    const p = this.chan.open(new Uint8Array(e.data as ArrayBuffer))
    if (!p || p[0] !== 0x7b) return
    this.msgs.push(JSON.parse(new TextDecoder().decode(p)))
    for (const w of this.waiters.splice(0)) w()
  }

  /** Сопряжение по секрету из QR (как при сканировании). */
  static async pair(wsUrl: string, secret: string, name: string): Promise<NodePhone> {
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    // несколько кадров могут прийти одним пакетом: копим всё, что пришло до входа
    const queue: MessageEvent[] = []
    let wake: (() => void) | null = null
    ws.onmessage = (e) => { queue.push(e); wake?.() }
    const next = async (): Promise<any> => {
      while (!queue.length) await new Promise<void>((r) => { wake = r })
      const e = queue.shift()!
      return JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))
    }
    const keys = new PairKeys()
    const nc = random(16)
    ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'remote', pair: 'qr', pub: b64(keys.public), nonce: b64(nc), name }))
    const ch = await next()
    if (ch.t !== 'pair-challenge') throw new Error(JSON.stringify(ch))
    const pubS = unb64(ch.pub), ns = unb64(ch.nonce)
    const z = keys.shared(pubS)
    const t = pairTranscript(keys.public, pubS, nc, ns)
    const s = unb64(secret)
    ws.send(JSON.stringify({ t: 'pair-proof', mac: b64(pairMac(s, 'c', t, z)) }))
    const r = await next()
    if (r.t !== 'paired') throw new Error(JSON.stringify(r))
    return new NodePhone(ws, new Channel(deviceKey(z, s, t), nc, ns), queue)
  }

  json(v: unknown) { this.ws.send(this.chan.seal(utf8(JSON.stringify(v))) as Uint8Array<ArrayBuffer>) }
  bin(b: Uint8Array) { this.ws.send(this.chan.seal(b) as Uint8Array<ArrayBuffer>) }

  async waitFor(pred: (m: any) => boolean, ms = 8000): Promise<any> {
    const t0 = Date.now()
    for (;;) {
      const hit = this.msgs.find(pred)
      if (hit) return hit
      if (Date.now() - t0 > ms) throw new Error('телефон не дождался сообщения')
      await new Promise<void>((res) => { this.waiters.push(res); setTimeout(res, 100) })
    }
  }

  close() { this.ws.close() }
}

/** Кадр трансляции, как его шлёт приложение: флаги, время, размер, данные. */
export function mirrorFrame(data: Uint8Array, key: boolean, t: number, w: number, h: number): Uint8Array {
  const b = new Uint8Array(10 + data.length)
  const v = new DataView(b.buffer)
  b[0] = 0x0a; b[1] = key ? 1 : 0
  v.setUint32(2, t >>> 0, true); v.setUint16(6, w, true); v.setUint16(8, h, true)
  b.set(data, 10)
  return b
}
