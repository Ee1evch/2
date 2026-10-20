import { describe, expect, it } from 'vitest'
import { magicPacket, parseMac } from '../src/lib/wol'

describe('Wake-on-LAN', () => {
  it('MAC в любом написании', () => {
    expect([...parseMac('00:1A:7d-DA.71 13')!]).toEqual([0x00, 0x1a, 0x7d, 0xda, 0x71, 0x13])
    expect(parseMac('00:1A:7D')).toBeNull()
  })
  it('пакет: 6 × FF и 16 × MAC', () => {
    const p = magicPacket('AA:BB:CC:DD:EE:FF')!
    expect(p.length).toBe(102)
    expect([...p.subarray(0, 6)]).toEqual(Array(6).fill(0xff))
    for (let i = 0; i < 16; i++) expect([...p.subarray(6 + i * 6, 12 + i * 6)]).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
    expect(magicPacket('00:00:00:00:00:00')).toBeNull()
  })
})
