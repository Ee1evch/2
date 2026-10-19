import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { b45decode, b45encode } from '../src/lib/base45'
import { capacity, layout, pack, QrReceiver, QrSender, unpack } from '../src/lib/qrstream'

const wasm = readFileSync(fileURLToPath(new URL('../src/lib/wasm/fountain.wasm', import.meta.url)))

describe('Base45', () => {
  it('RFC 9285 и обратно', () => {
    expect(b45encode(new TextEncoder().encode('AB'))).toBe('BB8')
    expect(b45encode(new TextEncoder().encode('Hello!!'))).toBe('%69 VD92EX0')
    for (const n of [0, 1, 2, 3, 255, 1000]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 255)
      expect(b45decode(b45encode(b))).toEqual(b)
    }
    expect(b45decode('GGW')).toBeNull() // > 0xFFFF
    expect(b45decode('a')).toBeNull()
  })
})

describe('поток QR', () => {
  it('ёмкость растёт с версией', () => {
    expect(capacity(10)).toBeGreaterThan(200)
    expect(capacity(15)).toBeGreaterThan(capacity(10))
    expect(capacity(20)).toBeGreaterThan(capacity(15))
  })

  it('сетка подбирается под экран', () => {
    const l = layout(1920, 1080, 77, 4)
    expect(l.cols * l.rows).toBeGreaterThanOrEqual(6)
    expect(l.module).toBeGreaterThanOrEqual(4)
  })

  it('упаковка со сжатием и без', async () => {
    const text = new TextEncoder().encode('привет, '.repeat(500))
    const packed = await pack({ name: 'заметка.txt', type: 'text/plain', bytes: text })
    expect(packed.length).toBeLessThan(text.length / 4)
    const back = await unpack(packed)
    expect(back.name).toBe('заметка.txt')
    expect(back.bytes).toEqual(text)
    const jpg = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7919) & 255)
    expect((await unpack(await pack({ name: 'a.jpg', type: 'image/jpeg', bytes: jpg }))).bytes).toEqual(jpg)
  })

  it('файл собирается при потере 35% кадров и в случайном порядке', async () => {
    const bytes = Uint8Array.from({ length: 60_000 }, (_, i) => (i * 2654435761) >>> 24)
    const tx = await QrSender.create(await pack({ name: 'фото.jpg', type: 'image/jpeg', bytes }), 'fast', wasm)
    const rx = await QrReceiver.create(wasm)
    let done: any = null
    rx.onDone = (p) => { done = p }
    const frames: string[] = []
    for (let i = 0; i < tx.k * 2; i++) frames.push(tx.frame(i))
    // перемешиваем и теряем треть
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const shown = frames.filter(() => rnd() > 0.35).sort(() => rnd() - 0.5)
    let used = 0
    for (const f of shown) { rx.accept(f); used++; if (rx.result || done) break; await Promise.resolve() }
    for (let i = 0; i < 50 && !done; i++) await new Promise((r) => setTimeout(r, 5))
    expect(done.name).toBe('фото.jpg')
    expect(done.bytes).toEqual(bytes)
    expect(used).toBeLessThanOrEqual(tx.k + 3)
    expect(rx.accept(frames[0])).toBe(false)
    // каждый кадр помещается в QR выбранной версии
    expect(() => tx.matrix(frames[1])).not.toThrow()
  })
})
