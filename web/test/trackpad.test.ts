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
    const slow = s.moved().x
    s.pad.up(1)
    s.reset(); s.tick(500)
    s.pad.down(1, 0, 0)
    for (let i = 1; i <= 10; i++) { s.tick(16); s.pad.move(1, i * 20, 0) }
    const fast = s.moved().x
    s.pad.up(1)
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
})
