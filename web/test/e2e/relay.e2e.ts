// Разные сети: телефон не видит ПК в локальной сети и подключается по QR через ретранслятор
// (настоящий dotlink-relay), поднимает прямой WebRTC, а когда ПК снова виден в сети —
// сам переходит на Wi-Fi без разрыва.
// Запуск: npm run build && cargo build -p dotlink-server -p dotlink-relay && npm run e2e
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import { createServer as tcp } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

const ROOT = resolve(__dirname, '../../..')
const EXE = process.platform === 'win32' ? '.exe' : ''
const BIN = process.env.DOTLINK_SERVER || join(ROOT, 'target/debug/dotlink-server' + EXE)
const RELAY = process.env.DOTLINK_RELAY || join(ROOT, 'target/debug/dotlink-relay' + EXE)
const DIST = resolve(__dirname, '../../dist')
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff': 'font/woff', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' }

let relay: ChildProcess, srv: ChildProcess, site: Server
let relayPort = 0, port = 0, sitePort = 0, pairUrl = ''
let browser: Browser, phone: Page, ctx: BrowserContext

const freePort = () => new Promise<number>((res) => { const s = tcp(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)) }) })

beforeAll(async () => {
  for (const b of [BIN, RELAY]) if (!existsSync(b)) throw new Error(`нет ${b}: cargo build -p dotlink-server -p dotlink-relay`)
  relayPort = await freePort()
  relay = spawn(RELAY, ['--listen', `127.0.0.1:${relayPort}`], { stdio: 'ignore' })
  for (let i = 0; ; i++) {
    try { if ((await (await fetch(`http://127.0.0.1:${relayPort}/healthz`)).text()).startsWith('ok')) break } catch { /* ещё стартует */ }
    if (i > 100) throw new Error('ретранслятор не стартовал')
    await new Promise((r) => setTimeout(r, 50))
  }
  srv = spawn(BIN, ['--port', '0', '--memory', '--mock', '--no-discovery', '--relay', `ws://127.0.0.1:${relayPort}`], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((res, rej) => {
    let out = ''
    srv.stdout!.on('data', (d) => {
      out += d
      const m = out.match(/DOTLINK_READY port=(\d+)/)
      const u = out.match(/Телефон:\s+(\S+)/)
      if (m && u) { port = +m[1]; pairUrl = u[1]; res() }
    })
    srv.on('exit', (c) => rej(new Error('сервер завершился: ' + c)))
  })
  // пульт открыт не с ПК (как установленное приложение): отдельный сайт на localhost
  site = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^([/\\])+/, '')
    const file = join(DIST, path.endsWith('/') || !path ? join(path, 'index.html') : path)
    if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(readFileSync(file))
  })
  sitePort = await new Promise<number>((r) => site.listen(0, '127.0.0.1', () => r((site.address() as any).port)))
  browser = await chromium.launch()
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' })
  phone = await ctx.newPage()
  phone.on('pageerror', (e) => console.error('phone:', e.message))
}, 40_000)

afterAll(async () => {
  await browser?.close()
  srv?.kill(); relay?.kill(); site?.close()
})

describe('DotLink e2e: разные сети', () => {
  it('ПК не виден в сети — сопряжение по QR через ретранслятор и прямой WebRTC', async () => {
    expect(pairUrl).toContain('&rm=')
    // адрес ПК в сети есть, но он недоступен — будто телефон ушёл в мобильный интернет
    await ctx.route(`http://127.0.0.1:${port}/**`, (r) => r.abort('addressunreachable'))
    const hash = new URL(pairUrl).hash.slice(1).split('&').filter((kv) => !kv.startsWith('h=') && !kv.startsWith('p=')).join('&') + `&h=127.0.0.1&p=${port}`
    await phone.goto(`http://localhost:${sitePort}/#${hash}&go=${encodeURIComponent('Привет с ПК')}`)
    await phone.getByRole('tab', { name: 'Система' }).click({ timeout: 15_000 })
    await phone.getByText(/^Интернет/).waitFor({ timeout: 15_000 })
    await phone.getByText('Интернет · напрямую').waitFor({ timeout: 15_000 })
    const saved = await phone.evaluate(() => JSON.parse(localStorage.getItem('dotlink.pcs') || '[]'))
    expect(saved[0].routes.relay.room).toMatch(/^[\w-]{22}$/)
  })

  it('файл через ретранслятор идёт внутри сессии', async () => {
    await phone.getByRole('tab', { name: 'Файлы' }).click()
    const chooser = phone.waitForEvent('filechooser')
    await phone.getByRole('button', { name: 'Выбрать файлы' }).click()
    const body = Buffer.alloc(200_000, 7)
    await (await chooser).setFiles({ name: 'через-интернет.bin', mimeType: 'application/octet-stream', buffer: body })
    await phone.getByText('Файл на ПК — в «Загрузки/DotLink»').waitFor({ timeout: 15_000 })
    const got = readFileSync(join(tmpdir(), 'dotlink-mock-downloads', 'через-интернет.bin'))
    expect(got.equals(body)).toBe(true)
    await phone.getByRole('tab', { name: 'Система' }).click()
  })

  it('ПК снова виден в сети — телефон сам переходит на Wi-Fi', async () => {
    const saved = await phone.evaluate(() => JSON.parse(localStorage.getItem('dotlink.pcs') || '[]'))
    expect(saved[0].hosts).toContain(`127.0.0.1:${port}`)
    await ctx.unroute(`http://127.0.0.1:${port}/**`)
    // вернулись в приложение — телефон проверяет сеть (и сам раз в 15 с)
    await phone.evaluate(() => dispatchEvent(new Event('focus')))
    await phone.getByText(/^Wi-Fi/).waitFor({ timeout: 15_000 })
    await phone.getByText(`127.0.0.1:${port}`).waitFor()
  })
})
