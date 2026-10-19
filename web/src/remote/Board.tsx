// Главный экран пульта — доска виджетов: какие показывать и в каком порядке, решает человек
// (кнопка «Настроить виджеты»). Карточки, общие с дашбордом ПК, — в ./Home.
import { Fragment } from 'preact'
import { useState } from 'preact/hooks'
import { Button, Card, DotDisplay, DotIcon, DotSpark, IconButton, Sheet, toast, type IconName } from '../ui'
import { useLink } from '../lib/linkctx'
import { handoffToPc, pushClipboard } from './continuity'
import { MacrosCard, MediaCard, SysCards, TimerCard, useHistory, VolumeCard, WindowCard } from './Home'
import { canReadClipboard, copyText, isNative, mirror, openSettings } from './native'
import { caps, mirroring, ucActive } from './phonectl'
import { DEFAULT_WIDGETS, prefs, setPref } from './state'

// ───────── виджеты, которых нет на ПК ─────────

const VIA_LABEL: Record<string, string> = { lan: 'Wi-Fi', relay: 'Интернет', bt: 'Bluetooth' }

/** Связь: путь до ПК, прямой канал, задержка и её история. */
export function LinkCard({ i }: { i?: number }) {
  const link = useLink()
  const rtt = link.rtt.value
  const hist = useHistory(link.status.value === 'online' ? Math.min(150, rtt) / 150 : undefined, 40)
  const via = link.via.value
  return (
    <Card label="Связь" icon={via === 'bt' ? 'signal' : via === 'relay' ? 'link' : 'wifi'} span={2} i={i}
      aside={<span class="chip">{via ? VIA_LABEL[via] : '—'}{link.p2p.value ? ' · напрямую' : ''}</span>}>
      <div class="link-row">
        <DotDisplay text={`${Math.min(999, rtt)}`.padStart(3, ' ')} pitch={4} lit={rtt > 60 ? 'var(--warn)' : 'var(--text)'} label={`${rtt} мс`} />
        <span class="muted small">мс</span>
        <div class="grow"><DotSpark values={hist} rows={4} pitch={6} /></div>
      </div>
    </Card>
  )
}

/** Буфер и Handoff: что скопировано на ПК, и в обратную сторону — одним касанием. */
export function ClipCard({ i }: { i?: number }) {
  const link = useLink()
  const clip = link.get<any>('clip').value
  const perms = link.perms.value
  if (!perms?.clipboard) return null
  const text = clip?.kind === 'text' ? clip.text : ''
  return (
    <Card label={clip?.from === 'phone' ? 'Буфер · с телефона' : 'Буфер · с ПК'} icon="clipboard" span={2} i={i}>
      {text ? <p class="clip-text clamp-2">{text}</p> : <span class="muted small">{clip?.kind === 'files' ? `Файлы: ${clip.files.join(', ')}` : 'Скопируйте что-нибудь на ПК — появится здесь и в буфере телефона'}</span>}
      <div class="row wrap">
        {text && <Button size="sm" icon="copy" onClick={async () => toast((await copyText(text)) ? 'Скопировано' : 'Не удалось скопировать')}>Копировать</Button>}
        {canReadClipboard() && <>
          <Button size="sm" icon="send" onClick={async () => toast((await pushClipboard(true)) ? 'Буфер телефона → ПК' : 'Телефон не дал прочитать буфер')}>Мой буфер → ПК</Button>
          <Button size="sm" icon="link" onClick={() => void handoffToPc()}>Ссылку на ПК</Button>
        </>}
      </div>
    </Card>
  )
}

/** Экран телефона на ПК и мышь ПК на телефоне — только в приложении для Android. */
export function PhoneCard({ i }: { i?: number }) {
  if (!isNative()) return null
  const on = mirroring.value
  const c = caps.value
  return (
    <Card label="Телефон на ПК" icon="phone" span={2} i={i} aside={ucActive.value ? <span class="chip"><i class="sdot accent live" />мышь ПК</span> : undefined}>
      <div class="row wrap">
        <Button size="sm" variant={on ? 'danger' : 'primary'} icon={on ? 'close' : 'display'} onClick={async () => {
          try { if (on) await mirror.stop(); else await mirror.start({ max: 1280, bitrate: 6_000_000, fps: 60 }) } catch (e) { toast((e as Error).message, 'err') }
        }}>{on ? 'Остановить трансляцию' : 'Экран на ПК'}</Button>
        {c && !c.control && <Button size="sm" icon="settings" onClick={() => void openSettings('accessibility')}>Разрешить управление</Button>}
      </div>
      <span class="muted small">{c?.control ? 'ПК может нажимать, листать и печатать на телефоне; мышь ПК уходит сюда через край экрана.' : 'Чтобы ПК мог управлять телефоном, включите «DotLink: управление с ПК» в спец. возможностях.'}</span>
    </Card>
  )
}

// ───────── доска виджетов ─────────

export const WIDGETS: { id: string; label: string; icon: IconName; render: (i: number) => any }[] = [
  { id: 'link', label: 'Связь', icon: 'wifi', render: (i) => <LinkCard i={i} /> },
  { id: 'media', label: 'Музыка', icon: 'media', render: (i) => <MediaCard i={i} /> },
  { id: 'volume', label: 'Громкость', icon: 'volume', render: (i) => <VolumeCard i={i} /> },
  { id: 'sys', label: 'Процессор и память', icon: 'cpu', render: (i) => <SysCards i={i} /> },
  { id: 'clip', label: 'Буфер и ссылки', icon: 'clipboard', render: (i) => <ClipCard i={i} /> },
  { id: 'phone', label: 'Телефон на ПК', icon: 'phone', render: (i) => <PhoneCard i={i} /> },
  { id: 'actions', label: 'Быстрые действия', icon: 'bolt', render: (i) => <MacrosCard i={i} limit={6} /> },
  { id: 'window', label: 'Активное окно', icon: 'window', render: (i) => <WindowCard i={i} /> },
]

function Customize({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = prefs.value.widgets
  const order = [...list.filter((id) => WIDGETS.some((w) => w.id === id)), ...WIDGETS.map((w) => w.id).filter((id) => !list.includes(id))]
  const move = (id: string, d: number) => {
    const vis = list.filter((x) => x !== id)
    const at = Math.max(0, Math.min(vis.length, list.indexOf(id) + d))
    vis.splice(at, 0, id)
    setPref('widgets', vis)
  }
  return (
    <Sheet open={open} onClose={onClose} title="Виджеты">
      <div class="stack widget-list">
        {order.map((id) => {
          const w = WIDGETS.find((x) => x.id === id)!
          const on = list.includes(id)
          return (
            <div key={id} class={'widget-row' + (on ? '' : ' off')}>
              <DotIcon name={w.icon} size={16} />
              <span class="grow">{w.label}</span>
              {on && <IconButton icon="up" label="Выше" onClick={() => move(id, -1)} />}
              {on && <IconButton icon="down" label="Ниже" onClick={() => move(id, 1)} />}
              <IconButton icon={on ? 'eye' : 'plus'} label={on ? 'Скрыть' : 'Показать'} variant={on ? 'flat' : 'default'}
                onClick={() => setPref('widgets', on ? list.filter((x) => x !== id) : [...list, id])} />
            </div>
          )
        })}
        <Button variant="ghost" icon="restart" onClick={() => setPref('widgets', DEFAULT_WIDGETS)}>Как было</Button>
      </div>
    </Sheet>
  )
}

export function Home() {
  const [edit, setEdit] = useState(false)
  const ids = prefs.value.widgets.filter((id) => WIDGETS.some((w) => w.id === id))
  return (
    <div class="grid home-grid">
      <TimerCard i={0} />
      {ids.map((id, n) => <Fragment key={id}>{WIDGETS.find((w) => w.id === id)!.render(n)}</Fragment>)}
      <button type="button" class="widget-edit" onClick={() => setEdit(true)}><DotIcon name="settings" size={14} />Настроить виджеты</button>
      <Customize open={edit} onClose={() => setEdit(false)} />
    </div>
  )
}
