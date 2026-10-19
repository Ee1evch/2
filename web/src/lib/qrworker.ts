/// <reference lib="webworker" />
// Распознавание многих QR в одном кадре (zxing-cpp в WebAssembly) — вне основного потока.
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } })

self.onmessage = async (e: MessageEvent<{ id: number; img: ImageData }>) => {
  const { id, img } = e.data
  try {
    const res = await readBarcodes(img, { formats: ['QRCode'], maxNumberOfSymbols: 24, tryHarder: true, tryRotate: false, tryInvert: false, tryDownscale: true })
    self.postMessage({ id, texts: res.filter((r) => r.isValid).map((r) => r.text) })
  } catch (err) {
    self.postMessage({ id, texts: [], error: String(err) })
  }
}
