// Командная палитра, как Spotlight: поиск по открытым окнам ПК, приложениям меню «Пуск»,
// макросам и действиям с окнами. Окно — перейти к нему, приложение — запустить.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { DotIcon, Sheet, haptic, toast, type IconName } from '../ui'
import { fuzzy } from '../lib/fuzzy'
import { link } from './state'

interface App { id: string; name: string; icon?: string }
interface Win { id: number; title: string; app: string }
interface Item { key: string; icon: IconName; title: string; sub?: string; run: () => void }

const ACTIONS: { a: string; icon: IconName; title: string; words: string }[] = [
  { a: 'show-desktop', icon: 'desktop', title: 'Рабочий стол', words: 'desktop свернуть все win+d' },
  { a: 'task-view', icon: 'apps', title: 'Все окна', words: 'task view win+tab' },
  { a: 'minimize', icon: 'down', title: 'Свернуть окно', words: 'minimize' },
  { a: 'maximize', icon: 'up', title: 'Развернуть окно', words: 'maximize во весь экран' },
  { a: 'snap-left', icon: 'left', title: 'Окно влево', words: 'snap половина слева' },
  { a: 'snap-right', icon: 'right', title: 'Окно вправо', words: 'snap половина справа' },
  { a: 'next-monitor', icon: 'display', title: 'На другой монитор', words: 'monitor экран' },
  { a: 'close', icon: 'close', title: 'Закрыть окно', words: 'close alt+f4' },
]

const ICONS = new Set(['terminal', 'files', 'edit', 'media', 'cpu', 'settings', 'apps', 'send'])

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [data, setData] = useState<{ apps: App[]; windows: Win[] } | null>(null)
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const macros = link.get<any[]>('macros').value || []

  useEffect(() => {
    if (!open) return
    setQ(''); setSel(0)
    const off = link.on('palette', (m) => setData({ apps: m.apps || [], windows: m.windows || [] }))
    link.json({ t: 'palette' })
    setTimeout(() => input.current?.focus(), 60)
    return off
  }, [open])

  const done = (msg?: string) => { haptic('tap'); if (msg) toast(msg); onClose() }
  const items = useMemo(() => {
    const out: (Item & { score: number; group: string })[] = []
    const add = (group: string, it: Item, text: string) => {
      const score = fuzzy(q, text)
      if (score > 0) out.push({ ...it, score, group })
    }
    for (const w of data?.windows || []) {
      add('Окна', { key: 'w' + w.id, icon: 'window', title: w.title, sub: w.app, run: () => { link.json({ t: 'win-focus', id: w.id }); done() } }, `${w.title} ${w.app}`)
    }
    for (const m of macros) {
      add('Быстрые действия', { key: 'm' + m.id, icon: 'bolt', title: m.name, sub: m.value, run: () => { link.json({ t: 'macro', id: m.id }); done() } }, m.name)
    }
    for (const a of ACTIONS) {
      add('Окно', { key: 'a' + a.a, icon: a.icon, title: a.title, run: () => { link.json({ t: 'win-action', a: a.a }); done() } }, `${a.title} ${a.words}`)
    }
    for (const a of data?.apps || []) {
      const icon = (a.icon && ICONS.has(a.icon) ? a.icon : 'apps') as IconName
      add('Приложения', { key: 'p' + a.id, icon, title: a.name, run: () => { link.json({ t: 'launch', id: a.id }); done(`Запускаю «${a.name}»`) } }, a.name)
    }
    if (!q.trim()) return out.slice(0, 60)
    return out.sort((a, b) => b.score - a.score).slice(0, 40)
  }, [q, data, macros])

  useEffect(() => { setSel(0) }, [q])

  // плоский список с ключами (заголовки групп — отдельные строки): так Preact надёжно сверяет DOM
  const rows: any[] = []
  let lastGroup = ''
  items.forEach((it, i) => {
    if (!q.trim() && it.group !== lastGroup) rows.push(<span key={'g:' + it.group} class="label pal-group">{it.group}</span>)
    lastGroup = it.group
    rows.push(
      <button key={it.key} type="button" role="option" aria-selected={i === sel} class={'pal-item' + (i === sel ? ' sel' : '')} onClick={it.run}>
        <DotIcon name={it.icon} size={16} />
        <span class="grow"><b class="ellipsis">{it.title}</b>{it.sub && <small class="muted ellipsis">{it.sub}</small>}</span>
      </button>,
    )
  })

  return (
    <Sheet open={open} onClose={onClose} title="Поиск на ПК">
      <div class="pal">
        <label class="pal-search">
          <DotIcon name="search" size={16} />
          <input ref={input} class="input" type="search" placeholder="Окно, приложение, действие" value={q} aria-label="Поиск на ПК"
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
              if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run() }
            }} />
        </label>
        <div class="pal-list" role="listbox">
          {!data && <span class="muted small">Спрашиваю у ПК…</span>}
          {data && items.length === 0 && <span class="muted small">Ничего не нашлось</span>}
          {rows}
        </div>
      </div>
    </Sheet>
  )
}
