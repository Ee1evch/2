import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { createPortal } from 'preact/compat'
import { Button, DotDisplay, DotGrid, IconButton, Segmented, haptic } from '../ui'
import { DENSITY, drawGrid, layout, pack, QrReceiver, QrSender, type Density, type Payload } from '../lib/qrstream'
import { cameraAvailable, QrScanner, type ScanStats } from '../lib/qrscan'
import { formatBytes } from '../lib/format'
import './features.css'

async function keepAwake(): Promise<() => void> {
  try {
    const lock = await (navigator as any).wakeLock?.request('screen')
    return () => { void lock?.release() }
  } catch { return () => {} }
}

/** Экран отправки: сетка QR-кодов, сменяющихся с заданной частотой. */
export function QrSendView({ payload, onClose, compact }: { payload: Payload; onClose: () => void; compact?: boolean }) {
  const [density, setDensity] = useState<Density>(compact ? 'reliable' : 'fast')
  const [fps, setFps] = useState(DENSITY[compact ? 'reliable' : 'fast'].fps)
  const [sender, setSender] = useState<QrSender | null>(null)
  const [grid, setGrid] = useState({ cols: 1, rows: 1, module: 1 })
  const [sent, setSent] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const blob = useMemo(() => pack(payload), [payload])

  useEffect(() => {
    let alive = true, s: QrSender | null = null
    blob.then((b) => QrSender.create(b, density)).then((x) => { if (alive) { s = x; setSender(x) } else x.free() }, (e) => setErr(String(e)))
    return () => { alive = false; s?.free() }
  }, [blob, density])

  useEffect(() => {
    let release = () => {}
    void keepAwake().then((r) => { release = r })
    return () => release()
  }, [])

  useEffect(() => {
    if (!sender) return
    const cv = canvas.current!
    const g = cv.getContext('2d', { alpha: false })!
    const dpr = Math.min(3, devicePixelRatio || 1)
    let l = grid
    const fit = () => {
      const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr)
      cv.width = w; cv.height = h
      l = layout(w, h, 17 + 4 * sender.version, Math.round(DENSITY[density].minModule * dpr))
      setGrid(l)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(cv)
    let next = sender.take(l.cols * l.rows)
    const tick = () => {
      drawGrid(g, next, cv.width, cv.height, l.cols, l.rows, l.module)
      setSent(sender.sent)
      next = sender.take(l.cols * l.rows) // следующий кадр готовим заранее
    }
    tick()
    const t = setInterval(tick, 1000 / fps)
    return () => { clearInterval(t); ro.disconnect() }
  }, [sender, fps])

  const per = grid.cols * grid.rows
  const symbol = sender?.enc.symbol ?? 0
  const rate = symbol * per * fps
  const k = sender?.k ?? 0
  const eta = k && per ? Math.ceil((k * 1.25) / (per * fps)) : 0

  return createPortal(
    <div class="qr-full">
      <canvas ref={canvas} class="qr-canvas" aria-label="Поток QR-кодов" />
      <div class="qr-bar">
        <div class="row" style={{ gap: '14px' }}>
          <IconButton icon="close" label="Остановить" onClick={onClose} />
          <div class="grow" style={{ minWidth: 0 }}>
            <b class="ellipsis">{payload.name}</b>
            <div class="muted num" style={{ fontSize: '12px' }}>
              {err ? err : `${formatBytes(payload.bytes.length)} · ${per} QR × ${fps} к/с · ~${formatBytes(rate)}/с · ~${eta} с`}
            </div>
          </div>
          <DotDisplay text={String(sent).padStart(4, ' ')} pitch={3} />
        </div>
        <div class="row wrap" style={{ gap: '8px' }}>
          <Segmented value={density} onChange={(d) => { setDensity(d); setFps(DENSITY[d].fps) }} options={(Object.keys(DENSITY) as Density[]).map((d) => ({ value: d, label: DENSITY[d].label }))} />
          <Segmented value={fps} onChange={setFps} options={[8, 12, 15, 20].map((f) => ({ value: f, label: f + ' к/с' }))} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Экран приёма: камера читает все QR в кадре, матрица точек показывает собранные блоки. */
export function QrReceiveView({ onFile, onClose, facing = 'environment' }: { onFile: (p: Payload) => void | Promise<void>; onClose: () => void; facing?: 'environment' | 'user' }) {
  const video = useRef<HTMLVideoElement>(null)
  const [prog, setProg] = useState({ have: 0, k: 0 })
  const [stats, setStats] = useState<ScanStats | null>(null)
  const [result, setResult] = useState<Payload | null>(null)
  const [err, setErr] = useState<string | null>(cameraAvailable() ? null : 'Камера доступна в приложении DotLink для Android и в дашборде на ПК. В браузере по адресу http:// её открыть нельзя.')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (err) return
    let scanner: QrScanner | null = null, rx: QrReceiver | null = null, alive = true, raf = 0
    void (async () => {
      try {
        rx = await QrReceiver.create()
        rx.onProgress = (p) => {
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; setProg({ have: p.have, k: p.k }) })
          if (p.have === 1) haptic('tick')
        }
        rx.onDone = (p) => { haptic('heavy'); setResult(p); scanner?.stop() }
        scanner = new QrScanner(video.current!, (texts) => texts.forEach((t) => rx!.accept(t)))
        await scanner.start(facing)
        if (!alive) scanner.stop()
      } catch (e) {
        setErr('Нет доступа к камере: ' + ((e as Error).message || e))
      }
    })()
    const st = setInterval(() => scanner && setStats(scanner.stats), 700)
    return () => { alive = false; clearInterval(st); scanner?.stop(); rx?.free() }
  }, [])

  const pct = prog.k ? Math.min(99, Math.floor((prog.have / prog.k) * 100)) : 0
  return createPortal(
    <div class="qr-full dark">
      <video ref={video} class="qr-video" playsInline muted />
      <div class="qr-aim" aria-hidden="true"><i /><i /><i /><i /></div>
      <div class="qr-bar">
        <div class="row" style={{ gap: '14px' }}>
          <IconButton icon="close" label="Закрыть" onClick={onClose} />
          <div class="grow">
            <b>{result ? result.name : prog.have ? 'Принимаю поток…' : 'Наведите камеру на QR-коды'}</b>
            <div class="muted num" style={{ fontSize: '12px' }}>
              {err ?? (result ? formatBytes(result.bytes.length) : `${prog.have} из ~${prog.k || '?'} пакетов${stats ? ` · ${stats.codes} QR/с · ${stats.engine === 'native' ? 'нативный' : 'zxing'}` : ''}`)}
            </div>
          </div>
          <DotDisplay text={result ? 'OK' : String(pct).padStart(2, ' ') + '%'} pitch={3} lit={result ? 'var(--ok)' : 'var(--text)'} />
        </div>
        {prog.k > 0 && !result && <DotGrid total={prog.k} have={(i) => i < prog.have} pitch={7} />}
        {result && (
          <div class="row">
            <Button variant="primary" icon="download" disabled={saving} onClick={async () => { setSaving(true); try { await onFile(result) } finally { setSaving(false) } }}>Сохранить</Button>
            <Button variant="ghost" onClick={onClose}>Готово</Button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
