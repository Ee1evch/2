// Фильтр One Euro (Casiez и др., CHI 2012) для двумерной точки.
// Медленно — сильное сглаживание (дрожание пальца и сетка сенсора не видны), быстро — почти без
// задержки. Частота среза растёт со скоростью: fc = minCutoff + beta·|v|.
// Время — в мс (timeStamp событий), координаты — в любых единицах; частоты — в Гц.

const alpha = (cutoff: number, dtSec: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dtSec))

export class OneEuro2D {
  x = 0
  y = 0
  /** Сглаженная скорость, единиц в мс. */
  speed = 0
  private vx = 0
  private vy = 0
  private t = 0
  private started = false

  constructor(public minCutoff = 2.5, public beta = 0.03, public dCutoff = 5) {}

  reset(x: number, y: number, t: number) {
    this.x = x; this.y = y; this.t = t
    this.vx = this.vy = this.speed = 0
    this.started = true
  }

  filter(x: number, y: number, t: number): void {
    if (!this.started) { this.reset(x, y, t); return }
    // одинаковые и обратные отметки времени бывают у синтетических и склеенных событий
    const dt = Math.max(0.5, t - this.t) / 1000
    this.t = Math.max(this.t, t)
    const ad = alpha(this.dCutoff, dt)
    this.vx += ad * ((x - this.x) / dt - this.vx)
    this.vy += ad * ((y - this.y) / dt - this.vy)
    const v = Math.hypot(this.vx, this.vy) // единиц в секунду
    const a = alpha(this.minCutoff + this.beta * v, dt)
    this.x += a * (x - this.x)
    this.y += a * (y - this.y)
    this.speed = v / 1000
  }
}
