import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { Link } from './link'

/** Соединение с ПК для виджетов: у пульта — шифрованное, у дашборда — служебное на 127.0.0.1. */
export const LinkCtx = createContext<Link | null>(null)
export function useLink(): Link {
  const l = useContext(LinkCtx)
  if (!l) throw new Error('LinkCtx не задан')
  return l
}
