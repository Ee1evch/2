// base64 без зависимостей: ядро принимает любой алфавит, мы шлём стандартный.
export function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function unb64(s: string): Uint8Array {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const bin = atob(t + '==='.slice((t.length + 3) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const utf8 = (s: string) => new TextEncoder().encode(s)
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Случайные байты: crypto.getRandomValues доступен и вне HTTPS. */
export function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}
