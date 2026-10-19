import { effect, signal } from '@preact/signals'
import { Link } from '../lib/link'
import { DEFAULT_PREFS, type PadPrefs } from './trackpad'
import { setHaptics, toast } from '../ui'

export const link = new Link()

export interface Prefs extends PadPrefs {
  haptics: boolean
  /** скопированное на телефоне уходит в буфер ПК */
  clipAuto: boolean
  /** уведомления телефона видны на ПК */
  notifs: boolean
  /** виджеты на главном экране — по порядку */
  widgets: string[]
}
export const DEFAULT_WIDGETS = ['link', 'media', 'volume', 'sys', 'clip', 'actions', 'window', 'timer']
const KEY = 'dotlink.prefs'
function load(): Prefs {
  const base: Prefs = { ...DEFAULT_PREFS, haptics: true, clipAuto: true, notifs: true, widgets: DEFAULT_WIDGETS }
  try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return base }
}
export const prefs = signal<Prefs>(load())
effect(() => {
  setHaptics(prefs.value.haptics)
  try { localStorage.setItem(KEY, JSON.stringify(prefs.value)) } catch { /* приватный режим */ }
})
export const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => { prefs.value = { ...prefs.value, [k]: v } }

/** Входящие предложения файлов от ПК. */
export const offers = signal<{ name: string; size: number; url: string; at: number }[]>([])
link.on('file-offer', (m) => {
  offers.value = [{ name: m.name, size: m.size, url: m.url, at: Date.now() }, ...offers.value].slice(0, 20)
  toast(`ПК отправляет «${m.name}»`)
})

const DENIED: Record<string, string> = { input: 'Ввод запрещён на ПК', media: 'Медиа запрещены на ПК', power: 'Питание запрещено на ПК', macros: 'Макросы запрещены на ПК', clipboard: 'Буфер запрещён на ПК', files: 'Файлы запрещены на ПК' }
let lastDenied = 0
link.on('denied', (m) => { if (Date.now() - lastDenied > 2000) { lastDenied = Date.now(); toast(DENIED[m.what] || 'Нет доступа', 'err') } })
link.on('error', (m) => { if (m.msg) toast(m.msg, 'err') })
link.on('ok', (m) => { if (m.msg) toast(m.msg) })

/** Страница открыта с самого ПК (PWA по QR), а не из APK. */
export const servedFromPc = location.protocol === 'http:' && !!location.port && location.hostname !== 'localhost'

export function hostUrl(path: string) {
  return `http://${link.host.value}${path}`
}
