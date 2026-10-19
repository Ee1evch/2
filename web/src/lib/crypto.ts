// Зеркало crates/dotlink-core/src/crypto.rs. WebCrypto по http://192.168.x.x недоступен,
// поэтому используются @noble — чистый JS, проверенные реализации X25519, HKDF, HMAC и XChaCha20-Poly1305.
import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, random, utf8 } from './b64'

export const macOf = (key: Uint8Array, ...parts: Uint8Array[]) => hmac(sha256, key, concat(...parts))

export function ctEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

export class PairKeys {
  readonly public: Uint8Array
  constructor(private readonly secret: Uint8Array = random(32)) { this.public = x25519.getPublicKey(secret) }
  shared(peer: Uint8Array): Uint8Array { return x25519.getSharedSecret(this.secret, peer) }
}

export const pairTranscript = (pubC: Uint8Array, pubS: Uint8Array, nc: Uint8Array, ns: Uint8Array) => concat(utf8('dotlink/pair/v1'), pubC, pubS, nc, ns)

export function pairMac(secret: Uint8Array, who: 'c' | 's', transcript: Uint8Array, shared: Uint8Array): Uint8Array {
  const key = sha256(concat(utf8('dotlink/pair-key/v1'), secret))
  return macOf(key, utf8(who), transcript, shared)
}

export const deviceKey = (shared: Uint8Array, secret: Uint8Array, transcript: Uint8Array) => hkdf(sha256, concat(shared, secret), transcript, utf8('dotlink/device/v1'), 32)

export const authMac = (dk: Uint8Array, who: 'c' | 's', nc: Uint8Array, ns: Uint8Array) => macOf(dk, utf8('dotlink/auth/v1'), utf8(who), nc, ns)

/** Защищённый канал: 8 байт счётчика + шифртекст. Сторона телефона шифрует направлением c→s. */
export const LABEL_MAIN = 'dotlink/session/v1'
export const LABEL_RTC_CTL = 'dotlink/session/v1/rtc-ctl'
export const LABEL_RTC_FAST = 'dotlink/session/v1/rtc-fast'

/** Шифрованный канал. `lossy` — кадры могут теряться и приходить не по порядку (WebRTC «fast»):
 *  тогда вместо строгого счётчика — окно последних 64 номеров, повтор всё равно отвергается. */
export class Channel {
  private txCtr = 0n
  private rxCtr = 0n
  private window: bigint | null
  private readonly txKey: Uint8Array
  private readonly rxKey: Uint8Array
  private readonly txPrefix: Uint8Array
  private readonly rxPrefix: Uint8Array

  constructor(dk: Uint8Array, nc: Uint8Array, ns: Uint8Array, server = false, label = LABEL_MAIN, lossy = false) {
    const k = hkdf(sha256, dk, concat(nc, ns), utf8(label), 96)
    const c2s = k.slice(0, 32), s2c = k.slice(32, 64), pc2s = k.slice(64, 80), ps2c = k.slice(80, 96)
    this.txKey = server ? s2c : c2s
    this.rxKey = server ? c2s : s2c
    this.txPrefix = server ? ps2c : pc2s
    this.rxPrefix = server ? pc2s : ps2c
    this.window = lossy ? 0n : null
  }

  private static nonce(prefix: Uint8Array, ctr: bigint): Uint8Array {
    const n = new Uint8Array(24)
    n.set(prefix)
    new DataView(n.buffer).setBigUint64(16, ctr, true)
    return n
  }

  seal(plain: Uint8Array): Uint8Array {
    this.txCtr++
    const ct = xchacha20poly1305(this.txKey, Channel.nonce(this.txPrefix, this.txCtr)).encrypt(plain)
    const out = new Uint8Array(8 + ct.length)
    new DataView(out.buffer).setBigUint64(0, this.txCtr, true)
    out.set(ct, 8)
    return out
  }

  open(frame: Uint8Array): Uint8Array | null {
    if (frame.length < 24) return null
    const ctr = new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0, true)
    const w = this.window
    if (w === null) { if (ctr <= this.rxCtr) return null }
    else if (ctr <= this.rxCtr && (this.rxCtr - ctr >= 64n || (w & (1n << (this.rxCtr - ctr))) !== 0n)) return null
    let pt: Uint8Array
    try { pt = xchacha20poly1305(this.rxKey, Channel.nonce(this.rxPrefix, ctr)).decrypt(frame.subarray(8)) } catch { return null }
    if (w !== null) {
      if (ctr > this.rxCtr) {
        const shift = ctr - this.rxCtr
        this.window = ((shift >= 64n ? 0n : (w << shift) & 0xffffffffffffffffn)) | 1n
      } else this.window = w | (1n << (this.rxCtr - ctr))
    }
    if (ctr > this.rxCtr) this.rxCtr = ctr
    return pt
  }
}
