// Генерирует точечный шрифт «DotLink Dot» (WOFF) из матриц src/ui/dotglyphs.js.
// Каждая горящая точка — круг; шаг сетки 100 из 1000 единиц, диаметр точки 80.
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import { GLYPHS } from '../src/ui/dotglyphs.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(root, 'src/ui/fonts/DotLinkDot.woff')

const PITCH = 100, R = 40, ADVANCE = 600, K = 0.5523 * R

function circle(path, cx, cy) {
  // против часовой стрелки — внешний контур CFF
  path.moveTo(cx + R, cy)
  path.curveTo(cx + R, cy + K, cx + K, cy + R, cx, cy + R)
  path.curveTo(cx - K, cy + R, cx - R, cy + K, cx - R, cy)
  path.curveTo(cx - R, cy - K, cx - K, cy - R, cx, cy - R)
  path.curveTo(cx + K, cy - R, cx + R, cy - K, cx + R, cy)
  path.close()
}

function glyphPath(rows) {
  const path = new opentype.Path()
  const top = rows.length === 8 ? -1 : 0 // восьмая строка — над заглавной
  rows.forEach((line, i) => {
    const r = i + top // 0 — верх заглавной, 6 — низ
    for (let c = 0; c < line.length; c++) if (line[c] === '#') circle(path, 100 + c * PITCH, (6 - r) * PITCH + PITCH / 2)
  })
  return path
}

const glyphs = [new opentype.Glyph({ name: '.notdef', advanceWidth: ADVANCE, path: new opentype.Path() })]
for (const [ch, rows] of Object.entries(GLYPHS)) {
  const cp = ch.codePointAt(0)
  const g = new opentype.Glyph({ name: 'u' + cp.toString(16).toUpperCase().padStart(4, '0'), unicode: cp, advanceWidth: ADVANCE, path: glyphPath(rows) })
  const lower = ch.toLowerCase()
  if (lower !== ch && !GLYPHS[lower]) g.addUnicode(lower.codePointAt(0))
  if (ch === ' ') g.addUnicode(0xa0)
  glyphs.push(g)
}

const font = new opentype.Font({
  familyName: 'DotLink Dot', styleName: 'Regular', unitsPerEm: 1000, ascender: 850, descender: -250,
  designer: 'DotLink', manufacturer: 'DotLink', license: 'MIT', version: '1.0', glyphs,
})
const sfnt = Buffer.from(font.toArrayBuffer())

// sfnt → WOFF 1.0: каждая таблица сжимается zlib (если так меньше).
function toWoff(buf) {
  const flavor = buf.readUInt32BE(0), numTables = buf.readUInt16BE(4)
  const tables = []
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16
    const tag = buf.readUInt32BE(o), checksum = buf.readUInt32BE(o + 4), off = buf.readUInt32BE(o + 8), len = buf.readUInt32BE(o + 12)
    const data = buf.subarray(off, off + len), z = deflateSync(data, { level: 9 })
    tables.push({ tag, checksum, origLength: len, data: z.length < len ? z : data })
  }
  const pad4 = (n) => (n + 3) & ~3
  let offset = 44 + numTables * 20
  const parts = []
  const dir = Buffer.alloc(numTables * 20)
  tables.forEach((t, i) => {
    dir.writeUInt32BE(t.tag, i * 20); dir.writeUInt32BE(offset, i * 20 + 4); dir.writeUInt32BE(t.data.length, i * 20 + 8)
    dir.writeUInt32BE(t.origLength, i * 20 + 12); dir.writeUInt32BE(t.checksum, i * 20 + 16)
    const padded = Buffer.alloc(pad4(t.data.length)); t.data.copy(padded); parts.push(padded)
    offset += padded.length
  })
  const header = Buffer.alloc(44)
  header.writeUInt32BE(0x774f4646, 0); header.writeUInt32BE(flavor, 4); header.writeUInt32BE(offset, 8)
  header.writeUInt16BE(numTables, 12); header.writeUInt32BE(pad4(buf.length), 16); header.writeUInt16BE(1, 20)
  return Buffer.concat([header, dir, ...parts])
}

mkdirSync(dirname(OUT), { recursive: true })
const woff = toWoff(sfnt)
writeFileSync(OUT, woff)
console.log(`dot font: ${glyphs.length - 1} glyphs, ${(woff.length / 1024).toFixed(1)} KB → ${OUT}`)
