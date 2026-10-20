// Соединение с ПК: вход (сопряжение или ключ устройства), шифрованный канал, состояние, переподключение.
//
// Пути до ПК (в порядке предпочтения, с перекрывающимся стартом — кто первым ответит):
//   1. локальная сеть — WebSocket напрямую;
//   2. ретранслятор — когда телефон и ПК в разных сетях (мобильный интернет, другой Wi-Fi);
//   3. Bluetooth — без Wi-Fi и интернета (нативный мост Android).
// Поверх любого пути поднимается прямой WebRTC (UDP, сквозь NAT); движения идут по нему без очереди.
// Пока связь идёт через ретранслятор или Bluetooth, телефон проверяет локальную сеть и при первой
// возможности незаметно переходит на неё.

import { signal, type Signal } from '@preact/signals'
import { b64, random, unb64, utf8 } from './b64'
import { authMac, Channel, ctEq, deviceKey, PairKeys, pairMac, pairTranscript } from './crypto'
import { nextJson, relayPhoneUrl, wsPipe, type Pipe, type Via } from './pipe'
import { moveTFrame, OP, pingFrame, scrollFrame } from './proto'
import { RtcLink, rtcSupported, type IceServer, type SessionKeys } from './rtc'
import type { WolTarget } from './wol'

export type { Via } from './pipe'

export interface Perms { input: boolean; media: boolean; power: boolean; macros: boolean; clipboard: boolean; files: boolean; screen: boolean }

/** Как ещё можно добраться до ПК, кроме локальной сети. */
export interface Routes { relay?: { url: string; room: string } | null; bt?: string | null; ice?: IceServer[]; wol?: WolTarget[] }

/** Сопряжённый ПК, хранится на телефоне. */
export interface SavedPc { pc: string; name: string; device: string; key: string; hosts: string[]; port: number; at: number; routes?: Routes }

export type Auth =
  | { kind: 'device'; saved: SavedPc }
  | { kind: 'qr'; secret: string; name?: string; routes?: Routes }
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

/** Попытки с перекрывающимся стартом: следующая начинается, если предыдущая молчит `delay` мс.
 *  Побеждает первая удачная, остальные закрываются. */
async function race(tries: [number, () => Promise<Pipe>][]): Promise<Pipe> {
  if (!tries.length) throw new Error('no-route')
  return new Promise((res, rej) => {
    let won = false, left = tries.length, first: unknown = null
    for (const [delay, f] of tries) {
      setTimeout(() => {
        if (won) return
        f().then((p) => {
          if (won) { p.close(); return }
          won = true
          res(p)
        }, (e) => {
          first ??= e
          if (--left === 0 && !won) rej(first)
        })
      }, delay)
    }
  })
}

type Listener = (m: any) => void

export class Link {
  readonly status = signal<Status>('idle')
  readonly rtt = signal(0)
  readonly perms = signal<Perms | null>(null)
  readonly error = signal<string | null>(null)
  /** Где ПК: «ip:port» в сети, адрес ретранслятора или Bluetooth. */
  readonly host = signal<string>('')
  readonly via = signal<Via | null>(null)
  /** Поднят прямой канал WebRTC. */
  readonly p2p = signal(false)
  readonly pcName = signal<string>('')
  readonly pcId = signal<string>('')
  /** Открыть канал Bluetooth до ПК — задаёт нативная часть APK. */
  btOpener: ((addr: string) => Promise<Pipe>) | null = null

  private readonly keys = new Map<string, Signal<any>>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private pipe: Pipe | null = null
  private chan: Channel | null = null
  private session: SessionKeys | null = null
  private rtc: RtcLink | null = null
  private rtcRetry = 0
  private auth: Auth | null = null
  private hosts: string[] = []
  private retry = 0
  private retryTimer = 0
  private pingTimer = 0
  private lanTimer = 0
  private pings = new Map<number, number>()
  private waiters = new Map<number, () => void>()
  private lastRttReport = 0
  private closedByUs = false
  private switching = false
  // склейка движения, если сеть не успевает
  private pendX = 0
  private pendY = 0
  private pendT = 0
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

  /** Подключиться. `hosts` — «ip:port» кандидаты в локальной сети; для страницы с ПК — location.host. */
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
    clearInterval(this.lanTimer)
    this.rtc?.close()
    this.pipe?.close()
    this.pipe = null
    this.status.value = 'idle'
  }

  /** Вернулись в приложение или сеть ожила — переподключаемся сразу, без ожидания. */
  wake() {
    if (this.auth && !this.closedByUs && this.status.value !== 'online' && this.status.value !== 'connecting') {
      clearTimeout(this.retryTimer)
      this.retry = 0
      void this.attempt().catch(() => {})
    } else if (this.status.value === 'online' && this.via.value !== 'lan') void this.tryLan()
  }

  private routes(): Routes | undefined {
    const a = this.auth
    return a?.kind === 'device' ? a.saved.routes : a?.kind === 'qr' ? a.routes : undefined
  }

  /** Все пути до ПК для текущего входа. */
  private tries(): [number, () => Promise<Pipe>][] {
    const auth = this.auth!
    const out: [number, () => Promise<Pipe>][] = []
    if (this.hosts.length) {
      out.push([0, async () => {
        let host = this.hosts[0]
        if (this.hosts.length > 1 || auth.kind === 'device') {
          const port = auth.kind === 'device' ? auth.saved.port : 47800
          host = await probe(this.hosts, port, auth.kind === 'device' ? auth.saved.pc : undefined)
        }
        return wsPipe(`ws://${host}/ws`, 'lan', host)
      }])
    }
    // PIN и дашборд — только в локальной сети: короткий PIN нельзя доверять чужому серверу
    if (auth.kind === 'device' || auth.kind === 'qr') {
      const r = this.routes()
      if (r?.relay?.url && r.relay.room) {
        const relay = r.relay
        out.push([this.hosts.length ? 900 : 0, () => wsPipe(relayPhoneUrl(relay.url, relay.room), 'relay', new URL(relayPhoneUrl(relay.url, relay.room)).host, 6000)])
      }
      if (r?.bt && this.btOpener) {
        const open = this.btOpener, addr = r.bt
        out.push([this.hosts.length ? 1800 : 0, () => open(addr)])
      }
    }
    return out
  }

  private async attempt(): Promise<void> {
    const auth = this.auth!
    this.status.value = 'connecting'
    try {
      const pipe = await race(this.tries())
      await this.handshake(auth, pipe)
      this.retry = 0
      this.error.value = null
    } catch (e) {
      this.status.value = 'offline'
      const code = e instanceof AuthError ? e.code : e instanceof AggregateError ? 'unreachable' : (e as Error).message || 'unreachable'
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

  /** Связь через ретранслятор или Bluetooth, а ПК снова виден в сети — переходим без разрыва. */
  private async tryLan() {
    const auth = this.auth
    if (this.switching || auth?.kind !== 'device' || this.via.value === 'lan' || !this.hosts.length) return
    this.switching = true
    try {
      const host = await probe(this.hosts, auth.saved.port, auth.saved.pc, 1500)
      const pipe = await wsPipe(`ws://${host}/ws`, 'lan', host, 2500)
      await this.handshake(this.auth as Auth, pipe)
    } catch { /* сети по-прежнему нет */ } finally { this.switching = false }
  }

  private async handshake(auth: Auth, pipe: Pipe) {
    const nc = random(16)
    let chan: Channel | null = null
    let keys: SessionKeys | null = null
    let pc: any
    try {
      if (auth.kind === 'admin') {
        pipe.send(JSON.stringify({ t: 'hello', v: 1, role: 'admin', token: auth.token }))
        const w = await nextJson(pipe)
        if (w.t !== 'welcome') throw new AuthError(w.code || 'protocol')
        pc = w.pc
      } else if (auth.kind === 'device') {
        const dk = unb64(auth.saved.key)
        pipe.send(JSON.stringify({ t: 'hello', v: 1, role: 'remote', device: auth.saved.device, nonce: b64(nc), name: deviceName() }))
        const ch = await nextJson(pipe)
        if (ch.t !== 'challenge') throw new AuthError(ch.code || 'protocol')
        const ns = unb64(ch.nonce)
        pipe.send(JSON.stringify({ t: 'auth', mac: b64(authMac(dk, 'c', nc, ns)) }))
        const w = await nextJson(pipe)
        if (w.t !== 'welcome') throw new AuthError(w.code || 'protocol')
        if (!ctEq(unb64(w.mac), authMac(dk, 's', nc, ns))) throw new AuthError('server-proof')
        chan = new Channel(dk, nc, ns)
        keys = { dk, nc, ns }
        pc = w.pc
        this.perms.value = w.perms
        const hosts = pipe.via === 'lan' ? mergeHosts(pipe.where, auth.saved.hosts) : auth.saved.hosts
        this.remember({ ...auth.saved, hosts, name: pc.name, at: Date.now() })
      } else {
        const pk = new PairKeys()
        pipe.send(JSON.stringify({ t: 'hello', v: 1, role: 'remote', pair: auth.kind, pub: b64(pk.public), nonce: b64(nc), name: deviceName() }))
        const ch = await nextJson(pipe)
        if (ch.t !== 'pair-challenge') throw new AuthError(ch.code || 'protocol')
        const pubS = unb64(ch.pub), ns = unb64(ch.nonce)
        const z = pk.shared(pubS)
        const t = pairTranscript(pk.public, pubS, nc, ns)
        const secret = auth.kind === 'pin' ? utf8(auth.pin) : unb64(auth.secret)
        pipe.send(JSON.stringify({ t: 'pair-proof', mac: b64(pairMac(secret, 'c', t, z)) }))
        const r = await nextJson(pipe)
        if (r.t !== 'paired') throw new AuthError(r.code || 'protocol')
        if (!ctEq(unb64(r.mac), pairMac(secret, 's', t, z))) throw new AuthError('server-proof')
        const dk = deviceKey(z, secret, t)
        chan = new Channel(dk, nc, ns)
        keys = { dk, nc, ns }
        pc = r.pc
        this.perms.value = r.perms
        const port = pipe.via === 'lan' ? Number(pipe.where.split(':')[1] || 47800) : 47800
        const hosts = pipe.via === 'lan' ? mergeHosts(pipe.where, this.hosts) : this.hosts
        const saved: SavedPc = { pc: pc.id, name: pc.name, device: r.device, key: b64(dk), hosts, port, at: Date.now(), routes: auth.kind === 'qr' ? auth.routes : undefined }
        this.remember(saved)
        // дальше переподключаемся уже по ключу устройства
        this.auth = { kind: 'device', saved }
      }
    } catch (e) {
      pipe.close()
      throw e
    }
    // новый путь готов — старый закрываем (переход с ретранслятора на локальную сеть и т. п.)
    const old = this.pipe
    this.pipe = pipe
    old?.close()
    this.rtc?.close()
    this.rtc = null
    this.rtcRetry = 0
    this.chan = chan
    this.session = keys
    this.host.value = pipe.where
    this.via.value = pipe.via
    this.pcName.value = pc?.name || ''
    this.pcId.value = pc?.id || ''
    pipe.onmessage = (d) => this.onPipe(d)
    pipe.onclose = () => this.onClose(pipe)
    this.status.value = 'online'
    clearInterval(this.pingTimer)
    this.pingTimer = window.setInterval(() => this.ping(), 2000)
    this.ping()
    clearInterval(this.lanTimer)
    if (pipe.via !== 'lan') this.lanTimer = window.setInterval(() => void this.tryLan(), 15_000)
  }

  private remember(p: SavedPc) {
    saveSaved([p, ...loadSaved().filter((x) => x.pc !== p.pc)])
  }

  /** ПК сообщил актуальные маршруты — запоминаем: пригодятся, когда сеть сменится. */
  private learnRoutes(r: any) {
    const a = this.auth
    if (a?.kind !== 'device' || !r) return
    const port = Number(r.port) || a.saved.port
    const lan: string[] = Array.isArray(r.lan) ? r.lan.map((ip: string) => `${ip}:${port}`) : []
    const wol: WolTarget[] = Array.isArray(r.wol) ? r.wol.filter((w: any) => typeof w?.mac === 'string') : []
    const routes: Routes = { relay: r.relay || null, bt: typeof r.bt === 'string' ? r.bt : null, ice: Array.isArray(r.ice) ? r.ice : [], wol: wol.length ? wol : a.saved.routes?.wol }
    const hosts = [...new Set([...(this.via.value === 'lan' ? [this.host.value] : []), ...lan, ...a.saved.hosts])].slice(0, 8)
    const saved = { ...a.saved, hosts, port, routes }
    a.saved = saved
    this.hosts = [...new Set([...this.hosts, ...lan])]
    this.remember(saved)
  }

  private onClose(pipe: Pipe) {
    if (pipe !== this.pipe) return
    this.pipe = null
    this.rtc?.close()
    this.rtc = null
    clearInterval(this.pingTimer)
    clearInterval(this.lanTimer)
    if (this.closedByUs) return
    this.status.value = 'offline'
    this.scheduleRetry()
  }

  private onPipe(d: string | Uint8Array) {
    if (typeof d === 'string') { this.onPlain(utf8(d)); return }
    const p = this.chan ? this.chan.open(d) : d
    if (p) this.onPlain(p)
  }

  private onPlain(data: Uint8Array) {
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
    if (data[0] !== 0x7b) { this.emit('bin', data); return }
    const m = JSON.parse(new TextDecoder().decode(data))
    switch (m.t) {
      case 'snapshot':
        for (const [k, v] of Object.entries(m.v)) this.get(k).value = v
        if (m.v.routes) this.learnRoutes(m.v.routes)
        this.upgrade()
        break
      case 'state':
        this.get(m.k).value = m.v
        if (m.k === 'routes') this.learnRoutes(m.v)
        break
      case 'perms':
        this.perms.value = m.v
        break
      case 'rtc-answer': case 'rtc-ice': case 'rtc-failed':
        void this.rtc?.onSignal(m)
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

  /** Прямой канал WebRTC поверх открытой сессии. Не вышло — всё работает по основному пути. */
  private upgrade() {
    if (this.rtc || !this.session || !rtcSupported() || this.auth?.kind !== 'device') return
    const ice = (this.routes()?.ice || []).filter((s) => s.urls?.length)
    const rtc = new RtcLink(this.session, ice, (m) => this.jsonPipe(m), (p) => this.onPlain(p), (open) => {
      if (this.rtc !== rtc) return
      this.p2p.value = open
      if (open) { this.rtcRetry = 0; this.ping(); return }
      this.rtc = null
      // пропал или не поднялся — повторим позже, пока сессия жива
      if (this.pipe && this.rtcRetry < 3) setTimeout(() => { if (this.status.value === 'online') this.upgrade() }, 10_000 * 2 ** this.rtcRetry++)
    })
    this.rtc = rtc
    void rtc.start().catch(() => rtc.close())
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

  get online() { return this.status.value === 'online' && !!this.pipe }

  /** Сохранённый ПК, к которому подключаемся (для Wake-on-LAN, когда он выключен). */
  get savedPc(): SavedPc | null { return this.auth?.kind === 'device' ? this.auth.saved : null }

  /** Сколько байт ждёт отправки основным путём — по нему видео решает, пропускать ли кадры. */
  get backlog(): number { return this.pipe?.buffered() ?? 0 }

  private sealPipe(b: Uint8Array): boolean {
    const p = this.pipe
    if (!p) return false
    return p.send(this.chan ? this.chan.seal(b) : b)
  }

  /** Отправить бинарный кадр надёжно: по WebRTC «ctl», если он открыт, иначе основным путём. */
  raw(b: Uint8Array): boolean {
    if (this.rtc?.sendCtl(b)) return true
    return this.sealPipe(b)
  }

  /** Крупные кадры и потоки, где важен порядок (видео экрана), — всегда основным путём. */
  bulk(b: Uint8Array): boolean {
    return this.sealPipe(b)
  }

  json(v: unknown): boolean {
    const b = utf8(JSON.stringify(v))
    if (!this.chan && this.pipe) return this.pipe.send(new TextDecoder().decode(b))
    return this.raw(b)
  }

  /** Сигналинг WebRTC — только основным путём. */
  private jsonPipe(v: unknown): boolean {
    return this.sealPipe(utf8(JSON.stringify(v)))
  }

  /** Сколько можно потерять, но нельзя задержать: движение. Очередь полна — склеиваем со следующим. */
  private congested(): boolean {
    if (this.rtc?.open) return this.rtc.fastBusy()
    return (this.pipe?.buffered() ?? 0) > 2048
  }

  /** Движение курсора в пикселях (дробные копятся); `t` — время касания для плавного проигрывания на ПК. */
  move(dx: number, dy: number, t: number = performance.now()) {
    this.pendX += dx * 4
    this.pendY += dy * 4
    this.pendT = t
    if (this.flushTimer) return
    // все движения одного события (coalesced) уходят одним кадром; если сеть не успевает — чуть позже
    this.flushTimer = -1
    queueMicrotask(() => this.flushMove())
  }

  private flushMove() {
    if (this.congested()) {
      this.flushTimer = window.setTimeout(() => this.flushMove(), 6)
      return
    }
    this.flushTimer = 0
    const qx = Math.trunc(this.pendX), qy = Math.trunc(this.pendY)
    if (!qx && !qy) return
    const cx = Math.max(-32767, Math.min(32767, qx)), cy = Math.max(-32767, Math.min(32767, qy))
    this.pendX -= cx; this.pendY -= cy
    const f = moveTFrame(cx, cy, this.pendT)
    if (!this.rtc?.sendFast(f)) this.sealPipe(f)
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
  return [first, ...rest.filter((h) => h !== first)].slice(0, 8)
}

export interface PairLink { secret: string; pc: string; hosts: string[]; port: number; name: string; routes: Routes; go: string }

/** Разбор ссылки из QR (v2): http://ip:port/#v=2&pair=…&pc=…&h=ip1,ip2&p=порт&n=имя&r=ретранслятор&rm=комната&bt=адрес */
export function parsePairUrl(url: string): PairLink | null {
  try {
    const u = new URL(url)
    const q = new URLSearchParams(u.hash.slice(1))
    const secret = q.get('pair')
    if (!secret) return null
    const port = Number(q.get('p') || u.port || 80)
    const own = u.protocol === 'http:' && u.hostname ? [`${u.hostname}:${u.port || 80}`] : []
    const hosts = [...own, ...(q.get('h') || '').split(',').filter(Boolean).map((h) => `${h}:${port}`)]
    const relay = q.get('r') && q.get('rm') ? { url: q.get('r')!, room: q.get('rm')! } : null
    const bt = q.get('bt')
    return { secret, pc: q.get('pc') || '', hosts: [...new Set(hosts)], port, name: q.get('n') || '', routes: { relay, bt: bt && bt !== '1' ? bt : null }, go: q.get('go') || '' }
  } catch { return null }
}

/** Вход по отсканированному QR: знакомый ПК — сразу по ключу устройства (без нового сопряжения),
 *  новый — сопряжение по секрету из QR. Маршруты из QR дополняют сохранённые. */
export function pairAuth(p: PairLink, extraHosts: string[] = []): { auth: Auth; hosts: string[] } {
  const known = p.pc ? loadSaved().find((s) => s.pc === p.pc) : undefined
  const hosts = [...new Set([...extraHosts, ...p.hosts, ...(known?.hosts || [])])]
  if (known) {
    const routes: Routes = { ...known.routes, relay: p.routes.relay || known.routes?.relay, bt: p.routes.bt || known.routes?.bt }
    return { auth: { kind: 'device', saved: { ...known, routes } }, hosts }
  }
  return { auth: { kind: 'qr', secret: p.secret, routes: p.routes }, hosts }
}
