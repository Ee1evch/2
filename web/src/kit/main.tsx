import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  Button, Card, Chip, DotDisplay, DotField, DotGrid, DotIcon, DotMeter, DotSlider, DotSpark, Halftone, IconButton, ICON_NAMES,
  KeyCap, QrDots, Segmented, Sheet, StatusDot, TabBar, Tile, Toasts, Toggle, toast, type DotFieldApi,
} from '../ui'
import './kit.css'

const SWATCHES = [
  ['--bg', 'Фон'], ['--surface', 'Карточка'], ['--surface-2', 'Поднятая'], ['--border-2', 'Рамка'],
  ['--text', 'Текст'], ['--muted', 'Вторичный'], ['--accent', 'Акцент'], ['--ok', 'Успех'], ['--warn', 'Внимание'],
]

function Kit() {
  const [vol, setVol] = useState(0.42)
  const [tog, setTog] = useState(true)
  const [seg, setSeg] = useState<'wifi' | 'usb' | 'hot'>('wifi')
  const [tab, setTab] = useState<'home' | 'pad' | 'files' | 'power'>('home')
  const [sheet, setSheet] = useState(false)
  const [cpu, setCpu] = useState<number[]>(() => Array.from({ length: 40 }, (_, i) => 0.3 + 0.25 * Math.sin(i / 3)))
  const [blocks, setBlocks] = useState(0)
  const [clock, setClock] = useState('12:30')
  const [ctrl, setCtrl] = useState(false)
  const pad = useRef<DotFieldApi | null>(null)

  useEffect(() => {
    const t = setInterval(() => {
      setCpu((c) => [...c.slice(-59), Math.max(0.05, Math.min(1, c[c.length - 1] + (Math.random() - 0.48) * 0.25))])
      setBlocks((b) => (b >= 180 ? 0 : b + 7))
      const d = new Date(); setClock(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'))
    }, 700)
    return () => clearInterval(t)
  }, [])

  return (
    <div class="kit">
      <section class="kit-hero">
        <DotField mode="hero" />
        <div class="kit-hero-in" data-dots-avoid>
          <DotDisplay text="DOTLINK" pitch={7} lit="var(--text)" />
          <h1 class="title">UI Kit</h1>
          <p class="sub">Точечная матрица 5×7, графитовые поверхности, один сигнальный акцент. Общий набор компонентов для пульта на телефоне и дашборда на ПК.</p>
          <div class="row wrap"><Chip state="ok" live>ПК в сети</Chip><Chip tone="accent">4 мс</Chip><Chip>Wi-Fi · 192.168.1.5</Chip></div>
        </div>
      </section>

      <h2 class="label kit-h">Шрифт DotLink Dot</h2>
      <div class="grid kit-cols">
        <Card label="Латиница и цифры" span={2} i={0}>
          <div class="dot kit-type" style={{ fontSize: '34px' }}>ABCDEFGHIJKLM<br />NOPQRSTUVWXYZ<br />0123456789 %:+-/</div>
        </Card>
        <Card label="Кириллица" span={2} i={1}>
          <div class="dot kit-type" style={{ fontSize: '34px' }}>АБВГДЕЁЖЗИЙКЛМН<br />ОПРСТУФХЦЧШЩЪЫЬЭЮЯ</div>
        </Card>
        <Card label="Табло — горят только нужные точки" span={2} i={2}>
          <div class="row" style={{ gap: '18px', flexWrap: 'wrap' }}>
            <DotDisplay text={clock} pitch={9} />
            <DotDisplay text={String(Math.round(vol * 100)).padStart(3, ' ')} pitch={9} lit="var(--accent)" />
          </div>
        </Card>
        <Card label="Палитра" span={2} i={3}>
          <div class="kit-sw">{SWATCHES.map(([v, n]) => <div key={v}><i style={{ background: `var(${v})` }} /><b>{n}</b><small>{v}</small></div>)}</div>
        </Card>
      </div>

      <h2 class="label kit-h">Иконки 9×9</h2>
      <div class="kit-icons">{ICON_NAMES.map((n) => <div key={n}><DotIcon name={n} size={27} /><small>{n}</small></div>)}</div>

      <h2 class="label kit-h">Кнопки</h2>
      <div class="row wrap">
        <Button variant="primary" icon="send">Отправить</Button>
        <Button icon="qr">Показать QR</Button>
        <Button variant="ghost">Отмена</Button>
        <Button variant="danger" icon="power">Выключить</Button>
        <Button size="sm" icon="plus">Макрос</Button>
      </div>
      <div class="row wrap" style={{ marginTop: '12px' }}>
        <IconButton icon="prev" label="Назад" size="lg" />
        <IconButton icon="play" label="Играть" size="xl" variant="primary" />
        <IconButton icon="next" label="Вперёд" size="lg" />
        <IconButton icon="mute" label="Без звука" variant="accent" />
        <IconButton icon="settings" label="Настройки" variant="flat" />
      </div>

      <h2 class="label kit-h">Плитки (выключение — удержанием)</h2>
      <div class="grid" style={{ '--cols': 4 }}>
        <Tile icon="lock" label="Блокировка" sub="Win+L" onClick={() => toast('ПК заблокирован')} />
        <Tile icon="sleep" label="Сон" onClick={() => toast('Сон')} />
        <Tile icon="restart" label="Перезагрузка" sub="удерживайте" hold={900} onConfirm={() => toast('Перезагрузка…')} />
        <Tile icon="power" label="Выключение" sub="удерживайте" tone="danger" hold={900} onConfirm={() => toast('Выключение…', 'err')} />
        <Tile icon="terminal" label="Терминал" sub="макрос" on />
        <Tile icon="bolt" label="Режим игры" sub="3 действия" tone="accent" />
        <Tile icon="apps" label="Все окна" sub="Win+Tab" />
        <Tile icon="display" label="Экран" sub="выключить" />
      </div>

      <h2 class="label kit-h">Управление</h2>
      <div class="grid kit-cols">
        <Card label="Громкость" icon="volume" aside={<span class="dot num" style={{ fontSize: '15px' }}>{Math.round(vol * 100)}</span>} span={2}>
          <DotSlider value={vol} onInput={setVol} label="Громкость" />
        </Card>
        <Card label="Переключатели" span={2}>
          <Toggle checked={tog} onChange={setTog} label="Автозапуск с Windows" hint="DotLink стартует свёрнутым в трей" />
          <Segmented value={seg} onChange={setSeg} options={[{ value: 'wifi', label: 'Wi-Fi' }, { value: 'usb', label: 'USB' }, { value: 'hot', label: 'Хотспот' }]} />
        </Card>
        <Card label="Статусы" span={2}>
          <div class="row wrap" style={{ gap: '14px' }}>
            <span class="row"><StatusDot state="ok" live />В сети</span>
            <span class="row"><StatusDot state="warn" />Медленно</span>
            <span class="row"><StatusDot state="accent" live />Передача</span>
            <span class="row"><StatusDot state="off" />Не в сети</span>
          </div>
        </Card>
        <Card label="Клавиши" span={2}>
          <div class="row wrap">
            <KeyCap label="Ctrl" sub="держать" on={ctrl} onPress={() => setCtrl(!ctrl)} />
            <KeyCap label="C" sub="копир." onPress={() => toast('Ctrl+C')} />
            <KeyCap label="V" sub="вставить" onPress={() => toast('Ctrl+V')} />
            <KeyCap label="Alt+Tab" onPress={() => toast('Alt+Tab')} />
            <KeyCap label="Win+D" onPress={() => toast('Win+D')} />
            <KeyCap label="Esc" onPress={() => {}} />
          </div>
        </Card>
      </div>

      <h2 class="label kit-h">Виджеты</h2>
      <div class="grid kit-cols">
        <Card label="Сейчас играет" icon="media" span={2} i={0}>
          <div class="row" style={{ gap: '14px', alignItems: 'flex-start' }}>
            <Halftone size={96} grid={22} />
            <div class="grow">
              <b style={{ fontSize: '16px' }}>Midnight City</b>
              <div class="muted">M83 · Spotify</div>
              <div class="row" style={{ marginTop: '12px' }}>
                <IconButton icon="prev" label="Назад" />
                <IconButton icon="pause" label="Пауза" size="lg" variant="primary" />
                <IconButton icon="next" label="Вперёд" />
              </div>
            </div>
          </div>
        </Card>
        <Card label="Процессор" icon="cpu" aside={<span class="dot num" style={{ fontSize: '15px' }}>{Math.round(cpu[cpu.length - 1] * 100)}%</span>} i={1}>
          <DotSpark values={cpu} />
        </Card>
        <Card label="Память" icon="ram" aside={<span class="dot num" style={{ fontSize: '15px' }}>11.2</span>} i={2}>
          <DotMeter value={0.7} />
          <span class="muted" style={{ fontSize: '12px' }}>11,2 из 16 ГБ</span>
        </Card>
        <Card label="Передача по QR · фото.jpg" icon="qr" span={2} i={3}>
          <DotGrid total={180} have={(i) => i < blocks} fresh={(i) => i >= blocks - 7 && i < blocks} />
          <div class="row"><span class="muted grow">{blocks} из 180 блоков</span><span class="dot num">{Math.round((blocks / 180) * 100)}%</span></div>
        </Card>
        <Card label="Подключение" icon="link" span={2} tone="raised" i={4}>
          <div class="row" style={{ gap: '16px', alignItems: 'center' }}>
            <QrDots text="http://192.168.1.5:47800/#p=Zm9vYmFyYmF6cXV4MTIz&id=a1b2c3" size={150} />
            <div class="stack" style={{ gap: '6px' }}>
              <span class="label">PIN</span>
              <DotDisplay text="482 913" pitch={6} />
              <span class="muted" style={{ fontSize: '12px' }}>действует 2 мин</span>
            </div>
          </div>
        </Card>
      </div>

      <h2 class="label kit-h">Тачпад — точки следуют за пальцем</h2>
      <div class="kit-pad"
        onPointerDown={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); pad.current?.ripple(e.clientX - r.left, e.clientY - r.top); pad.current?.touch(e.pointerId, e.clientX - r.left, e.clientY - r.top) }}
        onPointerMove={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); if (e.buttons || e.pointerType === 'touch') pad.current?.touch(e.pointerId, e.clientX - r.left, e.clientY - r.top) }}
        onPointerUp={(e) => pad.current?.release(e.pointerId)} onPointerLeave={(e) => pad.current?.release(e.pointerId)}>
        <DotField mode="pad" apiRef={pad} />
      </div>

      <h2 class="label kit-h">Навигация и окна</h2>
      <TabBar value={tab} onChange={setTab} items={[
        { id: 'home', icon: 'home', label: 'Пульт' }, { id: 'pad', icon: 'pad', label: 'Тачпад' },
        { id: 'files', icon: 'files', label: 'Файлы' }, { id: 'power', icon: 'power', label: 'Система' },
      ]} />
      <div class="row wrap" style={{ marginTop: '12px' }}>
        <Button onClick={() => setSheet(true)}>Открыть шторку</Button>
        <Button onClick={() => toast('Скопировано в буфер ПК')}>Уведомление</Button>
        <Button variant="danger" onClick={() => toast('Нет связи с ПК', 'err')}>Ошибка</Button>
      </div>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="Таймер выключения">
        <div class="grid" style={{ '--cols': 4 }}>
          {['15', '30', '60', '90'].map((m) => <Tile key={m} icon="timer" label={m + ' мин'} onClick={() => { setSheet(false); toast('Выключение через ' + m + ' мин') }} />)}
        </div>
      </Sheet>
      <Toasts />
    </div>
  )
}

render(<Kit />, document.getElementById('app')!)
