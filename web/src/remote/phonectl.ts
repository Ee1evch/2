// Телефон глазами ПК: трансляция экрана, жесты и текст с ПК, мышь ПК на телефоне (как Universal
// Control), уведомления на ПК, «Поделиться → DotLink». Всё это умеет только приложение для Android:
// в браузере ПК получает честный ответ, что функция недоступна.

import { signal } from '@preact/signals'
import { unb64 } from '../lib/b64'
import { OP } from '../lib/proto'
import { toast } from '../ui'
import { handoffText } from './continuity'
import { btPipe, control, cursor, isNative, mirror, nativeStatus, onNative, openSettings, sharedItems, type MirrorFrame } from './native'
import { link, prefs, sharedQueue } from './state'

export const mirroring = signal(false)
/** Мышь ПК сейчас на телефоне. */
export const ucActive = signal(false)

const MAX_BACKLOG = 1_500_000

/** Сообщить ПК о том, чего телефон сделать не может, — видно в дашборде и в уведомлениях Windows. */
let lastNotice = ''
function notice(title: string, text: string) {
  const k = title + text
  if (k === lastNotice) return
  lastNotice = k
  setTimeout(() => { if (lastNotice === k) lastNotice = '' }, 60_000)
  link.json({ t: 'notify', app: 'DotLink', title, text })
}

const NEED_CONTROL = ['Управление телефоном выключено', 'На телефоне: Настройки → Спец. возможности → «DotLink: управление с ПК»']

function needControl() {
  notice(NEED_CONTROL[0], NEED_CONTROL[1])
  toast('ПК хочет управлять телефоном — включите службу DotLink', 'err')
  void openSettings('accessibility')
}

// ───────── трансляция ─────────

let needKey = false

function sendFrame(e: MirrorFrame) {
  const data = unb64(e.d)
  const key = (e.f & 1) !== 0, config = (e.f & 2) !== 0
  // сеть не успевает — пропускаем кадры до следующего ключевого, чтобы не копить задержку
  if (link.backlog > MAX_BACKLOG && !config) { needKey = true; return }
  if (needKey && !key && !config) {
    if (link.backlog < MAX_BACKLOG / 4) { needKey = false; void mirror.key() }
    return
  }
  if (key) needKey = false
  const b = new Uint8Array(10 + data.length)
  const v = new DataView(b.buffer)
  b[0] = OP.MIRROR
  b[1] = e.f
  v.setUint32(2, e.t >>> 0, true)
  v.setUint16(6, e.w, true)
  v.setUint16(8, e.h, true)
  b.set(data, 10)
  link.bulk(b)
}

link.on('mirror-req', async (m) => {
  if (!isNative()) {
    notice('Трансляция экрана недоступна', 'Нужно приложение DotLink для Android — в браузере Android не отдаёт экран')
    return
  }
  try {
    if (!m.on) await mirror.stop()
    else if (mirroring.value) await mirror.key(m.bitrate || undefined)
    else await mirror.start({ max: m.max || 1280, bitrate: m.bitrate || 6_000_000, fps: 60 })
  } catch (e) {
    notice('Трансляция не началась', (e as Error).message || 'отклонено на телефоне')
  }
})

// ───────── жесты и кнопки с ПК ─────────

link.on('ctl', async (m) => {
  if (!isNative()) { notice('Управление телефоном недоступно', 'Нужно приложение DotLink для Android'); return }
  try { await control(m) } catch (e) {
    if ((e as Error).message === 'no-accessibility') needControl()
  }
})

// ───────── мышь ПК на телефоне ─────────

let pend = { dx: 0, dy: 0 }, raf = 0
const flushCursor = () => {
  raf = 0
  const { dx, dy } = pend
  pend = { dx: 0, dy: 0 }
  if (dx || dy) void cursor('move', { dx, dy }).catch(() => {})
}

link.on('uc', async (m) => {
  ucActive.value = !!m.on
  if (!isNative()) {
    if (m.on) { notice('Мышь ПК на телефоне недоступна', 'Нужно приложение DotLink для Android'); link.json({ t: 'uc-exit' }) }
    return
  }
  try {
    await cursor(m.on ? 'show' : 'hide')
    if (m.on) toast('Мышь ПК на телефоне · Esc на ПК — вернуть')
  } catch {
    if (m.on) { needControl(); link.json({ t: 'uc-exit' }) }
  }
})

link.on('bin', (d: Uint8Array) => {
  if (!ucActive.value || !isNative()) return
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  switch (d[0]) {
    case OP.UC_MOVE:
      pend.dx += v.getInt16(1, true); pend.dy += v.getInt16(3, true)
      if (!raf) raf = requestAnimationFrame(flushCursor)
      break
    case OP.UC_BUTTON:
      flushCursor()
      void cursor('button', { b: d[1], down: d[2] === 1 }).catch(() => {})
      break
    case OP.UC_SCROLL:
      void cursor('scroll', { v: v.getInt16(1, true), h: v.getInt16(3, true) }).catch(() => {})
      break
  }
})

// клавиатура ПК: текст — в поле в фокусе, служебные клавиши — действиями
const VK_KEYS: Record<number, string> = { 8: 'backspace', 46: 'delete', 13: 'enter', 37: 'left', 39: 'right', 36: 'home-line', 35: 'end' }
const CTRL_KEYS: Record<number, string> = { 0x41: 'select-all', 0x43: 'copy', 0x56: 'paste', 0x58: 'cut' }
let ctrl = false
link.on('uc-key', (m) => {
  if (m.vk === 0x11 || m.vk === 0xa2 || m.vk === 0xa3) { ctrl = !!m.down; return }
  if (!m.down || !isNative()) return
  const k = ctrl ? CTRL_KEYS[m.vk] : VK_KEYS[m.vk]
  if (k) void control({ a: 'key', key: k }).catch(() => {})
})
link.on('uc-text', (m) => { if (isNative() && !ctrl) void control({ a: 'text', text: m.text }).catch(() => {}) })

// ───────── уведомления, «Поделиться», Bluetooth ─────────

if (isNative()) {
  onNative('mirrorFrame', sendFrame)
  onNative('mirrorState', (s) => {
    mirroring.value = !!s.on
    link.json({ t: 'mirror', on: !!s.on, w: s.w || 0, h: s.h || 0, codec: s.codec || 'avc' })
    if (s.error) notice('Трансляция остановлена', s.error)
  })
  onNative('notification', (n) => {
    if (prefs.value.notifs && link.online) link.json({ t: 'notify', app: n.app, title: n.title, text: n.text })
  })
  const take = async () => {
    if (!link.online) return
    const { files, texts } = await sharedItems()
    for (const t of texts) handoffText(t)
    if (files.length) sharedQueue.value = [...sharedQueue.value, ...files]
  }
  onNative('shared', () => void take())
  link.status.subscribe((s) => { if (s === 'online') void take() })
  link.btOpener = btPipe
}

/** Что разрешено на телефоне — для экрана «Система». */
export const caps = signal<Awaited<ReturnType<typeof nativeStatus>>>(null)
export async function refreshCaps() { caps.value = await nativeStatus() }
if (isNative() && typeof document !== 'undefined') {
  void refreshCaps()
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshCaps() })
}
