// Wake-on-LAN: «волшебный пакет» — 6 байт 0xFF и 16 повторов MAC сетевой карты ПК.
// Сетевая карта выключенного ПК слушает его и включает компьютер (если WoL разрешён в BIOS
// и в свойствах адаптера). Отправить UDP может только приложение — браузер не умеет.

export interface WolTarget { mac: string; bcast: string }

export function parseMac(mac: string): Uint8Array | null {
  const hex = mac.replace(/[^0-9a-f]/gi, '')
  if (hex.length !== 12) return null
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
}

export function magicPacket(mac: string): Uint8Array | null {
  const m = parseMac(mac)
  if (!m || m.every((b) => b === 0)) return null
  const p = new Uint8Array(6 + 16 * 6).fill(0xff)
  for (let i = 0; i < 16; i++) p.set(m, 6 + i * 6)
  return p
}
