import qrcode from 'qrcode-generator'
import { useMemo } from 'preact/hooks'

/**
 * QR для сопряжения в точечном стиле: модули — круглые точки, поисковые узоры — скруглённые квадраты.
 * Тёмные точки на светлой подложке: так его надёжно читает любая камера, в том числе системная.
 */
export function QrDots({ text, size = 220, ecc = 'M' }: { text: string; size?: number; ecc?: 'L' | 'M' | 'Q' | 'H' }) {
  const { n, dots } = useMemo(() => {
    const qr = qrcode(0, ecc)
    qr.addData(text, 'Byte')
    qr.make()
    const n = qr.getModuleCount()
    const inFinder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7)
    const dots: [number, number][] = []
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!inFinder(r, c) && qr.isDark(r, c)) dots.push([c, r])
    return { n, dots }
  }, [text, ecc])
  const q = 2 // тихая зона
  const box = n + q * 2
  const finder = (x: number, y: number) => (
    <g key={x + ':' + y} transform={`translate(${x + q} ${y + q})`}>
      <rect x="0.5" y="0.5" width="6" height="6" rx="1.9" fill="none" stroke="currentColor" stroke-width="1" />
      <rect x="2" y="2" width="3" height="3" rx="0.9" fill="currentColor" />
    </g>
  )
  return (
    <svg class="qr-dots" width={size} height={size} viewBox={`0 0 ${box} ${box}`} role="img" aria-label="QR-код для подключения" style={{ color: '#0b0b0c', background: '#f4f4f6', borderRadius: size * 0.07 + 'px' }}>
      {dots.map(([x, y]) => <circle key={x * 1000 + y} cx={x + q + 0.5} cy={y + q + 0.5} r={0.43} fill="currentColor" />)}
      {finder(0, 0)}{finder(n - 7, 0)}{finder(0, n - 7)}
    </svg>
  )
}
