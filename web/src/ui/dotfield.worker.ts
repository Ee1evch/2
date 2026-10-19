// Поле точек в отдельном потоке: тысячи точек на кадр не отнимают время у касаний и сети.
import { createField, type FieldMsg, type Mode } from './dotfield-core'

type Init = { t: 'init'; canvas: OffscreenCanvas; mode: Mode; pitch: number }

const scope = self as unknown as { requestAnimationFrame?: (f: (t: number) => void) => number; onmessage: ((e: MessageEvent) => void) | null }
const raf = (f: (t: number) => void) => (scope.requestAnimationFrame ? scope.requestAnimationFrame(f) : setTimeout(() => f(performance.now()), 8))

let field: ReturnType<typeof createField> | null = null
const early: FieldMsg[] = []

scope.onmessage = (e: MessageEvent<Init | FieldMsg>) => {
  const m = e.data
  if (m.t === 'init') {
    field = createField(m.canvas, m.mode, m.pitch)
    for (const x of early.splice(0)) field.handle(x, performance.now())
    const loop = (now: number) => { field!.frame(now); raf(loop) }
    raf(loop)
    return
  }
  if (field) field.handle(m, performance.now())
  else early.push(m)
}
