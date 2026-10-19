// Сканер камеры: кадры видео → тексты всех QR в кадре.
// Если есть нативный BarcodeDetector (Chrome на Android) — он; иначе zxing в 1–2 воркерах.

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }

export function cameraAvailable(): boolean {
  return !!navigator.mediaDevices?.getUserMedia && (window.isSecureContext || location.hostname === 'localhost')
}

async function nativeDetector(): Promise<Detector | null> {
  const BD = (globalThis as any).BarcodeDetector
  if (!BD) return null
  try {
    const formats: string[] = await BD.getSupportedFormats()
    return formats.includes('qr_code') ? new BD({ formats: ['qr_code'] }) : null
  } catch { return null }
}

export interface ScanStats { fps: number; codes: number; engine: 'native' | 'zxing' }

export class QrScanner {
  private stream: MediaStream | null = null
  private running = false
  private workers: Worker[] = []
  private idle: boolean[] = []
  private canvas = document.createElement('canvas')
  private seq = 0
  private frames = 0
  private codes = 0
  private t0 = performance.now()
  stats: ScanStats = { fps: 0, codes: 0, engine: 'zxing' }

  constructor(private readonly video: HTMLVideoElement, private readonly onTexts: (texts: string[]) => void, private readonly maxWidth = 1920) {}

  async start(facing: 'environment' | 'user' = 'environment') {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    })
    this.video.srcObject = this.stream
    this.video.muted = true
    this.video.playsInline = true
    await this.video.play()
    this.running = true
    const det = await nativeDetector()
    if (det) {
      this.stats.engine = 'native'
      void this.loopNative(det)
    } else {
      const n = Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./qrworker.ts', import.meta.url), { type: 'module' })
        w.onmessage = (e) => { this.idle[i] = true; this.got(e.data.texts) ; this.pump() }
        this.workers.push(w)
        this.idle.push(true)
      }
      this.pump()
    }
  }

  private got(texts: string[]) {
    this.frames++
    this.codes += texts.length
    const dt = performance.now() - this.t0
    if (dt > 1000) {
      this.stats = { ...this.stats, fps: Math.round((this.frames * 1000) / dt), codes: Math.round((this.codes * 1000) / dt) }
      this.frames = 0; this.codes = 0; this.t0 = performance.now()
    }
    if (texts.length) this.onTexts(texts)
  }

  private async loopNative(det: Detector) {
    while (this.running) {
      try {
        if (this.video.readyState >= 2) this.got((await det.detect(this.video)).map((r) => r.rawValue))
        else await new Promise((r) => setTimeout(r, 30))
      } catch { await new Promise((r) => setTimeout(r, 50)) }
    }
  }

  private pump() {
    if (!this.running) return
    const i = this.idle.indexOf(true)
    if (i < 0) return
    const v = this.video
    if (v.readyState < 2 || !v.videoWidth) { setTimeout(() => this.pump(), 40); return }
    const scale = Math.min(1, this.maxWidth / v.videoWidth)
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale)
    if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h }
    const g = this.canvas.getContext('2d', { willReadFrequently: true })!
    g.drawImage(v, 0, 0, w, h)
    const img = g.getImageData(0, 0, w, h)
    this.idle[i] = false
    this.workers[i].postMessage({ id: ++this.seq, img }, [img.data.buffer])
    // второй воркер берёт следующий кадр, не дожидаясь первого
    if (this.idle.includes(true)) setTimeout(() => this.pump(), 16)
  }

  stop() {
    this.running = false
    this.workers.forEach((w) => w.terminate())
    this.workers = []
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
  }
}
