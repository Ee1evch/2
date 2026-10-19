import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { DotField, DotIcon, KeyCap, haptic, type DotFieldApi } from '../ui'
import { buttonFrame, chordFrame, keyFrame, textFrame, VK } from '../lib/proto'
import { link, prefs } from './state'
import { Trackpad } from './trackpad'

/** Кнопка мыши под тачпадом: держите — кнопка зажата (можно тащить вторым пальцем). */
function MouseBtn({ b, label }: { b: 'left' | 'right'; label: string }) {
  return (
    <button type="button" class="pad-btn" aria-label={label}
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); (e.currentTarget as HTMLElement).classList.add('is-down'); haptic('tap'); link.raw(buttonFrame(b, 'down')) }}
      onPointerUp={(e) => { (e.currentTarget as HTMLElement).classList.remove('is-down'); link.raw(buttonFrame(b, 'up')) }}
      onPointerCancel={(e) => { (e.currentTarget as HTMLElement).classList.remove('is-down'); link.raw(buttonFrame(b, 'up')) }}
      onContextMenu={(e) => e.preventDefault()}>
      <span class="dot">{b === 'left' ? 'Л' : 'П'}</span>
    </button>
  )
}

export function Pad() {
  const field = useRef<DotFieldApi | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const [kbd, setKbd] = useState(false)
  const pad = useMemo(() => new Trackpad({
    move: (dx, dy, t) => link.move(dx, dy, t),
    scroll: (v, h) => link.scroll(v, h),
    button: (b, a) => link.raw(buttonFrame(b, a)),
    haptic: (k) => haptic(k),
    touch: (id, x, y, on) => { if (on) field.current?.touch(id, x, y); else field.current?.release(id) },
  }), [])
  useEffect(() => { pad.prefs = prefs.value }, [prefs.value])
  useEffect(() => () => pad.stopInertia(), [])

  const rel = (e: PointerEvent): [number, number] => {
    const r = area.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  return (
    <div class="pad-view">
      <div ref={area} class="pad" role="application" aria-label="Тачпад"
        onPointerDown={(e) => {
          try { area.current!.setPointerCapture(e.pointerId) } catch { /* синтетическое событие */ }
          const [x, y] = rel(e)
          field.current?.ripple(x, y)
          pad.down(e.pointerId, x, y)
        }}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' && !e.buttons) return
          const evs = (e as PointerEvent).getCoalescedEvents?.() ?? []
          for (const ev of evs.length ? evs : [e]) { const [x, y] = rel(ev); pad.move(e.pointerId, x, y, ev.timeStamp) }
        }}
        onPointerUp={(e) => pad.up(e.pointerId)}
        onPointerCancel={(e) => pad.cancel(e.pointerId)}
        onContextMenu={(e) => e.preventDefault()}>
        <DotField mode="pad" apiRef={field} pitch={11} />
        <div class="pad-hint" aria-hidden="true">
          <span>1 палец — курсор · тап — клик</span>
          <span>2 пальца — прокрутка · тап — ПКМ</span>
          <span>тап + провести — перетащить</span>
        </div>
      </div>
      <div class="pad-btns">
        <MouseBtn b="left" label="Левая кнопка" />
        <button type="button" class={'pad-btn kb' + (kbd ? ' on' : '')} aria-label="Клавиатура" aria-pressed={kbd} onClick={() => { haptic('tick'); setKbd(!kbd) }}><DotIcon name="keyboard" size={22} /></button>
        <MouseBtn b="right" label="Правая кнопка" />
      </div>
      {kbd && <Keyboard />}
    </div>
  )
}

type Mod = 'ctrl' | 'alt' | 'shift' | 'win'
const MOD_VK: Record<Mod, number> = { ctrl: VK.CTRL, alt: VK.ALT, shift: VK.SHIFT, win: VK.WIN }
const SENTINEL = '​'

/** Клавиатура: поле для набора (любой язык, автозамена) + клавиши и сочетания. */
export function Keyboard() {
  const [mods, setMods] = useState<Record<Mod, boolean>>({ ctrl: false, alt: false, shift: false, win: false })
  const [fkeys, setFkeys] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const prev = useRef(SENTINEL)
  const altTab = useRef(0)

  const active = (Object.keys(mods) as Mod[]).filter((m) => mods[m])
  const clearMods = () => setMods({ ctrl: false, alt: false, shift: false, win: false })
  const key = (vk: number) => {
    if (active.length) { link.raw(chordFrame([...active.map((m) => MOD_VK[m]), vk])); clearMods() }
    else link.raw(keyFrame(vk))
  }
  const chord = (...vks: number[]) => link.raw(chordFrame(vks))

  // Alt+Tab: Alt держится, пока вы листаете окна; отпускается через секунду без нажатий
  const altTabTap = () => {
    if (!altTab.current) { link.raw(keyFrame(VK.ALT, 'down')); link.raw(keyFrame(VK.TAB)) }
    else { clearTimeout(altTab.current); link.raw(keyFrame(VK.TAB)) }
    altTab.current = window.setTimeout(() => { link.raw(keyFrame(VK.ALT, 'up')); altTab.current = 0 }, 1100)
  }
  useEffect(() => () => { if (altTab.current) { clearTimeout(altTab.current); link.raw(keyFrame(VK.ALT, 'up')) } }, [])

  const composing = useRef(false)
  const onInput = () => {
    const el = input.current!
    let v = el.value
    if (!v.startsWith(SENTINEL)) {
      // стёрли сторожевой символ на пустом поле — это Backspace
      if (prev.current === SENTINEL && v.length === 0) key(VK.BACK)
      v = SENTINEL + v.replace(SENTINEL, '')
    }
    // разница с прошлым значением: стёртое → Backspace, добавленное → текст (работает с автозаменой и IME)
    const before = prev.current
    let i = 0
    while (i < before.length && i < v.length && before[i] === v[i]) i++
    for (let k = 0; k < before.length - i; k++) key(VK.BACK)
    const added = v.slice(i)
    if (added) {
      if (active.length && [...added].length === 1) key(VK.key(added))
      else link.raw(textFrame(added))
    }
    prev.current = v
    // поле не растёт бесконечно: длинную строку сбрасываем, когда не идёт составление слова
    if (v.length > 40 && !composing.current) v = SENTINEL
    if (el.value !== v) { el.value = v; prev.current = v }
  }

  useEffect(() => { input.current!.value = SENTINEL; input.current!.focus() }, [])

  const mod = (m: Mod, label: string) => <KeyCap label={label} sub={mods[m] ? 'держу' : ''} on={mods[m]} onPress={() => setMods({ ...mods, [m]: !mods[m] })} />
  return (
    <div class="kbd" onPointerDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault() }}>
      <input ref={input} class="input kbd-input" type="text" inputMode="text" autocomplete="off" autocapitalize="off" spellcheck={false} enterKeyHint="send"
        placeholder="Печатайте — текст сразу появится на ПК" aria-label="Ввод текста на ПК"
        onInput={onInput}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); key(VK.ENTER); input.current!.value = SENTINEL; prev.current = SENTINEL }
          else if (e.key === 'Backspace' && input.current!.value === SENTINEL) { e.preventDefault(); key(VK.BACK) }
        }} />
      <div class="kbd-row">
        {mod('ctrl', 'Ctrl')}{mod('shift', 'Shift')}{mod('alt', 'Alt')}{mod('win', 'Win')}
        <KeyCap label="Esc" onPress={() => key(VK.ESC)} />
        <KeyCap label="Tab" onPress={() => key(VK.TAB)} />
      </div>
      <div class="kbd-row">
        <KeyCap label="C" sub="копир." onPress={() => chord(VK.CTRL, VK.key('c'))} />
        <KeyCap label="V" sub="вставить" onPress={() => chord(VK.CTRL, VK.key('v'))} />
        <KeyCap label="X" sub="вырезать" onPress={() => chord(VK.CTRL, VK.key('x'))} />
        <KeyCap label="Z" sub="отмена" onPress={() => chord(VK.CTRL, VK.key('z'))} />
        <KeyCap label="A" sub="всё" onPress={() => chord(VK.CTRL, VK.key('a'))} />
      </div>
      <div class="kbd-row">
        <KeyCap label="Alt+Tab" onPress={altTabTap} />
        <KeyCap label="Win+D" onPress={() => chord(VK.WIN, VK.key('d'))} />
        <KeyCap label="Win+L" onPress={() => chord(VK.WIN, VK.key('l'))} />
        <KeyCap label="F" sub={fkeys ? 'скрыть' : 'F1–F12'} on={fkeys} onPress={() => setFkeys(!fkeys)} />
      </div>
      {fkeys && <div class="kbd-row wrap">{Array.from({ length: 12 }, (_, i) => <KeyCap key={i} label={`F${i + 1}`} onPress={() => key(VK.F(i + 1))} />)}</div>}
      <div class="kbd-row">
        <KeyCap label="⌫" sub="Bksp" onPress={() => key(VK.BACK)} />
        <KeyCap label="Del" onPress={() => key(VK.DEL)} />
        <KeyCap label="←" onPress={() => key(VK.LEFT)} />
        <KeyCap label="↑" onPress={() => key(VK.UP)} />
        <KeyCap label="↓" onPress={() => key(VK.DOWN)} />
        <KeyCap label="→" onPress={() => key(VK.RIGHT)} />
        <KeyCap label="⏎" sub="Enter" onPress={() => key(VK.ENTER)} />
      </div>
    </div>
  )
}
