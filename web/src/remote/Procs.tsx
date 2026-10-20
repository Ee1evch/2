// «Что грузит ПК»: программы по загрузке процессора и памяти, обновляются, пока карточка на экране.
// Зависшую программу можно завершить (все её процессы); служебные процессы Windows ПК не даст.
import { useEffect, useRef, useState } from 'preact/hooks'
import { Button, Card, DotMeter, Sheet, haptic, toast } from '../ui'
import { formatBytes } from '../lib/format'
import { link } from './state'

interface App { name: string; count: number; cpu: number; mem: number }

export function ProcsCard({ limit = 8, i }: { limit?: number; i?: number }) {
  const [list, setList] = useState<App[] | null>(null)
  const [pick, setPick] = useState<App | null>(null)
  const [by, setBy] = useState<'cpu' | 'mem'>('cpu')
  const [q, setQ] = useState('')
  const qRef = useRef('')
  qRef.current = q
  const el = useRef<HTMLDivElement>(null)
  const allowed = link.perms.value?.power !== false

  useEffect(() => {
    if (!allowed) return
    const off = link.on('procs', (m) => setList(m.list || []))
    let visible = true
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting })
    if (el.current) io.observe(el.current)
    const ask = () => { if (visible && document.visibilityState === 'visible' && link.online) link.json({ t: 'procs', q: qRef.current || undefined }) }
    ask()
    // второй запрос сразу: загрузка процессора считается между двумя замерами
    const first = setTimeout(ask, 700)
    const t = setInterval(ask, 2000)
    return () => { off(); io.disconnect(); clearTimeout(first); clearInterval(t) }
  }, [allowed, link.status.value, q])

  if (!allowed) return null
  const rows = (list || []).slice().sort((a, b) => (by === 'cpu' ? b.cpu - a.cpu || b.mem - a.mem : b.mem - a.mem)).slice(0, q ? 20 : limit)
  const maxMem = Math.max(1, ...rows.map((r) => r.mem))
  return (
    <Card label="Что грузит ПК" icon="cpu" span={2} i={i}
      aside={<button type="button" class="chip" onClick={() => { haptic('tick'); setBy(by === 'cpu' ? 'mem' : 'cpu') }}>{by === 'cpu' ? 'Процессор' : 'Память'}</button>}>
      <input class="input proc-q" type="search" placeholder="Найти программу" aria-label="Найти программу" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div ref={el} class="proc-list">
        {!list && <span class="muted small">Спрашиваю у ПК…</span>}
        {list && !rows.length && <span class="muted small">{q ? 'Такой программы нет' : 'Пусто'}</span>}
        {rows.map((p) => (
          <button key={p.name} type="button" class="proc" onClick={() => { haptic('tick'); setPick(p) }}>
            <span class="proc-name ellipsis">{p.name}{p.count > 1 && <small class="muted"> ×{p.count}</small>}</span>
            <span class="proc-val num">{by === 'cpu' ? `${Math.round(p.cpu * 100)}%` : formatBytes(p.mem)}</span>
            <DotMeter value={by === 'cpu' ? Math.min(1, p.cpu * 2) : p.mem / maxMem} pitch={5} rows={1} hot={by === 'cpu' ? 0.6 : 2} />
          </button>
        ))}
      </div>
      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick?.name}>
        {pick && (
          <div class="stack">
            <dl class="kv">
              <dt>Процессор</dt><dd class="num">{Math.round(pick.cpu * 100)}%</dd>
              <dt>Память</dt><dd class="num">{formatBytes(pick.mem)}</dd>
              <dt>Процессов</dt><dd class="num">{pick.count}</dd>
            </dl>
            <p class="muted small" style={{ margin: 0 }}>Несохранённые данные в программе пропадут.</p>
            <Button variant="danger" icon="close" block onClick={async () => {
              const name = pick.name
              setPick(null)
              link.json({ t: 'proc-kill', name })
              try {
                await link.once('*', (m) => m.for === 'proc-kill', 5000)
                link.json({ t: 'procs', q: qRef.current || undefined })
              } catch { toast('ПК не ответил', 'err') }
            }}>Завершить</Button>
          </div>
        )}
      </Sheet>
    </Card>
  )
}
