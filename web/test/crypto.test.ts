import { describe, expect, it } from 'vitest'
import { hex, random, utf8 } from '../src/lib/b64'
import { authMac, Channel, deviceKey, PairKeys, pairMac, pairTranscript } from '../src/lib/crypto'

// Те же входы и ожидания, что в crates/dotlink-core/src/crypto.rs (tests::vectors)
describe('совместимость с ядром на Rust', () => {
  it('векторы', () => {
    const c = new PairKeys(new Uint8Array(32).fill(1))
    const s = new PairKeys(new Uint8Array(32).fill(2))
    const nc = new Uint8Array(16).fill(3), ns = new Uint8Array(16).fill(4)
    const z = c.shared(s.public)
    expect(hex(z)).toBe(hex(s.shared(c.public)))
    const t = pairTranscript(c.public, s.public, nc, ns)
    const mac = pairMac(utf8('123456'), 'c', t, z)
    const dk = deviceKey(z, utf8('123456'), t)
    const auth = authMac(dk, 'c', nc, ns)
    const frame = new Channel(dk, nc, ns).seal(new Uint8Array([1, 2, 0, 3, 0]))
    expect(hex(c.public)).toBe('a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209')
    expect(hex(z)).toBe('2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953')
    expect(hex(mac)).toBe('e3494d46008963da74b41d9f576c2d3aab2b17c698015fdfa9196cd209718471')
    expect(hex(dk)).toBe('14bf51f0058e34ced8e9811ee1194801fc34c9d79111a6dbb6139d0621ded049')
    expect(hex(auth)).toBe('b0244b6bac8fcd2e61ed69003987799e2f7f37a6a084fa52ee4502295cc95e21')
    expect(hex(frame)).toBe('0100000000000000e318bcf24df085aa8e046f583b812bd470eda7ab5d')
  })

  it('канал: туда-обратно, повтор и подделка', () => {
    const dk = random(32), nc = random(16), ns = random(16)
    const c = new Channel(dk, nc, ns), s = new Channel(dk, nc, ns, true)
    const f1 = c.seal(utf8('move'))
    expect(new TextDecoder().decode(s.open(f1)!)).toBe('move')
    expect(s.open(f1)).toBeNull()
    const back = s.seal(utf8('state'))
    expect(new TextDecoder().decode(c.open(back)!)).toBe('state')
    const bad = c.seal(utf8('x')); bad[bad.length - 1] ^= 1
    expect(s.open(bad)).toBeNull()
  })
})
