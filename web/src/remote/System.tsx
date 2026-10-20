import { useState } from 'preact/hooks'
import { Button, Card, DotSlider, Segmented, Sheet, Tile, Toggle, DotDisplay } from '../ui'
import { formatUptime } from '../lib/format'
import { forgetPc, loadSaved, type Via } from '../lib/link'
import type { PowerAction } from '../lib/proto'
import { TimerCard } from './Home'
import { link, prefs, setPref } from './state'
import { isNative, openSettings } from './native'
import { caps, refreshCaps } from './phonectl'
import { ProcsCard } from './Procs'

const power = (a: PowerAction) => link.json({ t: 'power', a })

/** Что телефон разрешил: управление с ПК, уведомления, Bluetooth; и что синхронизировать. */
function Continuity() {
  const p = prefs.value
  const c = caps.value
  const row = (on: boolean | undefined, label: string, hint: string, what: 'accessibility' | 'notifications' | 'bluetooth') => (
    <div class="cap-row">
      <i class={'sdot ' + (on ? 'ok' : '')} />
      <span class="grow"><b>{label}</b><small class="muted">{hint}</small></span>
      {!on && <Button size="sm" onClick={() => { void openSettings(what); setTimeout(() => void refreshCaps(), 1500) }}>Включить</Button>}
    </div>
  )
  return (
    <Card label="Телефон и ПК" icon="phone" span={2}>
      {isNative() && c && <>
        {row(c.control, 'Управление с ПК', 'Касания, жесты и текст с ПК, курсор мыши ПК', 'accessibility')}
        {row(c.notifications, 'Уведомления на ПК', 'Сообщения и звонки видны на компьютере', 'notifications')}
        {row(c.bluetooth, 'Bluetooth', 'Связь с ПК без Wi-Fi и интернета', 'bluetooth')}
      </>}
      {!isNative() && <p class="muted small" style={{ margin: 0 }}>Экран телефона на ПК, управление телефоном и Bluetooth работают в приложении DotLink для Android. В браузере доступно всё остальное.</p>}
      <Toggle checked={p.clipAuto} onChange={(v) => setPref('clipAuto', v)} label="Общий буфер обмена" hint="Скопировали на одном устройстве — вставляйте на другом" />
      {isNative() && <Toggle checked={p.notifs} onChange={(v) => setPref('notifs', v)} label="Пересылать уведомления" hint="Только пока телефон подключён к ПК" />}
    </Card>
  )
}

function TimerSetup() {
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<'shutdown' | 'sleep' | 'restart'>('shutdown')
  const [min, setMin] = useState(45)
  const start = (m: number) => { link.json({ t: 'timer', a: action, sec: Math.round(m * 60) }); setOpen(false) }
  return (
    <Card label="Таймер" icon="timer" span={2}>
      <Segmented value={action} onChange={setAction} options={[{ value: 'shutdown', label: 'Выключить' }, { value: 'sleep', label: 'Сон' }, { value: 'restart', label: 'Перезагрузить' }]} />
      <div class="grid" style={{ '--cols': 4 }}>
        {[15, 30, 60, 90].map((m) => <Tile key={m} icon="timer" label={`${m} мин`} onClick={() => start(m)} />)}
      </div>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Другое время…</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Через сколько?">
        <div class="stack">
          <DotDisplay text={`${min} МИН`} pitch={6} />
          <DotSlider value={(min - 5) / 235} onInput={(v) => setMin(Math.round(5 + v * 235))} label="Минуты" />
          <Button variant="primary" block onClick={() => start(min)}>Запустить</Button>
        </div>
      </Sheet>
    </Card>
  )
}

export function System({ onSwitch }: { onSwitch: () => void }) {
  const s = link.get<any>('sys').value
  const pc = link.get<any>('pc').value
  const p = prefs.value
  return (
    <div class="grid home-grid">
      <Card label="Питание" icon="power" span={2} i={0}>
        <div class="grid power-grid">
          <Tile icon="lock" label="Блокировка" sub="Win+L" onClick={() => power('lock')} />
          <Tile icon="sleep" label="Сон" onClick={() => power('sleep')} />
          <Tile icon="display" label="Экран" sub="выключить" onClick={() => power('display-off')} />
          <Tile icon="logout" label="Выйти" sub="удерживайте" hold={900} onConfirm={() => power('logoff')} />
          <Tile icon="restart" label="Перезагрузка" sub="удерживайте" hold={900} onConfirm={() => power('restart')} />
          <Tile icon="power" label="Выключение" sub="удерживайте" tone="danger" hold={900} onConfirm={() => power('shutdown')} />
        </div>
      </Card>
      <TimerCard />
      <TimerSetup />

      <Card label="Компьютер" icon="desktop" span={2}>
        <dl class="kv">
          <dt>Имя</dt><dd>{pc?.name || '—'}</dd>
          <dt>Работает</dt><dd>{s ? formatUptime(s.uptime) : '—'}</dd>
          <dt>Ядер</dt><dd>{s?.cores?.length ?? '—'}</dd>
          <dt>Память</dt><dd>{s ? `${(s.mem_total / 1024 ** 3).toFixed(1)} ГБ` : '—'}</dd>
          {s?.battery && <><dt>Батарея</dt><dd>{s.battery.percent}%{s.battery.charging ? ', заряжается' : ''}</dd></>}
          <dt>Путь</dt><dd>{viaLabel(link.via.value)}{link.p2p.value ? ' · напрямую' : ''}</dd>
          <dt>Адрес</dt><dd class="num">{link.host.value || '—'}</dd>
          <dt>Задержка</dt><dd class="num">{link.rtt.value} мс</dd>
        </dl>
      </Card>

      <ProcsCard />
      <Continuity />

      <Card label="Тачпад и отклик" icon="pad" span={2}>
        <div class="field"><span class="label">Скорость курсора · {p.speed.toFixed(1)}×</span>
          <DotSlider value={(p.speed - 0.6) / 2.4} onInput={(v) => setPref('speed', Math.round((0.6 + v * 2.4) * 10) / 10)} label="Скорость курсора" />
        </div>
        <div class="field"><span class="label">Скорость прокрутки · {p.scrollSpeed.toFixed(1)}×</span>
          <DotSlider value={(p.scrollSpeed - 0.8) / 4} onInput={(v) => setPref('scrollSpeed', Math.round((0.8 + v * 4) * 10) / 10)} label="Скорость прокрутки" />
        </div>
        <Toggle checked={p.accel > 0} onChange={(v) => setPref('accel', v ? 1 : 0)} label="Ускорение" hint="Быстрое движение пальца уводит курсор дальше" />
        <Toggle checked={p.natural} onChange={(v) => setPref('natural', v)} label="Естественная прокрутка" hint="Страница едет за пальцами, как на телефоне" />
        <Toggle checked={p.haptics} onChange={(v) => setPref('haptics', v)} label="Вибрация" hint="Короткий отклик на нажатия" />
      </Card>

      <Card label="Подключение" icon="link" span={2}>
        <div class="row wrap">
          <Button icon="desktop" onClick={onSwitch}>Другой ПК</Button>
          <Button variant="danger" icon="trash" onClick={() => {
            const cur = loadSaved().find((x) => x.pc === link.pcId.value)
            if (cur && confirm(`Забыть «${cur.name}»? Для нового подключения понадобится QR или PIN.`)) { forgetPc(cur.pc); link.disconnect(); onSwitch() }
          }}>Забыть этот ПК</Button>
        </div>
      </Card>
    </div>
  )
}

export const viaLabel = (v: Via | null) => (v === 'lan' ? 'Wi-Fi' : v === 'relay' ? 'Интернет' : v === 'bt' ? 'Bluetooth' : '—')
