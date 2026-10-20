import { describe, expect, it, vi } from 'vitest'
import { ScreenGestures, type Rect } from '../src/lib/screengest'

function setup() {
  const log: string[] = []
  let view: Rect = { x: 0, y: 0, w: 0, h: 0 }
  let wheel = 0
  const g = new ScreenGestures({
    pointer: (x, y, a) => log.push(`${a}@${x.toFixed(2)},${y.toFixed(2)}`),
    scroll: (v) => { wheel += v },
    view: (r) => { view = r },
  })
  // область 400×300, кадр 16:9 → картинка 400×225 по центру
  g.layout(400, 300, 1600, 900)
  return { g, log, view: () => view, wheel: () => wheel }
}

describe('жесты по экрану ПК', () => {
  it('картинка вписывается целиком и по центру', () => {
    const s = setup()
    expect(s.view()).toEqual({ x: 0, y: 37.5, w: 400, h: 225 })
  })

  it('касание — клик в той же точке кадра', () => {
    const s = setup()
    s.g.down(1, 100, 37.5 + 225 / 2); s.g.up(1)
    expect(s.log).toEqual(['click@0.25,0.50'])
  })

  it('удержание — правый клик, без левого', () => {
    vi.useFakeTimers()
    const s = setup()
    s.g.down(1, 200, 150)
    vi.advanceTimersByTime(600)
    s.g.up(1)
    expect(s.log).toEqual(['right@0.50,0.50'])
    vi.useRealTimers()
  })

  it('касание и провести — перетаскивание: нажать в начале, отпустить в конце', () => {
    const s = setup()
    s.g.down(1, 100, 100); s.g.move(1, 150, 100); s.g.move(1, 300, 100); s.g.up(1)
    expect(s.log[0]).toMatch(/^down@0\.25/)
    expect(s.log.at(-1)).toMatch(/^up@0\.75/)
    expect(s.log.filter((l) => l.startsWith('move')).length).toBe(2)
  })

  it('щипок увеличивает вокруг пальцев, после — сдвиг двумя пальцами, ПК ничего не получает', () => {
    const s = setup()
    s.g.down(1, 150, 150); s.g.down(2, 250, 150)
    s.g.move(1, 100, 150); s.g.move(2, 300, 150) // в 2 раза
    expect(s.view().w).toBeCloseTo(800)
    expect(s.g.zoomed).toBe(true)
    // точка под пальцами осталась на месте: середина кадра всё ещё в x=200
    expect(s.g.toFrame({ x: 200, y: 150 })[0]).toBeCloseTo(0.5)
    s.g.up(1); s.g.up(2)
    s.g.down(1, 150, 150); s.g.down(2, 250, 150)
    s.g.move(1, 100, 150); s.g.move(2, 200, 150)
    expect(s.g.toFrame({ x: 200, y: 150 })[0]).toBeGreaterThan(0.5)
    s.g.up(1); s.g.up(2)
    expect(s.log).toEqual([])
  })

  it('два пальца на неувеличенной картинке — колесо, палец вверх листает вниз', () => {
    const s = setup()
    s.g.down(1, 150, 250); s.g.down(2, 250, 250)
    for (let y = 245; y >= 130; y -= 5) { s.g.move(1, 150, y); s.g.move(2, 250, y) }
    s.g.up(1); s.g.up(2)
    expect(s.log[0]).toMatch(/^move@/) // курсор под пальцы перед прокруткой
    expect(s.wheel()).toBeLessThanOrEqual(-240)
  })

  it('увеличение не больше пяти раз и картинка не уезжает за край', () => {
    const s = setup()
    s.g.down(1, 199, 150); s.g.down(2, 201, 150)
    s.g.move(1, 0, 150); s.g.move(2, 400, 150)
    expect(s.view().w).toBeCloseTo(2000)
    expect(s.view().x).toBeLessThanOrEqual(0)
    expect(s.view().x + s.view().w).toBeGreaterThanOrEqual(400)
  })
})
