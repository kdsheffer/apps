import { useCallback, useEffect, useState, type ReactNode } from 'react'

/**
 * Remembers which sections are open, per board, so filtering or reloading
 * doesn't collapse everything you'd just expanded.
 */
export function useExpandedSections(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      setCollapsed(new Set(raw ? (JSON.parse(raw) as string[]) : []))
    } catch {
      setCollapsed(new Set())
    }
  }, [storageKey])

  const persist = useCallback(
    (next: Set<string>) => {
      setCollapsed(next)
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]))
      } catch {
        // A full or blocked localStorage shouldn't break the board.
      }
    },
    [storageKey]
  )

  return {
    isOpen: (id: string) => !collapsed.has(id),
    toggle: (id: string) => {
      const next = new Set(collapsed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      persist(next)
    },
    expandAll: () => persist(new Set()),
    collapseAll: (ids: string[]) => persist(new Set(ids)),
    allCollapsed: collapsed.size > 0,
  }
}

interface AccordionProps {
  isOpen: boolean
  onToggle: () => void
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  level?: 'group' | 'subgroup'
  onContextMenu?: (event: React.MouseEvent) => void
  children: ReactNode
}

export function Accordion({
  isOpen,
  onToggle,
  title,
  meta,
  actions,
  level = 'group',
  onContextMenu,
  children,
}: AccordionProps) {
  const isGroup = level === 'group'

  return (
    <section
      className={
        isGroup
          ? 'bg-white rounded-lg shadow overflow-hidden print:shadow-none print:border print:border-gray-300'
          : 'border-l-4 border-blue-100 bg-gray-50/60 rounded-r print:border-l-2'
      }
    >
      <div
        className={`flex items-center gap-2 ${isGroup ? 'px-4 sm:px-6 py-4' : 'px-3 py-2.5'}`}
        onContextMenu={onContextMenu}
      >
        <button
          onClick={onToggle}
          aria-expanded={isOpen}
          className="flex flex-1 items-center gap-2 min-w-0 text-left group"
        >
          <span
            className={`shrink-0 text-gray-400 transition-transform group-hover:text-gray-600 ${
              isOpen ? 'rotate-90' : ''
            }`}
            aria-hidden
          >
            ▶
          </span>
          <span
            className={`truncate ${
              isGroup
                ? 'text-lg font-semibold text-gray-900'
                : 'text-sm font-semibold text-gray-700'
            }`}
          >
            {title}
          </span>
          {meta}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1 print:hidden">{actions}</div>}
      </div>

      {isOpen && (
        <div className={isGroup ? 'px-4 sm:px-6 pb-5 space-y-4' : 'px-3 pb-3 space-y-3'}>
          {children}
        </div>
      )}
    </section>
  )
}
