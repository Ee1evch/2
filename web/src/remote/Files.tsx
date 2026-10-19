import { useEffect, useState } from 'preact/hooks'
import { Button, Card, DotMeter, toast } from '../ui'
import { fileToPayload, formatBytes, pickFiles, timeAgo } from '../lib/format'
import { cameraAvailable } from '../lib/qrscan'
import type { Payload } from '../lib/qrstream'
import { QrReceiveView, QrSendView } from '../features/QrStream'
import { copyText, readText, saveBytes, saveFromUrl, uploadShared } from './native'
import { hostUrl, link, offers, sharedQueue } from './state'

interface Up { name: string; size: number; done: number; state: 'up' | 'ok' | 'err' }

/** Загрузка на ПК: билет по защищённому каналу, сами байты — отдельным HTTP-запросом. */
async function ticket(name: string, size: number): Promise<string> {
  const wait = link.once('ticket', (m) => m.name === name)
  link.json({ t: 'upload', name, size: size >= 0 ? size : null })
  return hostUrl((await wait).url)
}

function put(url: string, file: File, onProgress: (n: number) => void): Promise<void> {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest()
    x.open('PUT', url)
    x.upload.onprogress = (e) => onProgress(e.loaded)
    x.onload = () => (x.status < 300 ? res() : rej(new Error(JSON.parse(x.responseText || '{}').error || x.statusText)))
    x.onerror = () => rej(new Error('сеть'))
    x.send(file)
  })
}

export function Files() {
  const [ups, setUps] = useState<Up[]>([])
  const [send, setSend] = useState<Payload | null>(null)
  const [recv, setRecv] = useState(false)
  const [note, setNote] = useState('')
  const clip = link.get<any>('clip').value
  const perms = link.perms.value

  const upd = (name: string, p: Partial<Up>) => setUps((u) => u.map((x) => (x.name === name ? { ...x, ...p } : x)))
  const upload = async (files: File[]) => {
    setUps((u) => [...files.map((f) => ({ name: f.name, size: f.size, done: 0, state: 'up' as const })), ...u].slice(0, 12))
    for (const f of files) {
      try {
        await put(await ticket(f.name, f.size), f, (n) => upd(f.name, { done: n }))
        upd(f.name, { done: f.size, state: 'ok' })
      } catch (e) {
        upd(f.name, { state: 'err' })
        toast(`«${f.name}»: ${(e as Error).message}`, 'err')
      }
    }
    toast(files.length > 1 ? `Отправлено файлов: ${files.length}` : 'Файл на ПК — в «Загрузки/DotLink»')
  }

  // «Поделиться → DotLink» из других приложений Android: файлы уходят на ПК
  const queue = sharedQueue.value
  useEffect(() => {
    if (!queue.length || !link.online) return
    sharedQueue.value = []
    void (async () => {
      for (const f of queue) {
        try {
          setUps((u) => [{ name: f.name, size: f.size, done: 0, state: 'up' as const }, ...u])
          await uploadShared(f.uri, await ticket(f.name, f.size))
          upd(f.name, { done: f.size, state: 'ok' })
          toast(`«${f.name}» отправлен на ПК`)
        } catch (e) { upd(f.name, { state: 'err' }); toast(String((e as Error).message || e), 'err') }
      }
    })()
  }, [queue, link.status.value])

  return (
    <div class="grid home-grid">
      <Card label="На ПК" icon="upload" span={2} i={0}>
        <Button variant="primary" icon="upload" block disabled={!perms?.files} onClick={async () => { const f = await pickFiles(); if (f.length) void upload(f) }}>Выбрать файлы</Button>
        {ups.map((u) => (
          <div key={u.name} class="up-row">
            <span class="ellipsis grow">{u.name}</span>
            <span class="muted num small">{u.state === 'err' ? 'ошибка' : u.state === 'ok' ? formatBytes(u.size) : `${Math.round((u.done / Math.max(1, u.size)) * 100)}%`}</span>
            <DotMeter value={u.done / Math.max(1, u.size)} pitch={5} rows={1} />
          </div>
        ))}
      </Card>

      {offers.value.length > 0 && (
        <Card label="С ПК" icon="download" span={2} i={1}>
          {offers.value.map((o) => (
            <div key={o.url} class="up-row">
              <span class="grow"><b class="ellipsis">{o.name}</b><span class="muted small">{formatBytes(o.size)} · {timeAgo(o.at)}</span></span>
              <Button size="sm" icon="download" onClick={async () => {
                try { const where = await saveFromUrl(hostUrl(o.url), o.name); toast(`Сохранено: ${where}`); offers.value = offers.value.filter((x) => x !== o) }
                catch (e) { toast('Не удалось скачать: ' + (e as Error).message, 'err') }
              }}>Скачать</Button>
            </div>
          ))}
        </Card>
      )}

      <Card label="Буфер обмена" icon="clipboard" span={2} i={2}>
        {!perms?.clipboard ? <span class="muted">Буфер запрещён в настройках на ПК</span> : <>
          {clip?.kind === 'text' && (
            <div class="clip-box">
              <span class="label">{clip.from === 'phone' ? 'С телефона' : 'Скопировано на ПК'}</span>
              <p class="clip-text">{clip.text}</p>
              <Button size="sm" icon="copy" onClick={async () => toast((await copyText(clip.text)) ? 'Скопировано на телефон' : 'Не удалось скопировать', )}>Скопировать сюда</Button>
            </div>
          )}
          {clip?.kind === 'files' && (
            <div class="clip-box">
              <span class="label">Файлы в буфере ПК</span>
              <p class="clip-text">{clip.files.join(', ')}</p>
              <Button size="sm" icon="download" onClick={() => link.json({ t: 'clip-files' })}>Получить файлы</Button>
            </div>
          )}
          <textarea class="input" rows={3} placeholder="Текст для буфера ПК" value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
          <div class="row wrap">
            <Button variant="primary" size="sm" icon="send" disabled={!note} onClick={() => { link.json({ t: 'clip-set', text: note }); setNote('') }}>В буфер ПК</Button>
            <Button size="sm" icon="clipboard" onClick={async () => { const t = await readText(); if (t) setNote(t); else toast('Телефон не дал прочитать буфер — вставьте вручную', 'err') }}>Вставить с телефона</Button>
          </div>
        </>}
      </Card>

      <Card label="Передача QR-кодами · без сети" icon="qr" span={2} i={3}>
        <p class="muted small" style={{ margin: 0 }}>Файл идёт потоком QR-кодов с экрана на камеру. Пригодится, когда нет никакой сети. Скорость 30–150 КБ/с — для документов и фото.</p>
        <div class="row wrap">
          <Button icon="qr" onClick={async () => { const [f] = await pickFiles(false); if (f) setSend(await fileToPayload(f)) }}>Показать файл</Button>
          <Button icon="camera" disabled={!cameraAvailable()} onClick={() => setRecv(true)}>Принять с экрана ПК</Button>
        </div>
        {!cameraAvailable() && <span class="muted small">Приём камерой работает в приложении DotLink для Android.</span>}
      </Card>

      {send && <QrSendView payload={send} compact onClose={() => setSend(null)} />}
      {recv && <QrReceiveView onClose={() => setRecv(false)} onFile={async (p) => { const where = await saveBytes(p.bytes, p.name, p.type); toast(`Сохранено: ${where}`); setRecv(false) }} />}
    </div>
  )
}
