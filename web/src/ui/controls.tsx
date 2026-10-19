import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { DotIcon } from './dots'
import type { IconName } from './doticons'
import { haptic } from './haptics'

// Мгновенный отклик на нажатие: класс .is-down ставится прямо на pointerdown,
// не дожидаясь :active (на телефонах он запаздывает), плюс короткая вибрация.
function pressHandlers(kind: 'tick' | 'tap' = 'tick') {
  const up = (e: Event) => (e.currentTarget as HTMLElement).classList.remove('is-down')
  return {
    onPointerDown: (e: PointerEvent) => { (e.currentTarget as HTMLElement).classList.add('is-down'); haptic(kind) },
    onPointerUp: up, onPointerCancel: up, onPointerLeave: up,
  }
}

type BtnProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'icon' | 'size'> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'default'; size?: 'sm' | 'md'; icon?: IconName; block?: boolean; children?: ComponentChildren
}
export function Button({ variant = 'default', size = 'md', icon, block, children, class: cls, ...rest }: BtnProps) {
  const c = ['btn', variant !== 'default' && variant, size === 'sm' && 'sm', block && 'block', cls].filter(Boolean).join(' ')
  return <button type="button" class={c} {...pressHandlers()} {...rest}>{icon && <DotIcon name={icon} size={size === 'sm' ? 14 : 16} />}{children}</button>
}

type IBtnProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'icon' | 'size'> & {
  icon: IconName; label: string; size?: 'md' | 'lg' | 'xl'; variant?: 'default' | 'primary' | 'accent' | 'flat'
}
export function IconButton({ icon, label, size = 'md', variant = 'default', class: cls, ...rest }: IBtnProps) {
  const c = ['ibtn', size !== 'md' && size, variant !== 'default' && variant, cls].filter(Boolean).join(' ')
  const px = size === 'xl' ? 26 : size === 'lg' ? 22 : 18
  return <button type="button" class={c} aria-label={label} title={label} {...pressHandlers('tap')} {...rest}><DotIcon name={icon} size={px} /></button>
}

/** Кольцо из точек вокруг элемента — прогресс удержания. */
function HoldRing({ p, n = 24 }: { p: number; n?: number }) {
  const dots = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    dots.push(<circle key={i} cx={50 + Math.cos(a) * 46} cy={50 + Math.sin(a) * 46} r={1.6} class={i < Math.round(p * n) ? 'lit' : undefined} />)
  }
  return <svg class="hold-ring" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{dots}</svg>
}

/** Удержание для подтверждения опасного действия (выключение, перезагрузка). */
function useHold(ms: number, onConfirm: () => void) {
  const [p, setP] = useState(0)
  const [fired, setFired] = useState(false)
  const st = useRef({ raf: 0, t0: 0, active: false })
  const stop = () => { st.current.active = false; cancelAnimationFrame(st.current.raf); setP(0) }
  const start = () => {
    if (st.current.active) return
    st.current.active = true; st.current.t0 = performance.now(); haptic('tick')
    let lastStep = 0
    const tick = (now: number) => {
      if (!st.current.active) return
      const k = Math.min(1, (now - st.current.t0) / ms)
      setP(k)
      const s = Math.floor(k * 6); if (s > lastStep) { lastStep = s; haptic('tick') }
      if (k >= 1) { st.current.active = false; setP(0); setFired(true); setTimeout(() => setFired(false), 500); haptic('heavy'); onConfirm() }
      else st.current.raf = requestAnimationFrame(tick)
    }
    st.current.raf = requestAnimationFrame(tick)
  }
  useEffect(() => () => cancelAnimationFrame(st.current.raf), [])
  const handlers = {
    onPointerDown: (e: PointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); start() },
    onPointerUp: stop, onPointerCancel: stop,
    onKeyDown: (e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); start() } },
    onKeyUp: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') stop() },
    onContextMenu: (e: Event) => e.preventDefault(),
  }
  return { p, fired, handlers }
}

type TileProps = {
  icon: IconName; label: ComponentChildren; sub?: ComponentChildren; on?: boolean; tone?: 'accent' | 'danger';
  onClick?: () => void; hold?: number; onConfirm?: () => void; class?: string; disabled?: boolean
}
/** Плитка-кнопка. С `hold` срабатывает только после удержания — кольцо точек показывает прогресс. */
export function Tile({ icon, label, sub, on, tone, onClick, hold, onConfirm, class: cls, disabled }: TileProps) {
  const h = useHold(hold || 0, () => onConfirm?.())
  const c = ['tile', on && 'on', tone, hold && 'hold', h.p > 0 && 'armed', h.fired && 'fired', cls].filter(Boolean).join(' ')
  const body = <>
    <DotIcon name={icon} size={20} />
    <span><span class="t-label">{label}</span>{sub && <span class="t-sub">{sub}</span>}</span>
  </>
  if (hold) return <button type="button" class={c} disabled={disabled} aria-label={typeof label === 'string' ? label + ' (удерживайте)' : undefined} {...h.handlers}>{body}{h.p > 0 && <HoldRing p={h.p} />}</button>
  return <button type="button" class={c} disabled={disabled} onClick={onClick} {...pressHandlers('tap')}>{body}</button>
}

/** Клавиша клавиатуры. `onDown`/`onUp` — для удерживаемых модификаторов. */
export function KeyCap({ label, sub, on, onPress, wide, class: cls }: { label: ComponentChildren; sub?: string; on?: boolean; onPress: () => void; wide?: number; class?: string }) {
  return (
    <button type="button" class={['key', on && 'on', cls].filter(Boolean).join(' ')} style={wide ? { minWidth: wide + 'px' } : undefined}
      onPointerDown={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('is-down'); haptic('tick'); onPress() }}
      onPointerUp={(e) => (e.currentTarget as HTMLElement).classList.remove('is-down')}
      onPointerLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('is-down')}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress() } }}
      aria-pressed={on}>
      {label}{sub && <small>{sub}</small>}
    </button>
  )
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; hint?: ComponentChildren; disabled?: boolean }) {
  return (
    <button type="button" role="switch" class="toggle" aria-checked={checked} disabled={disabled} onClick={() => { haptic('tick'); onChange(!checked) }}>
      <span class="tg-txt"><b>{label}</b>{hint && <small>{hint}</small>}</span>
      <span class="tg"><i /></span>
    </button>
  )
}

export function Segmented<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: ComponentChildren }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map((o) => <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => { haptic('tick'); onChange(o.value) }}>{o.label}</button>)}
    </div>
  )
}

/**
 * Слайдер из точек. Тап — прыжок к значению, перетаскивание — плавно.
 * onInput зовётся на каждое движение (для мгновенной громкости), onCommit — по отпусканию.
 */
export function DotSlider({ value, onInput, onCommit, pitch = 11, label, step = 0.02 }: {
  value: number; onInput: (v: number) => void; onCommit?: (v: number) => void; pitch?: number; label: string; step?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [drag, setDrag] = useState(false)
  const lastTick = useRef(-1)
  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setW(el.clientWidth - 4))
    ro.observe(el); setW(el.clientWidth - 4)
    return () => ro.disconnect()
  }, [])
  const n = Math.max(6, Math.floor(w / pitch))
  const from = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left - 2) / (r.width - 4)))
  }
  const emit = (v: number) => {
    const t = Math.round(v * n)
    if (t !== lastTick.current) { lastTick.current = t; haptic('tick') }
    onInput(v)
  }
  const lit = Math.round(value * n)
  const dots = []
  for (let i = 0; i < n; i++) {
    const on = i < lit, head = i === lit - 1
    dots.push(<circle key={i} cx={2 + (i + 0.5) * (w / n)} cy="22" r={head ? (drag ? 5.2 : 4.4) : 3} class={head ? 'on head' : on ? 'on' : undefined} />)
  }
  return (
    <div ref={ref} class={'dslider' + (drag ? ' dragging' : '')} role="slider" tabIndex={0} aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag(true); emit(from(e)) }}
      onPointerMove={(e) => { if (drag) emit(from(e)) }}
      onPointerUp={(e) => { setDrag(false); onCommit?.(from(e)) }}
      onPointerCancel={() => setDrag(false)}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : 0
        if (d) { e.preventDefault(); const v = Math.max(0, Math.min(1, value + d)); onInput(v); onCommit?.(v) }
      }}>
      <svg aria-hidden="true">{w > 0 && dots}</svg>
    </div>
  )
}

export function StatusDot({ state, live }: { state: 'ok' | 'warn' | 'err' | 'off' | 'accent'; live?: boolean }) {
  return <i class={['sdot', state !== 'off' && state, live && 'live'].filter(Boolean).join(' ')} aria-hidden="true" />
}

export function Chip({ children, tone, state, live }: { children: ComponentChildren; tone?: 'accent'; state?: 'ok' | 'warn' | 'err' | 'off' | 'accent'; live?: boolean }) {
  return <span class={'chip' + (tone ? ' ' + tone : '')}>{state && <StatusDot state={state} live={live} />}{children}</span>
}

export function Card({ label, icon, aside, span, tone, i, onClick, children, class: cls }: {
  label?: ComponentChildren; icon?: IconName; aside?: ComponentChildren; span?: 2 | 3 | 'all'; tone?: 'accent' | 'raised';
  i?: number; onClick?: () => void; children?: ComponentChildren; class?: string
}) {
  const c = ['card', span && (span === 'all' ? 'span-all' : 'span-' + span), tone && 'tone-' + tone, onClick && 'pressable', cls].filter(Boolean).join(' ')
  return (
    <section class={c} style={i !== undefined ? { '--i': i } : undefined} onClick={onClick}>
      {(label || icon || aside) && <header class="card-h">{icon && <DotIcon name={icon} size={13} />}<span class="label">{label}</span>{aside}</header>}
      {children}
    </section>
  )
}

export function TabBar<T extends string>({ items, value, onChange }: { items: { id: T; icon: IconName; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <nav class="tabbar" role="tablist">
      {items.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} onClick={() => { if (t.id !== value) haptic('tick'); onChange(t.id) }}>
          <DotIcon name={t.icon} size={18} />{t.label}
        </button>
      ))}
    </nav>
  )
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: ComponentChildren; children?: ComponentChildren }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [open])
  if (!open) return null
  return <>
    <div class="scrim" onClick={onClose} />
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="grab" />
      {title && <h3>{title}</h3>}
      {children}
    </div>
  </>
}

const toasts = signal<{ id: number; msg: string; kind?: 'err' }[]>([])
let toastId = 0
export function toast(msg: string, kind?: 'err') {
  const id = ++toastId
  toasts.value = [...toasts.value.slice(-2), { id, msg, kind }]
  if (kind === 'err') haptic('heavy')
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id) }, kind === 'err' ? 3600 : 2200)
}
export function Toasts() {
  return <div class="toasts" aria-live="polite">{toasts.value.map((t) => <div key={t.id} class={'toast' + (t.kind ? ' ' + t.kind : '')}>{t.msg}</div>)}</div>
}
