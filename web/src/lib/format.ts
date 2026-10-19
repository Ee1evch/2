export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} КБ`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`
}

export function formatDuration(sec: number): string {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'только что'
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`
  return new Date(ms).toLocaleDateString('ru-RU')
}

/** Файл → Uint8Array + метаданные для QR-потока. */
export async function fileToPayload(f: File) {
  return { name: f.name, type: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) }
}

/** Выбор файлов без видимого input. */
export function pickFiles(multiple = true): Promise<File[]> {
  return new Promise((res) => {
    const i = document.createElement('input')
    i.type = 'file'
    i.multiple = multiple
    i.onchange = () => res([...(i.files || [])])
    i.click()
  })
}
