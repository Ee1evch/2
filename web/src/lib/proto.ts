// Бинарные кадры частых событий — зеркало crates/dotlink-core/src/proto.rs.

export const OP = { MOVE: 1, SCROLL: 2, BUTTON: 3, KEY: 4, TEXT: 5, CHORD: 6, VOLUME: 7, PING: 8, MOVE_T: 9, MIRROR: 0x0a, FILE: 0x0b, SCREEN: 0x0c, POINTER: 0x0d, UC_MOVE: 0x20, UC_BUTTON: 0x21, UC_SCROLL: 0x22 } as const

const i16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)))

function frame(op: number, ...i16s: number[]): Uint8Array {
  const b = new Uint8Array(1 + i16s.length * 2)
  const d = new DataView(b.buffer)
  b[0] = op
  i16s.forEach((v, i) => d.setInt16(1 + i * 2, i16(v), true))
  return b
}

/** dx, dy — в четвертях пикселя. */
export const moveFrame = (qx: number, qy: number) => frame(OP.MOVE, qx, qy)
/** Движение с временем касания (мс, по кругу u32) — ПК проигрывает путь в ритме пальца. */
export function moveTFrame(qx: number, qy: number, t: number): Uint8Array {
  const b = new Uint8Array(9)
  const d = new DataView(b.buffer)
  b[0] = OP.MOVE_T
  d.setInt16(1, i16(qx), true); d.setInt16(3, i16(qy), true)
  d.setUint32(5, Math.round(t) >>> 0, true)
  return b
}
export type PointerAction = 'move' | 'down' | 'up' | 'click' | 'right' | 'double'
const PTR: Record<PointerAction, number> = { move: 0, down: 1, up: 2, click: 3, right: 4, double: 5 }
/** Указатель на экране ПК: x, y — доли монитора 0..1. */
export function pointerFrame(fx: number, fy: number, a: PointerAction): Uint8Array {
  const b = new Uint8Array(6)
  const d = new DataView(b.buffer)
  b[0] = OP.POINTER
  d.setUint16(1, Math.round(Math.max(0, Math.min(1, fx)) * 65535), true)
  d.setUint16(3, Math.round(Math.max(0, Math.min(1, fy)) * 65535), true)
  b[5] = PTR[a]
  return b
}
/** v, h — единицы колеса Windows (120 = щелчок); дробные — плавная прокрутка. */
export const scrollFrame = (v: number, h: number) => frame(OP.SCROLL, v, h)

export type Btn = 'left' | 'right' | 'middle'
export type BtnAction = 'up' | 'down' | 'click' | 'double'
export function buttonFrame(b: Btn, a: BtnAction): Uint8Array {
  return new Uint8Array([OP.BUTTON, { left: 0, right: 1, middle: 2 }[b], { up: 0, down: 1, click: 2, double: 3 }[a]])
}

export function keyFrame(vk: number, a: 'up' | 'down' | 'press' = 'press'): Uint8Array {
  return new Uint8Array([OP.KEY, vk & 0xff, vk >> 8, { up: 0, down: 1, press: 2 }[a]])
}

export function chordFrame(vks: number[]): Uint8Array {
  const b = new Uint8Array(2 + vks.length * 2)
  b[0] = OP.CHORD; b[1] = vks.length
  vks.forEach((k, i) => { b[2 + i * 2] = k & 0xff; b[3 + i * 2] = k >> 8 })
  return b
}

export function textFrame(text: string): Uint8Array {
  const t = new TextEncoder().encode(text)
  const b = new Uint8Array(1 + t.length)
  b[0] = OP.TEXT; b.set(t, 1)
  return b
}

export function volumeFrame(level: number, seq: number): Uint8Array {
  const b = new Uint8Array(5)
  const d = new DataView(b.buffer)
  b[0] = OP.VOLUME
  d.setUint16(1, Math.round(Math.max(0, Math.min(1, level)) * 10000), true)
  d.setUint16(3, seq & 0xffff, true)
  return b
}

export function pingFrame(t: number): Uint8Array {
  const b = new Uint8Array(5)
  b[0] = OP.PING
  new DataView(b.buffer).setUint32(1, t >>> 0, true)
  return b
}

/** Виртуальные коды клавиш Windows. */
export const VK = {
  BACK: 0x08, TAB: 0x09, ENTER: 0x0d, SHIFT: 0x10, CTRL: 0x11, ALT: 0x12, CAPS: 0x14, ESC: 0x1b, SPACE: 0x20,
  PGUP: 0x21, PGDN: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  PRTSC: 0x2c, INS: 0x2d, DEL: 0x2e, WIN: 0x5b, MENU: 0x5d,
  VOL_MUTE: 0xad, VOL_DOWN: 0xae, VOL_UP: 0xaf, NEXT: 0xb0, PREV: 0xb1, PLAY: 0xb3,
  F: (n: number) => 0x6f + n,
  key: (c: string) => c.toUpperCase().charCodeAt(0),
} as const

export type MediaAction = 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'stop'
export type PowerAction = 'lock' | 'sleep' | 'hibernate' | 'restart' | 'shutdown' | 'logoff' | 'display-off'
