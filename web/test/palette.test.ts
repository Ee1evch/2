import { describe, expect, it } from 'vitest'
import { fuzzy } from '../src/lib/fuzzy'

describe('поиск палитры', () => {
  it('подстрока выше совпадения по буквам, начало слова — выше середины', () => {
    expect(fuzzy('code', 'Visual Studio Code')).toBeGreaterThan(fuzzy('code', 'Barcode Scanner'))
    expect(fuzzy('chr', 'Google Chrome')).toBeGreaterThan(fuzzy('chr', 'Archive Manager'))
    expect(fuzzy('vsc', 'Visual Studio Code')).toBeGreaterThan(0)
    expect(fuzzy('xyz', 'Telegram')).toBe(0)
    expect(fuzzy('', 'что угодно')).toBe(1)
  })
  it('регистр и кириллица не важны', () => {
    expect(fuzzy('ПРОВ', 'Проводник')).toBeGreaterThan(0)
    expect(fuzzy('тлг', 'Telegram')).toBe(0)
  })
})
