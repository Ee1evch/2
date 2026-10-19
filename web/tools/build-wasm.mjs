// Собирает фонтанный код RaptorQ (crates/dotlink-fountain) в WebAssembly и кладёт рядом с кодом QR-потока.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = dirname(dirname(fileURLToPath(import.meta.url)))
const root = dirname(web)
execFileSync('cargo', ['build', '-p', 'dotlink-fountain', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: root, stdio: 'inherit' })
const out = join(web, 'src/lib/wasm')
mkdirSync(out, { recursive: true })
copyFileSync(join(root, 'target/wasm32-unknown-unknown/release/dotlink_fountain.wasm'), join(out, 'fountain.wasm'))
console.log('fountain.wasm →', out)
