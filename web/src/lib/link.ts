// Соединение с ПК: вход (сопряжение или ключ устройства), шифрованный канал, состояние, переподключение.
import { signal, type Signal } from '@preact/signals'
import { b64, random, unb64, utf8 } from './b64'
import { authMac, Channel, ctEq, deviceKey, PairKeys, pairMac, pairTranscript } from './crypto'
import { moveFrame, OP, pingFrame, scrollFrame } from './proto'

export interface Perms { input: boolean; media: boolean; power: boolean; macros: boolean; clipboard: boolean; files: boolean }

/** Сопряжённый ПК, хранится на телефоне. */
export interface SavedPc { pc: string; name: string; device: string; key: string; hosts: string[]; port: number; at: number }

export type Auth =
  | { kind: 'device'; saved: SavedPc }
  | { kind: 'qr'; secret: string; name?: string }
  | { kind: 'pin'; pin: string }
  | { kind: 'admin'; token: string }

export type Status = 'idle' | 'connecting' | 'online' | 'offline'

export class AuthError extends Error {
  constructor(readonly code: string) { super(code) }
}

const STORE = 'dotlink.pcs'

export function loadSaved(): SavedPc[] {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]') } catch { return [] }
}
export function saveSaved(list: SavedPc[]) {
  try { localStorage.setItem(STORE, JSON.stringify(list)) } catch { /* приватный режим */ }
}
export function forgetPc(pc: string) { saveSaved(loadSaved().filter((p) => p.pc !== pc)) }

/** Имя телефона для списка устройств на ПК. */
export function deviceName(): string {
  const ua = navigator.userAgent
  const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)
  if (m && m[1] && m[1] !== 'K') return m[1].trim()
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android'
  return 'Браузер'
}

function opened(ws: WebSocket, ms: number): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws.close(); rej(new Error('timeout')) }, ms)
    ws.onopen = () => { clearTimeout(t); res() }
    ws.onerror = () => { clearTimeout(t); rej(new Error('unreachable')) }
  })
}

function nextJson(ws: WebSocket, ms = 8000): Promise<any> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms)
    ws.onmessage = (e) => {
      clearTimeout(t)
      try { res(JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))) } catch (err) { rej(err) }
    }
    ws.onclose = () => { clearTimeout(t); rej(new Error('closed')) }
  })
}

/** Быстрая проверка адресов: первый ответивший с нужным id. */
export async function probe(hosts: string[], port: number, pc?: string, ms = 2500): Promise<string> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await Promise.any(hosts.map(async (h) => {
      const hp = h.includes(':') ? h : `${h}:${port}`
      const r = await fetch(`http://${hp}/api/info`, { signal: ctl.signal, cache: 'no-store' })
      const info = await r.json()
      if (info.t !== 'dotlink' || (pc && info.id !== pc)) throw new Error('other')
      return hp
    }))
  } finally { clearTimeout(t); ctl.abort() }
}

type Listener = (m: any) => void

export class Link {
  readonly status = signal<Status>('idle')
  readonly rtt = signal(0)
  readonly perms = signal<Perms | null>(null)
  readonly error = signal<string | null>(null)
  readonly host = signal<string>('')
  readonly pcName = signal<string>('')
  readonly pcId = signal<string>('')
  private readonly keys = new Map<string, Signal<any>>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private ws: WebSocket | null = null
  private chan: Channel | null = null
  private auth: Auth | null = null
  private hosts: string[] = []
  private retry = 0
  private retryTimer = 0
  private pingTimer = 0
  private pings = new Map<number, number>()
  private waiters = new Map<number, () => void>()
  private lastRttReport = 0
  private closedByUs = false
  // склейка движения, если сеть не успевает
  private pendX = 0
  private pendY = 0
  private flushTimer = 0

  /** Сигнал ключа состояния ПК: vol, media, sys, win, clip, timer, macros, pc, art… */
  get<T = any>(key: string): Signal<T | undefined> {
    let s = this.keys.get(key)
    if (!s) { s = signal(undefined); this.keys.set(key, s) }
    return s
  }

  on(type: string, fn: Listener): () => void {
    let set = this.listeners.get(type)
    if (!set) { set = new Set(); this.listeners.set(type, set) }
    set.add(fn)
    return () => set!.delete(fn)
  }

  private emit(type: string, m: any) { this.listeners.get(type)?.forEach((f) => f(m)) }

  /** Подключиться. `hosts` — «ip:port» кандидаты; для страницы с ПК — location.host. */
  async connect(auth: Auth, hosts: string[]): Promise<void> {
    this.auth = auth
    this.hosts = hosts
    this.closedByUs = false
    clearTimeout(this.retryTimer)
    await this.attempt()
  }

  disconnect() {
    this.closedByUs = true
    clearTimeout(this.retryTimer)
    clearInterval(this.pingTimer)
    this.ws?.close()
    this.ws = null
    this.status.value = 'idle'
  }

  /** Вернулись в приложение или сеть ожила — переподключаемся сразу, без ожидания. */
  wake() {
    if (this.auth && !this.closedByUs && this.status.value !== 'online' && this.status.value !== 'connecting') {
      clearTimeout(this.retryTimer)
      this.retry = 0
      void this.attempt().catch(() => {})
    }
  }

  private async attempt(): Promise<void> {
    const auth = this.auth!
    this.status.value = 'connecting'
    try {
      let host = this.hosts[0]
      if (this.hosts.length > 1 || auth.kind === 'device') {
        const port = auth.kind === 'device' ? auth.saved.port : 47800
        host = await probe(this.hosts, port, auth.kind === 'device' ? auth.saved.pc : undefined)
      }
      await this.handshake(auth, host)
      this.retry = 0
      this.error.value = null
    } catch (e) {
      this.status.value = 'offline'
      const code = e instanceof AuthError ? e.code : (e as Error).message
      this.error.value = code
      // ошибки входа не лечатся повтором: нужен новый QR/PIN или ключ отозван
      if (e instanceof AuthError) {
        if (auth.kind === 'device' && (code === 'unknown-device' || code === 'bad-auth' || code === 'revoked')) forgetPc(auth.saved.pc)
        this.auth = auth.kind === 'device' && code !== 'unknown-device' && code !== 'revoked' ? auth : null
        throw e
      }
      this.scheduleRetry()
      throw e
    }
  }

  private scheduleRetry() {
    if (this.closedByUs || !this.auth || this.auth.kind === 'qr' || this.auth.kind === 'pin') return
    const delay = Math.min(5000, 400 * 2 ** this.retry++)
    this.retryTimer = window.setTimeout(() => void this.attempt().catch(() => {}), delay)
  }

  private async handshake(auth: Auth, host: string) {
    const ws = new WebSocket(`ws://${host}/ws`)
    ws.binaryType = 'arraybuffer'
    await opened(ws, 4000)
    const nc = random(16)
    let chan: Channel | null = null
    let pc: any
    try {
      if (auth.kind === 'admin') {
        ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'admin', token: auth.token }))
        const w = await nextJson(ws)
        if (w.t !== 'welcome') throw new AuthError(w.code || 'protocol')
        pc = w.pc
      } else if (auth.kind === 'device') {
        const dk = unb64(auth.saved.key)
        ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'remote', device: auth.saved.device, nonce: b64(nc), name: deviceName() }))
        const ch = await nextJson(ws)
        if (ch.t !== 'challenge') throw new AuthError(ch.code || 'protocol')
        const ns = unb64(ch.nonce)
        ws.send(JSON.stringify({ t: 'auth', mac: b64(authMac(dk, 'c', nc, ns)) }))
        const w = await nextJson(ws)
        if (w.t !== 'welcome') throw new AuthError(w.code || 'protocol')
        if (!ctEq(unb64(w.mac), authMac(dk, 's', nc, ns))) throw new AuthError('server-proof')
        chan = new Channel(dk, nc, ns)
        pc = w.pc
        this.perms.value = w.perms
        this.remember({ ...auth.saved, hosts: mergeHosts(host, auth.saved.hosts), name: pc.name, at: Date.now() })
      } else {
        const keys = new PairKeys()
        ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'remote', pair: auth.kind, pub: b64(keys.public), nonce: b64(nc), name: deviceName() }))
        const ch = await nextJson(ws)
        if (ch.t !== 'pair-challenge') throw new AuthError(ch.code || 'protocol')
        const pubS = unb64(ch.pub), ns = unb64(ch.nonce)
        const z = keys.shared(pubS)
        const t = pairTranscript(keys.public, pubS, nc, ns)
        const secret = auth.kind === 'pin' ? utf8(auth.pin) : unb64(auth.secret)
        ws.send(JSON.stringify({ t: 'pair-proof', mac: b64(pairMac(secret, 'c', t, z)) }))
        const r = await nextJson(ws)
        if (r.t !== 'paired') throw new AuthError(r.code || 'protocol')
        if (!ctEq(unb64(r.mac), pairMac(secret, 's', t, z))) throw new AuthError('server-proof')
        const dk = deviceKey(z, secret, t)
        chan = new Channel(dk, nc, ns)
        pc = r.pc
        this.perms.value = r.perms
        const saved: SavedPc = { pc: pc.id, name: pc.name, device: r.device, key: b64(dk), hosts: mergeHosts(host, this.hosts), port: Number(host.split(':')[1] || 47800), at: Date.now() }
        this.remember(saved)
        // дальше переподключаемся уже по ключу устройства
        this.auth = { kind: 'device', saved }
      }
    } catch (e) {
      ws.close()
      throw e
    }
    this.ws?.close()
    this.ws = ws
    this.chan = chan
    this.host.value = host
    this.pcName.value = pc?.name || ''
    this.pcId.value = pc?.id || ''
    ws.onmessage = (e) => this.onMessage(e)
    ws.onclose = () => this.onClose(ws)
    ws.onerror = () => {}
    this.status.value = 'online'
    clearInterval(this.pingTimer)
    this.pingTimer = window.setInterval(() => this.ping(), 2000)
    this.ping()
  }

  private remember(p: SavedPc) {
    saveSaved([p, ...loadSaved().filter((x) => x.pc !== p.pc)])
  }

  private onClose(ws: WebSocket) {
    if (ws !== this.ws) return
    this.ws = null
    clearInterval(this.pingTimer)
    if (this.closedByUs) return
    this.status.value = 'offline'
    this.scheduleRetry()
  }

  private onMessage(e: MessageEvent) {
    let data: Uint8Array
    if (typeof e.data === 'string') data = utf8(e.data)
    else {
      const raw = new Uint8Array(e.data as ArrayBuffer)
      const p = this.chan ? this.chan.open(raw) : raw
      if (!p) return
      data = p
    }
    if (data[0] === OP.PING) {
      const t = new DataView(data.buffer, data.byteOffset).getUint32(1, true)
      const w = this.waiters.get(t)
      if (w) { w(); return }
      const sent = this.pings.get(t)
      if (sent !== undefined) {
        this.pings.delete(t)
        const ms = Math.round(performance.now() - sent)
        this.rtt.value = ms
        if (Date.now() - this.lastRttReport > 5000 && this.auth?.kind !== 'admin') {
          this.lastRttReport = Date.now()
          this.json({ t: 'rtt', ms })
        }
      }
      return
    }
    if (data[0] !== 0x7b) return
    const m = JSON.parse(new TextDecoder().decode(data))
    switch (m.t) {
      case 'snapshot':
        for (const [k, v] of Object.entries(m.v)) this.get(k).value = v
        break
      case 'state':
        this.get(m.k).value = m.v
        break
      case 'perms':
        this.perms.value = m.v
        break
      case 'error':
        if (m.code === 'revoked' && this.auth?.kind === 'device') {
          forgetPc(this.auth.saved.pc)
          this.auth = null
          this.closedByUs = true
          this.status.value = 'offline'
          this.error.value = 'revoked'
        }
        this.emit('error', m)
        break
      default:
        this.emit(m.t, m)
    }
    this.emit('*', m)
  }

  private ping() {
    const t = Math.floor(performance.now()) >>> 0
    this.pings.set(t, performance.now())
    if (this.pings.size > 10) this.pings.delete(this.pings.keys().next().value!)
    this.raw(pingFrame(t))
  }

  /** Замер задержки: `n` пингов подряд через тот же шифрованный канал, мс. */
  async measure(n = 100): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < n && this.online; i++) {
      const t = (Math.floor(performance.now() * 1000) + i) >>> 0
      const sent = performance.now()
      const got = new Promise<void>((res) => this.waiters.set(t, res))
      this.raw(pingFrame(t))
      await Promise.race([got, new Promise((r) => setTimeout(r, 1000))])
      this.waiters.delete(t)
      out.push(performance.now() - sent)
    }
    return out
  }

  get online() { return this.status.value === 'online' && !!this.ws }

  /** Отправить бинарный кадр (шифруется, если канал есть). */
  raw(b: Uint8Array): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(this.chan ? this.chan.seal(b) : b)
    return true
  }

  json(v: unknown): boolean {
    const b = utf8(JSON.stringify(v))
    if (!this.chan && this.ws?.readyState === WebSocket.OPEN) { this.ws.send(new TextDecoder().decode(b)); return true }
    return this.raw(b)
  }

  /** Движение курсора в пикселях (дробные копятся). Если сеть не успевает — склеиваем. */
  move(dx: number, dy: number) {
    this.pendX += dx * 4
    this.pendY += dy * 4
    if (this.flushTimer) return
    // все движения одного события (coalesced) уходят одним кадром; если сеть не успевает — чуть позже
    this.flushTimer = -1
    queueMicrotask(() => {
      if ((this.ws?.bufferedAmount ?? 0) > 2048) {
        this.flushTimer = window.setTimeout(() => { this.flushTimer = 0; this.flushMove() }, 6)
        return
      }
      this.flushTimer = 0
      this.flushMove()
    })
  }

  private flushMove() {
    const qx = Math.trunc(this.pendX), qy = Math.trunc(this.pendY)
    if (!qx && !qy) return
    const cx = Math.max(-32767, Math.min(32767, qx)), cy = Math.max(-32767, Math.min(32767, qy))
    this.pendX -= cx; this.pendY -= cy
    this.raw(moveFrame(cx, cy))
  }

  scroll(v: number, h: number) {
    if (Math.abs(v) < 0.5 && Math.abs(h) < 0.5) return
    this.raw(scrollFrame(v, h))
  }

  /** Ждём ответ определённого типа (билет на загрузку и т. п.). */
  once(type: string, pred: (m: any) => boolean = () => true, ms = 8000): Promise<any> {
    return new Promise((res, rej) => {
      const off = this.on(type, (m) => { if (pred(m)) { off(); clearTimeout(t); res(m) } })
      const t = setTimeout(() => { off(); rej(new Error('timeout')) }, ms)
    })
  }
}

function mergeHosts(first: string, rest: string[]): string[] {
  return [first, ...rest.filter((h) => h !== first)].slice(0, 6)
}

/** Разбор ссылки из QR: http://ip:port/#pair=…&pc=…&h=ip1,ip2&n=имя */
export function parsePairUrl(url: string): { secret: string; pc: string; hosts: string[]; port: number; name: string } | null {
  try {
    const u = new URL(url)
    const q = new URLSearchParams(u.hash.slice(1))
    const secret = q.get('pair')
    if (!secret) return null
    const port = Number(u.port || 80)
    const hosts = [u.host, ...(q.get('h') || '').split(',').filter(Boolean).map((h) => `${h}:${port}`)]
    return { secret, pc: q.get('pc') || '', hosts: [...new Set(hosts)], port, name: q.get('n') || '' }
  } catch { return null }
}
