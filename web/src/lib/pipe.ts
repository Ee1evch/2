// Канал до ПК, по которому идёт сессия: WebSocket в локальной сети, WebSocket через ретранслятор
// (разные сети) или Bluetooth (без Wi-Fi и интернета, через нативный мост Android).
// Сессии всё равно, каким путём идут байты: вход и шифрование одинаковы — ретранслятор видит только шифр.

export type Via = 'lan' | 'relay' | 'bt'

export interface Pipe {
  readonly via: Via
  /** Где: «ip:port», адрес ретранслятора или имя ПК по Bluetooth — для экрана «Система». */
  readonly where: string
  send(d: string | Uint8Array): boolean
  /** Сколько байт ждёт отправки — чтобы движение не копилось в очереди. */
  buffered(): number
  onmessage: ((d: string | Uint8Array) => void) | null
  onclose: (() => void) | null
  close(): void
}

export function wsPipe(url: string, via: Via, where: string, ms = 4000): Promise<Pipe> {
  return new Promise((res, rej) => {
    let ws: WebSocket
    try { ws = new WebSocket(url) } catch (e) { rej(e); return }
    ws.binaryType = 'arraybuffer'
    const t = setTimeout(() => { ws.close(); rej(new Error('timeout')) }, ms)
    ws.onerror = () => { clearTimeout(t); rej(new Error('unreachable')) }
    ws.onopen = () => {
      clearTimeout(t)
      const p: Pipe = {
        via, where,
        send: (d) => { if (ws.readyState !== WebSocket.OPEN) return false; ws.send(d); return true },
        buffered: () => ws.bufferedAmount,
        onmessage: null,
        onclose: null,
        close: () => ws.close(),
      }
      ws.onmessage = (e) => p.onmessage?.(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
      ws.onclose = () => p.onclose?.()
      ws.onerror = () => {}
      res(p)
    }
  })
}

/** Следующее JSON-сообщение до входа (дальше — шифрованные кадры). */
export function nextJson(p: Pipe, ms = 8000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms)
    p.onmessage = (d) => {
      clearTimeout(t)
      try { res(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))) } catch (err) { rej(err) }
    }
    p.onclose = () => { clearTimeout(t); rej(new Error('closed')) }
  })
}

/** Адрес трубы ретранслятора для телефона: wss://relay/v1/phone/<комната>. */
export function relayPhoneUrl(relay: string, room: string): string {
  const u = new URL(relay.includes('://') ? relay : `wss://${relay}`)
  if (u.protocol === 'https:') u.protocol = 'wss:'
  if (u.protocol === 'http:') u.protocol = 'ws:'
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1/phone/${encodeURIComponent(room)}`
  return u.toString()
}
