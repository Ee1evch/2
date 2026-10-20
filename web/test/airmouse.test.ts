import { describe, expect, it } from 'vitest'
import { AirMouse, airDelta, PX_PER_DEG } from '../src/lib/airmouse'

const flat = { x: 0, y: 0, z: 9.8 } // экраном вверх
const upright = { x: 0, y: 9.8, z: 0 } // стоя, как пульт

describe('аэромышь', () => {
  it('телефон экраном вверх: поворот влево — курсор влево, наклон вверх — курсор вверх', () => {
    const [dx] = airDelta({ alpha: 30, beta: 0, gamma: 0 }, flat, 0.1)
    expect(dx).toBeLessThan(0)
    const [, dy] = airDelta({ alpha: 0, beta: 30, gamma: 0 }, flat, 0.1)
    expect(dy).toBeLessThan(0)
  })

  it('телефон стоя: тот же поворот влево даёт gamma — курсор тоже влево', () => {
    const [dx] = airDelta({ alpha: 0, beta: 0, gamma: 30 }, upright, 0.1)
    expect(dx).toBeLessThan(0)
    // а вращение вокруг оси экрана (alpha) стоя — это крен, не поворот: курсор не едет
    expect(airDelta({ alpha: 30, beta: 0, gamma: 0 }, upright, 0.1)[0]).toBeCloseTo(0)
  })

  it('дрожание руки и дрейф гироскопа не двигают курсор', () => {
    expect(airDelta({ alpha: 0.8, beta: -1, gamma: 0.5 }, flat, 0.1)).toEqual([-0, -0])
  })

  it('масштаб: 40° поворота — около 1900 пикселей', () => {
    const [dx] = airDelta({ alpha: -40 - 1.2, beta: 0, gamma: 0 }, flat, 1)
    expect(dx).toBeCloseTo(40 * PX_PER_DEG, 0)
  })

  it('поток событий: ровный поворот даёт ровные шаги без рывка в начале', () => {
    const steps: number[] = []
    const m = new AirMouse((dx) => steps.push(dx))
    for (let i = 0; i <= 120; i++) m.feed({ alpha: 20, beta: 0, gamma: 0 }, flat, i * 16)
    expect(steps.length).toBeGreaterThan(100)
    const total = steps.reduce((a, b) => a + b, 0)
    // 120 × 16 мс × (20 − 1.2)°/с × 48 px ≈ 1733 px влево; фильтр отстаёт не больше чем на 5%
    expect(total).toBeLessThan(-1733 * 0.95)
    expect(total).toBeGreaterThan(-1733 * 1.01)
    const mid = steps.slice(40, 110)
    expect(Math.max(...mid) - Math.min(...mid)).toBeLessThan(1)
  })
})
