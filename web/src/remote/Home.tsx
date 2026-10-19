import { useEffect, useRef, useState } from 'preact/hooks'
import { Card, DotDisplay, DotMeter, DotSlider, DotSpark, Halftone, IconButton, Tile, ICON_NAMES, type IconName } from '../ui'
import { volumeFrame } from '../lib/proto'
import { formatDuration } from '../lib/format'
import { useLink } from '../lib/linkctx'

export function useTicker(ms: number, on = true) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms, on])
}

/** Громкость: ползунок шлёт значение каждый кадр, ответ ПК под пальцем не дёргает ползунок. */
export function VolumeCard({ i }: { i?: number }) {
  const link = useLink()
  const vol = link.get<{ level: number; muted: boolean }>('vol').value
  const [local, setLocal] = useState<number | null>(null)
  const st = useRef({ seq: 0, pending: -1, raf: 0, release: 0 })
  const value = local ?? vol?.level ?? 0
  const send = (v: number) => {
    st.current.pending = v
    if (st.current.raf) return
    st.current.raf = requestAnimationFrame(() => {
      st.current.raf = 0
      link.raw(volumeFrame(st.current.pending, ++st.current.seq))
    })
  }
  const input = (v: number) => { clearTimeout(st.current.release); setLocal(v); send(v) }
  const commit = (v: number) => { send(v); st.current.release = window.setTimeout(() => setLocal(null), 700) }
  const step = (d: number) => { const v = Math.max(0, Math.min(1, Math.round((value + d) * 50) / 50)); input(v); commit(v) }
  const muted = !!vol?.muted
  return (
    <Card label="Громкость" icon="volume" span={2} i={i} aside={<IconButton icon={muted ? 'mute' : 'volume'} label={muted ? 'Включить звук' : 'Без звука'} variant={muted ? 'accent' : 'flat'} onClick={() => link.json({ t: 'mute', v: !muted })} />}>
      <div class="vol-row">
        <DotDisplay text={String(Math.round(value * 100)).padStart(3, ' ')} pitch={7} lit={muted ? 'var(--faint)' : 'var(--text)'} label={`${Math.round(value * 100)}%`} />
        <div class="row">
          <IconButton icon="minus" label="Тише" onClick={() => step(-0.04)} />
          <IconButton icon="plus" label="Громче" onClick={() => step(0.04)} />
        </div>
      </div>
      <DotSlider value={value} onInput={input} onCommit={commit} label="Громкость ПК" />
    </Card>
  )
}

export function MediaCard({ i }: { i?: number }) {
  const link = useLink()
  const m = link.get<any>('media').value
  const art = link.get<string | null>('art').value
  const playing = !!m?.playing
  // позиция досчитывается локально между обновлениями
  const base = useRef({ pos: 0, at: 0 })
  if (m && (Math.abs(m.position - base.current.pos) > 0.01 || !base.current.at)) base.current = { pos: m.position, at: performance.now() }
  useTicker(1000, playing)
  const pos = m ? Math.min(m.duration || Infinity, base.current.pos + (playing ? (performance.now() - base.current.at) / 1000 : 0)) : 0
  return (
    <Card label={m?.app ? `Сейчас играет · ${m.app}` : 'Сейчас играет'} icon="media" span={2} i={i}>
      <div class="media-row">
        <Halftone src={art} size={92} grid={23} />
        <div class="media-txt">
          <b class="ellipsis media-title">{m?.title || 'Ничего не играет'}</b>
          <span class="muted ellipsis">{m ? [m.artist, m.album].filter(Boolean).join(' · ') : 'Запустите музыку на ПК'}</span>
          {m?.duration > 0 && (
            <div class="media-prog">
              <DotMeter value={pos / m.duration} pitch={6} rows={1} hot={2} />
              <span class="num muted">{formatDuration(pos)} / {formatDuration(m.duration)}</span>
            </div>
          )}
        </div>
      </div>
      <div class="media-ctl">
        <IconButton icon="prev" label="Предыдущий" size="lg" onClick={() => link.json({ t: 'media', a: 'prev' })} />
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Пауза' : 'Играть'} size="xl" variant="primary" onClick={() => link.json({ t: 'media', a: 'toggle' })} />
        <IconButton icon="next" label="Следующий" size="lg" onClick={() => link.json({ t: 'media', a: 'next' })} />
      </div>
    </Card>
  )
}

export function useHistory(v: number | undefined, n = 60) {
  const h = useRef<number[]>([])
  const last = useRef<number | undefined>(undefined)
  if (v !== undefined && v !== last.current) {
    last.current = v
    h.current = [...h.current.slice(-(n - 1)), v]
  }
  return h.current
}

export function SysCards({ i = 0 }: { i?: number }) {
  const link = useLink()
  const s = link.get<any>('sys').value
  const cpuHist = useHistory(s?.cpu)
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1)
  const mem = s ? s.mem_used / Math.max(1, s.mem_total) : 0
  return <>
    <Card label="Процессор" icon="cpu" i={i}>
      <DotDisplay text={`${Math.round((s?.cpu ?? 0) * 100)}%`.padStart(4, ' ')} pitch={4} lit={(s?.cpu ?? 0) > 0.85 ? 'var(--accent)' : 'var(--text)'} />
      <DotSpark values={cpuHist} rows={5} pitch={6} />
    </Card>
    <Card label="Память" icon="ram" i={i + 1}>
      <DotDisplay text={`${Math.round(mem * 100)}%`.padStart(4, ' ')} pitch={4} lit={mem > 0.85 ? 'var(--accent)' : 'var(--text)'} />
      <DotMeter value={mem} pitch={6} rows={3} />
      <span class="muted num small">{s ? `${gb(s.mem_used)} из ${gb(s.mem_total)} ГБ` : '—'}</span>
    </Card>
  </>
}

export function WindowCard({ i }: { i?: number }) {
  const link = useLink()
  const w = link.get<{ title: string; app: string }>('win').value
  const s = link.get<any>('sys').value
  return (
    <Card label="Активное окно" icon="window" span={2} i={i} aside={s?.battery ? <span class="chip">{s.battery.charging ? '⚡ ' : ''}{s.battery.percent}%</span> : undefined}>
      <div class="win-row">
        <b class="ellipsis">{w?.app || '—'}</b>
        <span class="muted ellipsis">{w?.title || ''}</span>
      </div>
    </Card>
  )
}

const iconOf = (n: string): IconName => ((ICON_NAMES as string[]).includes(n) ? (n as IconName) : 'bolt')

export function MacrosCard({ i, limit }: { i?: number; limit?: number }) {
  const link = useLink()
  const ms = link.get<any[]>('macros').value || []
  if (!ms.length) return null
  return (
    <Card label="Быстрые действия" icon="bolt" span={2} i={i}>
      <div class="grid macro-grid">
        {ms.slice(0, limit).map((m) => <Tile key={m.id} icon={iconOf(m.icon)} label={m.name} onClick={() => link.json({ t: 'macro', id: m.id })} />)}
      </div>
    </Card>
  )
}

export function TimerCard({ i }: { i?: number }) {
  const link = useLink()
  const t = link.get<any>('timer').value
  useTicker(1000, !!t)
  if (!t) return null
  const skew = Date.now() - (t.now ?? Date.now())
  const left = Math.max(0, (t.ends_at + skew - Date.now()) / 1000)
  const what: Record<string, string> = { shutdown: 'Выключение', restart: 'Перезагрузка', sleep: 'Сон', hibernate: 'Гибернация', lock: 'Блокировка', logoff: 'Выход' }
  return (
    <Card label={`Таймер · ${what[t.action] || t.action}`} icon="timer" span={2} tone="raised" i={i} aside={<button class="btn sm danger" onClick={() => link.json({ t: 'timer', cancel: true })}>Отменить</button>}>
      <DotDisplay text={formatDuration(left)} pitch={6} lit="var(--accent)" />
    </Card>
  )
}

export function Home() {
  return (
    <div class="grid home-grid">
      <TimerCard i={0} />
      <MediaCard i={0} />
      <VolumeCard i={1} />
      <SysCards i={2} />
      <WindowCard i={4} />
      <MacrosCard i={5} limit={6} />
    </div>
  )
}
