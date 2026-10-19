import { describe, expect, it, vi } from 'vitest'
import { Trackpad, type PadOut } from '../src/remote/trackpad'

function setup() {
  let t = 0
  const log: string[] = []
  let moved = { x: 0, y: 0 }, scrolled = { v: 0, h: 0 }
  const out: PadOut = {
    move: (dx, dy) => { moved.x += dx; moved.y += dy },
    scroll: (v, h) => { scrolled.v += v; scrolled.h += h },
    button: (b, a) => log.push(`${b}:${a}`),
    haptic: () => {},
  }
  const pad = new Trackpad(out, () => t)
  return { pad, log, tick: (ms: number) => { t += ms }, moved: () => moved, scrolled: () => scrolled, reset: () => { moved = { x: 0, y: 0 }; scrolled = { v: 0, h: 0 } } }
}

describe('тачпад', () => {
  it('тап — левый клик, два пальца — правый, три — средний', () => {
    const s = setup()
    s.pad.down(1, 100, 100); s.tick(80); s.pad.up(1)
    s.tick(400)
    s.pad.down(1, 100, 100); s.pad.down(2, 140, 100); s.tick(90); s.pad.up(1); s.pad.up(2)
    s.tick(400)
    s.pad.down(1, 100, 100); s.pad.down(2, 140, 100); s.pad.down(3, 180, 100); s.tick(90); s.pad.up(3); s.pad.up(2); s.pad.up(1)
    expect(s.log).toEqual(['left:click', 'right:click', 'middle:click'])
  })

  it('движение — курсор с ускорением, без клика', () => {
    const s = setup()
    s.pad.down(1, 0, 0)
    for (let i = 1; i <= 10; i++) { s.tick(16); s.pad.move(1, i * 2, 0) }
    s.pad.up(1)
    const slow = s.moved().x
    s.reset(); s.tick(500)
    s.pad.down(1, 0, 0)
    for (let i = 1; i <= 10; i++) { s.tick(16); s.pad.move(1, i * 20, 0) }
    s.pad.up(1)
    const fast = s.moved().x
    expect(s.log).toEqual([])
    expect(slow).toBeGreaterThan(0)
    // в 10 раз больший путь пальца даёт заметно больше, чем в 10 раз больший путь курсора
    expect(fast / slow).toBeGreaterThan(15)
  })

  it('тап, затем касание с движением — перетаскивание', () => {
    const s = setup()
    s.pad.down(1, 100, 100); s.tick(60); s.pad.up(1)
    s.tick(120)
    s.pad.down(1, 102, 101)
    for (let i = 1; i <= 5; i++) { s.tick(16); s.pad.move(1, 102 + i * 10, 101) }
    s.pad.up(1)
    expect(s.log).toEqual(['left:click', 'left:down', 'left:up'])
    expect(s.moved().x).toBeGreaterThan(0)
  })

  it('два пальца — прокрутка, курсор не двигается; естественное направление', () => {
    const s = setup()
    s.pad.down(1, 100, 300); s.pad.down(2, 160, 300)
    for (let i = 1; i <= 6; i++) { s.tick(16); s.pad.move(1, 100, 300 - i * 15); s.pad.move(2, 160, 300 - i * 15) }
    expect(s.moved()).toEqual({ x: 0, y: 0 })
    expect(s.scrolled().v).toBeLessThan(0) // палец вверх → страница вниз (колесо отрицательное)
  })

  it('долгое касание — правый клик', () => {
    vi.useFakeTimers()
    const s = setup()
    s.pad.down(1, 50, 50)
    vi.advanceTimersByTime(600)
    s.tick(600)
    s.pad.up(1)
    expect(s.log).toEqual(['right:click'])
    vi.useRealTimers()
  })

  it('сглаживание: дрожание пальца гасится, весь путь доходит до курсора', () => {
    const moves: { dx: number; t?: number }[] = []
    const pad = new Trackpad({ move: (dx, _dy, t) => moves.push({ dx, t }), scroll: () => {}, button: () => {}, haptic: () => {} }, () => 0)
    pad.prefs = { ...pad.prefs, accel: 0, speed: 1 }
    pad.down(1, 0, 0)
    // ровное движение 1 px/8 мс с шумом сенсора ±0.6 px
    let t = 0
    for (let i = 1; i <= 120; i++) { t += 8; pad.move(1, 12 + i + (i % 2 ? 0.6 : -0.6), 0, t) }
    pad.up(1)
    const total = moves.reduce((a, m) => a + m.dx, 0)
    expect(total).toBeCloseTo(131.4, 6) // ровно путь пальца: от 0 до последнего касания
    // шаги курсора ровнее касаний: без фильтра они бы чередовались 2.2 / −0.2 (разброс 2.4 px)
    const steady = moves.slice(40, 110).map((m) => m.dx)
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThan(2.4 / 3)
    expect(steady.every((d) => d > 0)).toBe(true)
    // время касания передаётся вместе с движением
    expect(moves[5].t).toBe(48)
  })
})
