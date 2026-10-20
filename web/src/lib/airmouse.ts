// Аэромышь: телефон как лазерная указка. Поворот телефона влево-вправо (вокруг вертикали мира)
// ведёт курсор по горизонтали, наклон вверх-вниз — по вертикали. Вертикаль берём из гравитации,
// поэтому неважно, лежит телефон экраном вверх или его держат стоя, как пульт.
//
// rotationRate (DeviceMotionEvent): alpha — вокруг оси z (из экрана), beta — вокруг x (вправо),
// gamma — вокруг y (вверх по экрану), градусы в секунду.

import { OneEuro2D } from './oneeuro'

export interface Rate { alpha: number; beta: number; gamma: number }
export interface Vec3 { x: number; y: number; z: number }

/** Ниже этой скорости поворота — дрожание руки и дрейф гироскопа, курсор стоит. */
const DEAD = 1.2
/** Пикселей на градус: ~40° поворота проводят курсор через экран Full HD. */
export const PX_PER_DEG = 48

/** Скорость поворота (°/с) → смещение курсора (пиксели) за dt секунд. */
export function airDelta(r: Rate, g: Vec3, dt: number, k = PX_PER_DEG): [number, number] {
  const n = Math.hypot(g.x, g.y, g.z) || 1
  const gx = g.x / n, gy = g.y / n, gz = g.z / n
  // поворот вокруг вертикали мира — проекция угловой скорости на направление гравитации
  const yaw = r.beta * gx + r.gamma * gy + r.alpha * gz
  // наклон — вокруг оси x телефона (почти всегда горизонтальна, когда им указывают)
  const pitch = r.beta
  const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : v - Math.sign(v) * DEAD)
  return [-dz(yaw) * dt * k, -dz(pitch) * dt * k]
}

/** Поток событий движения → сглаженные смещения курсора. */
export class AirMouse {
  private last = 0
  private g: Vec3 = { x: 0, y: 0, z: 9.8 }
  private flt = new OneEuro2D(1.5, 0.004, 4)
  private fx = 0
  private fy = 0
  gain = 1

  constructor(private readonly move: (dx: number, dy: number, t: number) => void) {}

  reset() { this.last = 0 }

  feed(r: Rate | null, gravity: Vec3 | null, t: number) {
    if (gravity && Number.isFinite(gravity.x)) {
      // гравитация меняется медленно — сглаживаем, чтобы рывок руки не наклонял «вертикаль»
      this.g = { x: this.g.x * 0.8 + gravity.x * 0.2, y: this.g.y * 0.8 + gravity.y * 0.2, z: this.g.z * 0.8 + gravity.z * 0.2 }
    }
    if (!r || r.alpha == null) return
    if (!this.last) { this.last = t; this.flt.reset(this.fx, this.fy, t); return }
    const dt = Math.min(0.05, Math.max(0.001, (t - this.last) / 1000))
    this.last = t
    const [dx, dy] = airDelta(r, this.g, dt, PX_PER_DEG * this.gain)
    if (!dx && !dy) return
    // сглаживаем путь (дрожание руки), шлём приращения сглаженной точки
    const x0 = this.flt.x, y0 = this.flt.y
    this.fx += dx; this.fy += dy
    this.flt.filter(this.fx, this.fy, t)
    const mx = this.flt.x - x0, my = this.flt.y - y0
    if (Math.abs(mx) > 0.01 || Math.abs(my) > 0.01) this.move(mx, my, t)
  }
}
