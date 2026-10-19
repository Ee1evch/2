// Сквозная проверка на настоящем ядре (имитация ПК) и настоящем браузере:
// сопряжение по QR → тачпад, клавиатура, громкость, медиа → файлы → дашборд → QR-поток → отзыв устройства.
// Запуск: npm run build && cargo build -p dotlink-server && npm run e2e
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import { QrReceiver } from '../../src/lib/qrstream'

const ROOT = resolve(__dirname, '../../..')
const BIN = process.env.DOTLINK_SERVER || join(ROOT, 'target/debug/dotlink-server' + (process.platform === 'win32' ? '.exe' : ''))
const SHOTS = process.env.E2E_SHOTS || join(tmpdir(), 'dotlink-e2e')

let srv: ChildProcess
let port = 0
let pairUrl = ''
let adminToken = ''
let browser: Browser
let phoneCtx: BrowserContext
let phone: Page
let dash: Page

async function events(): Promise<any[]> {
  return (await (await fetch(`http://127.0.0.1:${port}/api/debug/events`)).json()).map((e: any) => e.e)
}
async function waitFor<T>(f: () => Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('не дождались')
    await new Promise((r) => setTimeout(r, 50))
  }
}
const shot = (p: Page, name: string) => p.screenshot({ path: join(SHOTS, name + '.png') })

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error(`нет ${BIN}: cargo build -p dotlink-server`)
  mkdirSync(SHOTS, { recursive: true })
  rmSync(join(tmpdir(), 'dotlink-mock-downloads'), { recursive: true, force: true })
  srv = spawn(BIN, ['--port', '0', '--memory', '--mock', '--no-discovery'], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((res, rej) => {
    let out = ''
    srv.stdout!.on('data', (d) => {
      out += d
      const m = out.match(/DOTLINK_READY port=(\d+) admin=(\S+)/)
      const u = out.match(/Телефон:\s+(\S+)/)
      if (m && u) { port = +m[1]; adminToken = m[2]; pairUrl = u[1]; res() }
    })
    srv.on('exit', (c) => rej(new Error('сервер завершился: ' + c)))
  })
  browser = await chromium.launch()
  phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'dark',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
  })
  phone = await phoneCtx.newPage()
  phone.on('pageerror', (e) => console.error('phone:', e.message))
}, 30_000)

afterAll(async () => {
  await browser?.close()
  srv?.kill()
})

describe('DotLink e2e', () => {
  it('телефон сопрягается по ссылке из QR', async () => {
    await phone.goto(pairUrl)
    await phone.getByText(/\d+ мс/).waitFor({ timeout: 8000 })
    expect(new URL(phone.url()).hash).toBe('') // секрет убран из адреса
    const saved = await phone.evaluate(() => JSON.parse(localStorage.getItem('dotlink.pcs') || '[]'))
    expect(saved).toHaveLength(1)
    expect(saved[0].key).toMatch(/^[A-Za-z0-9+/=]{44}$/)
    await shot(phone, 'phone-home')
  })

  it('тачпад: движение, тап, прокрутка двумя пальцами', async () => {
    await phone.getByRole('tab', { name: 'Тачпад' }).click()
    const pad = phone.getByRole('application', { name: 'Тачпад' })
    const box = (await pad.boundingBox())!
    const before = (await events()).length
    // палец: движение и тап (pointer-события с типом touch)
    await phone.evaluate(({ x, y }) => {
      const el = document.querySelector('.pad')!
      const ev = (type: string, id: number, cx: number, cy: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: cx, clientY: cy, bubbles: true, isPrimary: id === 1 }))
      ev('pointerdown', 1, x, y)
      for (let i = 1; i <= 12; i++) ev('pointermove', 1, x + i * 6, y + i * 3)
      ev('pointerup', 1, x + 72, y + 36)
    }, { x: box.x + 80, y: box.y + 120 })
    await phone.waitForTimeout(300)
    await phone.evaluate(({ x, y }) => {
      const el = document.querySelector('.pad')!
      const ev = (type: string, id: number, cx: number, cy: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: cx, clientY: cy, bubbles: true }))
      ev('pointerdown', 1, x, y); ev('pointerup', 1, x, y)
      return new Promise((r) => setTimeout(r, 400)).then(() => {
        ev('pointerdown', 1, x, y); ev('pointerdown', 2, x + 50, y)
        for (let i = 1; i <= 8; i++) { ev('pointermove', 1, x, y - i * 12); ev('pointermove', 2, x + 50, y - i * 12) }
        ev('pointerup', 1, x, y - 96); ev('pointerup', 2, x + 50, y - 96)
      })
    }, { x: box.x + 120, y: box.y + 300 })
    const ev = await waitFor(async () => { const e = (await events()).slice(before); return e.some((x) => x.scroll) && e })
    const moved = ev.filter((e: any) => e.move).reduce((a: number[], e: any) => [a[0] + e.move[0], a[1] + e.move[1]], [0, 0])
    expect(moved[0]).toBeGreaterThan(60)
    expect(moved[1]).toBeGreaterThan(30)
    expect(ev.some((e: any) => e.button === 'Left' && e.action === 'Click')).toBe(true)
    expect(ev.filter((e: any) => e.scroll).reduce((s: number, e: any) => s + e.scroll[0], 0)).toBeLessThan(0)
    await shot(phone, 'phone-pad')
  })

  it('клавиатура: русский текст, Backspace, сочетания', async () => {
    await phone.getByRole('button', { name: 'Клавиатура' }).click()
    const before = (await events()).length
    const input = phone.getByRole('textbox', { name: 'Ввод текста на ПК' })
    await input.pressSequentially('Привет, ПК')
    await input.press('Backspace')
    await phone.getByRole('button', { name: /^Win\+D/ }).click()
    const ev = await waitFor(async () => { const e = (await events()).slice(before); return e.some((x) => x.chord) && e })
    const typed = ev.filter((e: any) => e.text).map((e: any) => e.text).join('')
    expect(typed).toBe('Привет, ПК')
    expect(ev.some((e: any) => e.key === 8)).toBe(true)
    expect(ev.find((e: any) => e.chord).chord).toEqual([0x5b, 0x44])
    await shot(phone, 'phone-keyboard')
  })

  it('громкость и музыка синхронизируются с ПК', async () => {
    await phone.getByRole('tab', { name: 'Пульт' }).click()
    const slider = phone.getByRole('slider', { name: 'Громкость ПК' })
    const b = (await slider.boundingBox())!
    await slider.click({ position: { x: b.width * 0.8, y: b.height / 2 } })
    const v = await waitFor(async () => (await events()).reverse().find((e) => e.volume !== undefined))
    expect(v.volume).toBeGreaterThan(0.7)
    await phone.getByRole('button', { name: 'Следующий' }).click()
    await phone.getByText('Intro').waitFor({ timeout: 4000 })
  })

  it('задержка стека: пинг через шифрованный канал', async () => {
    const rtts: number[] = await phone.evaluate(() => (window as any).dotlink.link.measure(300))
    rtts.sort((a, b) => a - b)
    const med = rtts[rtts.length >> 1], p95 = rtts[Math.floor(rtts.length * 0.95)]
    console.log(`RTT туда-обратно (localhost, шифрование обеих сторон): медиана ${med.toFixed(2)} мс, p95 ${p95.toFixed(2)} мс`)
    expect(rtts.length).toBe(300)
    expect(med).toBeLessThan(10)
  })

  it('файл с телефона попадает в «Загрузки/DotLink»', async () => {
    await phone.getByRole('tab', { name: 'Файлы' }).click()
    const chooser = phone.waitForEvent('filechooser')
    await phone.getByRole('button', { name: 'Выбрать файлы' }).click()
    const body = Buffer.from('отчёт '.repeat(20000))
    await (await chooser).setFiles({ name: 'отчёт.txt', mimeType: 'text/plain', buffer: body })
    const path = join(tmpdir(), 'dotlink-mock-downloads', 'отчёт.txt')
    await waitFor(async () => existsSync(path), 8000)
    expect(readFileSync(path).equals(body)).toBe(true)
    await shot(phone, 'phone-files')
  })

  it('дашборд видит телефон и отправляет ему файл', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, colorScheme: 'dark' })
    dash = await ctx.newPage()
    dash.on('pageerror', (e) => console.error('dash:', e.message))
    await dash.goto(`http://127.0.0.1:${port}/dashboard/#admin=${adminToken}`)
    await dash.getByText('Pixel 8').waitFor()
    await dash.getByText(/в сети/).waitFor()
    await shot(dash, 'dashboard')
    await dash.getByRole('tab', { name: 'Файлы' }).click()
    const chooser = dash.waitForEvent('filechooser')
    await dash.getByRole('button', { name: 'Отправить файлы' }).click()
    await (await chooser).setFiles({ name: 'план.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') })
    await phone.getByText('план.pdf', { exact: true }).waitFor({ timeout: 6000 })
    const href = await phone.evaluate(() => new Promise<string>((res) => {
      const orig = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = orig; res(this.href) }
      ;(document.querySelector('.up-row button') as HTMLButtonElement).click()
    }))
    const got = await fetch(href)
    expect(await got.text()).toBe('%PDF-1.4 test')
    expect(got.headers.get('content-disposition')).toContain("filename*=UTF-8''%D0%BF%D0%BB%D0%B0%D0%BD")
  })

  it('QR-поток с экрана ПК собирается из снимков экрана', async () => {
    const bytes = Buffer.from(Array.from({ length: 24_000 }, (_, i) => (i * 2654435761) >>> 24))
    const chooser = dash.waitForEvent('filechooser')
    await dash.getByRole('button', { name: 'Показать файл QR-кодами' }).click()
    await (await chooser).setFiles({ name: 'снимок.jpg', mimeType: 'image/jpeg', buffer: bytes })
    const canvas = dash.locator('canvas.qr-canvas')
    await canvas.waitFor()
    await dash.waitForTimeout(500)
    prepareZXingModule({ overrides: { wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')).buffer as ArrayBuffer }, fireImmediately: true })
    const rx = await QrReceiver.create(readFileSync(join(__dirname, '../../src/lib/wasm/fountain.wasm')))
    let done: any = null
    rx.onDone = (p) => { done = p }
    let frames = 0, codes = 0
    const t0 = Date.now()
    while (!done && frames < 80) {
      const png = await canvas.screenshot()
      const res = await readBarcodes(new Blob([new Uint8Array(png)]), { formats: ['QRCode'], maxNumberOfSymbols: 30, tryHarder: true })
      codes += res.length
      res.forEach((r) => rx.accept(r.text))
      frames++
      if (frames === 1) await shot(dash, 'dashboard-qr-stream')
      await new Promise((r) => setTimeout(r, 30))
    }
    await waitFor(async () => done, 3000)
    console.log(`QR-поток: ${frames} снимков, ${codes} QR, K=${rx.k}, ${Math.round(Date.now() - t0)} мс`)
    expect(done.name).toBe('снимок.jpg')
    expect(Buffer.from(done.bytes).equals(bytes)).toBe(true)
    expect(codes / frames).toBeGreaterThanOrEqual(4) // в кадре сразу несколько QR
    await dash.getByRole('button', { name: 'Остановить' }).click()
  }, 60_000)

  it('отзыв устройства на ПК выкидывает телефон на экран подключения', async () => {
    await dash.getByRole('tab', { name: 'Устройства' }).click()
    await dash.locator('.dev-row').first().click()
    dash.once('dialog', (d) => d.accept())
    await dash.getByRole('button', { name: 'Отключить' }).click()
    await phone.getByText('ПК отключил этот телефон').waitFor({ timeout: 6000 })
    expect(await phone.evaluate(() => JSON.parse(localStorage.getItem('dotlink.pcs') || '[]'))).toHaveLength(0)
    await shot(phone, 'phone-revoked')
  })
})
