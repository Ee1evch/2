// Нечёткий поиск для командной палитры.

/** Совпадение «по буквам по порядку» — как в палитрах редакторов; чем плотнее, тем выше. */
export function fuzzy(q: string, text: string): number {
  const t = text.toLowerCase(), s = q.toLowerCase().trim()
  if (!s) return 1
  const at = t.indexOf(s)
  if (at >= 0) return 1000 - at * 2 - t.length * 0.01 + (at === 0 || /[\s\-—._]/.test(t[at - 1]) ? 200 : 0)
  let gaps = 0, last = -1
  for (const ch of s) {
    const j = t.indexOf(ch, last + 1)
    if (j < 0) return 0
    if (last >= 0) gaps += j - last - 1
    last = j
  }
  return Math.max(1, 500 - gaps * 8 - t.length * 0.01)
}
