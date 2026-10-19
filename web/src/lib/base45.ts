// Base45 (RFC 9285): алфавит совпадает с алфавитно-цифровым режимом QR (5,5 бита на символ),
// поэтому бинарные данные упаковываются в QR всего с 3% накладных расходов — и их читает любой сканер.
const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'
const REV = new Int16Array(128).fill(-1)
for (let i = 0; i < A.length; i++) REV[A.charCodeAt(i)] = i

export function b45encode(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) {
    const n = b[i] * 256 + b[i + 1]
    s += A[n % 45] + A[Math.floor(n / 45) % 45] + A[Math.floor(n / 2025)]
  }
  if (b.length % 2) { const n = b[b.length - 1]; s += A[n % 45] + A[Math.floor(n / 45)] }
  return s
}

export function b45decode(s: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor(s.length / 3) * 2 + (s.length % 3 === 2 ? 1 : 0))
  if (s.length % 3 === 1) return null
  let o = 0
  for (let i = 0; i < s.length; i += 3) {
    const c = REV[s.charCodeAt(i)] ?? -1, d = REV[s.charCodeAt(i + 1)] ?? -1
    if (c < 0 || d < 0) return null
    if (i + 2 < s.length) {
      const e = REV[s.charCodeAt(i + 2)] ?? -1
      if (e < 0) return null
      const n = c + d * 45 + e * 2025
      if (n > 0xffff) return null
      out[o++] = n >> 8; out[o++] = n & 0xff
    } else {
      const n = c + d * 45
      if (n > 0xff) return null
      out[o++] = n
    }
  }
  return out
}
