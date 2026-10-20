// «Указка»: телефон в руке ведёт курсор, как лазерная указка (гироскоп), а крупные кнопки
// листают слайды. В приложении для Android слайды листают и кнопки громкости.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { DotDisplay, DotField, DotIcon, haptic, type DotFieldApi } from '../ui'
import { AirMouse } from '../lib/airmouse'
import { buttonFrame, keyFrame, VK } from '../lib/proto'
import { formatDuration } from '../lib/format'
import { isNative, onNative, setVolumeKeys } from './native'
import { link, prefs } from './state'
import { useTicker } from './Home'

const key = (vk: number) => { haptic('tap'); link.raw(keyFrame(vk)) }

export function Pointer() {
  const field = useRef<DotFieldApi | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const [laser, setLaser] = useState(false)
  const [sensor, setSensor] = useState<'wait' | 'ok' | 'none'>('wait')
  const [start, setStart] = useState<number | null>(null)
  const held = useRef({ on: false, at: 0, moved: 0 })
  useTicker(1000, start !== null)

  const air = useMemo(() => new AirMouse((dx, dy, t) => {
    held.current.moved += Math.abs(dx) + Math.abs(dy)
    link.move(dx, dy, t)
  }), [])
  useEffect(() => { air.gain = prefs.value.speed / 1.6 }, [prefs.value.speed])

  // датчик: события приходят — указка работает; нет за секунду — подсказываем, где она работает
  useEffect(() => {
    let seen = false
    const on = (e: DeviceMotionEvent) => {
      if (!seen && e.rotationRate?.alpha != null) { seen = true; setSensor('ok') }
      if (!held.current.on) return
      const r = e.rotationRate, g = e.accelerationIncludingGravity
      air.feed(r && r.alpha != null ? { alpha: r.alpha, beta: r.beta ?? 0, gamma: r.gamma ?? 0 } : null, g && g.x != null ? { x: g.x, y: g.y ?? 0, z: g.z ?? 0 } : null, e.timeStamp)
    }
    addEventListener('devicemotion', on)
    const t = setTimeout(() => { if (!seen) setSensor('none') }, 1500)
    return () => { removeEventListener('devicemotion', on); clearTimeout(t) }
  }, [])

  // кнопки громкости листают слайды (только в приложении)
  useEffect(() => {
    if (!isNative()) return
    void setVolumeKeys(true)
    const off = onNative('volumeKey', (e) => key(e.key === 'up' ? VK.RIGHT : VK.LEFT))
    return () => { off(); void setVolumeKeys(false) }
  }, [])

  const begin = async (e: PointerEvent) => {
    try { area.current!.setPointerCapture(e.pointerId) } catch { /* синтетическое событие */ }
    // iOS спрашивает разрешение на датчики по нажатию
    const D = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }
    if (typeof D.requestPermission === 'function') { try { await D.requestPermission() } catch { /* отказ */ } }
    held.current = { on: true, at: performance.now(), moved: 0 }
    air.reset()
    setLaser(true)
    field.current?.busy(true)
    haptic('tick')
  }
  const end = () => {
    if (!held.current.on) return
    const short = performance.now() - held.current.at < 250 && held.current.moved < 6
    held.current.on = false
    setLaser(false)
    field.current?.busy(false)
    // короткое касание без движения — клик
    if (short) { haptic('tap'); link.raw(buttonFrame('left', 'click')) }
  }

  const elapsed = start === null ? 0 : (Date.now() - start) / 1000
  return (
    <div class="ptr-view">
      <div class="ptr-top">
        <DotDisplay text={formatDuration(elapsed)} pitch={6} lit={start === null ? 'var(--faint)' : 'var(--text)'} label={`Время показа ${formatDuration(elapsed)}`} />
        <button type="button" class="ptr-chip" onClick={() => { haptic('tick'); setStart(start === null ? Date.now() : null) }}>{start === null ? 'Старт' : 'Сброс'}</button>
      </div>
      <div ref={area} class={'ptr-laser' + (laser ? ' on' : '')} role="button" aria-label="Указка: держите и ведите телефоном"
        onPointerDown={(e) => void begin(e)} onPointerUp={end} onPointerCancel={end} onContextMenu={(e) => e.preventDefault()}>
        <DotField mode="pad" apiRef={field} pitch={12} />
        <div class="ptr-hint" aria-hidden="true">
          <DotIcon name="mouse" size={26} />
          <b>{laser ? 'Ведите телефоном' : 'Держите — курсор за телефоном'}</b>
          <span>{sensor === 'none' ? 'Гироскоп доступен в приложении DotLink или по HTTPS' : 'коротко коснуться — клик'}</span>
        </div>
      </div>
      <div class="ptr-slides">
        <button type="button" class="ptr-big" aria-label="Предыдущий слайд" onClick={() => key(VK.LEFT)}><DotIcon name="left" size={30} /></button>
        <button type="button" class="ptr-big next" aria-label="Следующий слайд" onClick={() => key(VK.RIGHT)}><DotIcon name="right" size={30} /></button>
      </div>
      <div class="ptr-row">
        <button type="button" class="ptr-small" onClick={() => key(VK.F(5))}>Показ<small>F5</small></button>
        <button type="button" class="ptr-small" onClick={() => key(VK.key('b'))}>Чёрный<small>B</small></button>
        <button type="button" class="ptr-small" onClick={() => key(VK.ESC)}>Выход<small>Esc</small></button>
      </div>
      {isNative() && <span class="muted small ptr-note">Кнопки громкости тоже листают слайды</span>}
    </div>
  )
}
