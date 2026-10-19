// Тактильный отклик: в APK — нативные Haptics Capacitor, в браузере — navigator.vibrate (Android).

type Kind = 'tick' | 'tap' | 'heavy'
interface CapHaptics { impact(o: { style: string }): Promise<void>; selectionChanged?(): Promise<void> }
let enabled = true

export function setHaptics(on: boolean) { enabled = on }

export function haptic(kind: Kind = 'tap') {
  if (!enabled) return
  const cap = (globalThis as { Capacitor?: { Plugins?: { Haptics?: CapHaptics } } }).Capacitor?.Plugins?.Haptics
  try {
    if (cap) { void cap.impact({ style: kind === 'heavy' ? 'HEAVY' : kind === 'tap' ? 'MEDIUM' : 'LIGHT' }); return }
    navigator.vibrate?.(kind === 'heavy' ? 18 : kind === 'tap' ? 7 : 4)
  } catch { /* вибрация недоступна — ничего страшного */ }
}
