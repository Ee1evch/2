// Прямой канал WebRTC поверх уже открытой сессии: в одной сети — по UDP напрямую,
// в разных сетях — через NAT (STUN), при жёстком NAT — через TURN, если он задан на ПК.
// Сигналинг (SDP, ICE) идёт внутри зашифрованной сессии; сами DataChannel шифруются ещё раз
// ключами этой сессии (DTLS — не единственная защита, а подмена ПК исключена входом по ключу).
// «ctl» — надёжный и упорядоченный, «fast» — без повторов и порядка, как UDP: потерянное движение
// не задерживает следующие, а ПК всё равно проигрывает путь по отметкам времени.

import { Channel, LABEL_RTC_CTL, LABEL_RTC_FAST } from './crypto'

export interface SessionKeys { dk: Uint8Array; nc: Uint8Array; ns: Uint8Array }
export interface IceServer { urls: string[]; username?: string; credential?: string }

/** Сообщения DataChannel на стороне ПК — до 16 КБ; крупнее идут основным каналом. */
export const MAX_DC = 16_000
const FAST_BUFFER = 4096

export class RtcLink {
  private pc: RTCPeerConnection | null
  private ctl: RTCDataChannel
  private fast: RTCDataChannel
  private readonly ctlChan: Channel
  private readonly fastChan: Channel
  private timer = 0
  open = false

  constructor(
    keys: SessionKeys,
    ice: IceServer[],
    private readonly signal: (m: object) => boolean,
    private readonly onMessage: (plain: Uint8Array, path: 'ctl' | 'fast') => void,
    private readonly onState: (open: boolean) => void,
  ) {
    this.ctlChan = new Channel(keys.dk, keys.nc, keys.ns, false, LABEL_RTC_CTL)
    this.fastChan = new Channel(keys.dk, keys.nc, keys.ns, false, LABEL_RTC_FAST, true)
    const pc = new RTCPeerConnection({ iceServers: ice.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })) })
    this.pc = pc
    this.ctl = pc.createDataChannel('ctl', { ordered: true })
    this.fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 })
    for (const [dc, path] of [[this.ctl, 'ctl'], [this.fast, 'fast']] as const) {
      dc.binaryType = 'arraybuffer'
      dc.onmessage = (e) => {
        const ch = path === 'ctl' ? this.ctlChan : this.fastChan
        const plain = ch.open(new Uint8Array(e.data as ArrayBuffer))
        if (plain) this.onMessage(plain, path)
      }
      dc.onclose = () => this.close()
    }
    this.ctl.onopen = () => { clearTimeout(this.timer); this.open = true; this.onState(true) }
    pc.onicecandidate = (e) => { if (e.candidate) this.signal({ t: 'rtc-ice', candidate: e.candidate.toJSON() }) }
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.close() }
    // не вышло за 15 с (симметричный NAT без TURN) — остаёмся на основном канале
    this.timer = window.setTimeout(() => { if (!this.open) this.close() }, 15_000)
  }

  async start() {
    const pc = this.pc
    if (!pc) return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.signal({ t: 'rtc-offer', sdp: { type: offer.type, sdp: offer.sdp } })
  }

  /** Ответ ПК и его кандидаты приходят по основному каналу. */
  async onSignal(m: any) {
    const pc = this.pc
    if (!pc) return
    try {
      if (m.t === 'rtc-answer') await pc.setRemoteDescription(m.sdp)
      else if (m.t === 'rtc-ice' && m.candidate?.candidate) await pc.addIceCandidate(m.candidate)
      else if (m.t === 'rtc-failed') this.close()
    } catch { this.close() }
  }

  /** Надёжно; `false` — канал не готов или кадр велик, пусть идёт основным путём. */
  sendCtl(plain: Uint8Array): boolean {
    if (!this.open || this.ctl.readyState !== 'open' || plain.length + 32 > MAX_DC) return false
    try { this.ctl.send(this.ctlChan.seal(plain) as Uint8Array<ArrayBuffer>); return true } catch { return false }
  }

  /** Как UDP. Если очередь растёт — кадр лучше склеить со следующим, чем ставить в очередь. */
  sendFast(plain: Uint8Array): boolean {
    if (!this.open || this.fast.readyState !== 'open') return false
    if (this.fast.bufferedAmount > FAST_BUFFER) return false
    try { this.fast.send(this.fastChan.seal(plain) as Uint8Array<ArrayBuffer>); return true } catch { return false }
  }

  fastBusy(): boolean { return this.open && this.fast.readyState === 'open' && this.fast.bufferedAmount > FAST_BUFFER }

  close() {
    clearTimeout(this.timer)
    const pc = this.pc
    if (!pc) return
    this.pc = null
    this.open = false
    try { pc.close() } catch { /* уже закрыт */ }
    this.onState(false)
  }
}

export const rtcSupported = () => typeof RTCPeerConnection === 'function'
