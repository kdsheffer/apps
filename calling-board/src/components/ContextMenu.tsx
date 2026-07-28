import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem =
  | {
      kind: 'action'
      label: string
      detail?: string
      icon?: string
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | { kind: 'separator' }
  | { kind: 'header'; label: string }
  | {
      kind: 'submenu'
      label: string
      icon?: string
      detail?: string
      items: MenuItem[]
      /**
       * Turns the submenu into a searchable list. `flat` is the fully-qualified
       * version of every leaf below it — a deep calling tree is faster to type
       * through than to click through.
       */
      search?: { placeholder: string; flat: MenuItem[] }
    }

export interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[]
  title?: string
}

const MENU_WIDTH = 272
const GAP = 4

/** Keeps a menu panel on screen, flipping it left/up when it would overflow. */
function clamp(x: number, y: number, width: number, height: number) {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  }
}

function Panel({
  items,
  title,
  search,
  x,
  y,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  items: MenuItem[]
  title?: string
  search?: { placeholder: string; flat: MenuItem[] }
  x: number
  y: number
  onClose: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(() => ({ left: x, top: y }))
  const [query, setQuery] = useState('')

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    setPos(clamp(x, y, rect?.width || MENU_WIDTH, rect?.height || 240))
  }, [x, y, items, query])

  const needle = query.trim().toLowerCase()
  const shown =
    search && needle
      ? search.flat.filter((child) => {
          if (child.kind === 'separator' || child.kind === 'header') return false
          return `${child.label} ${('detail' in child && child.detail) || ''}`
            .toLowerCase()
            .includes(needle)
        })
      : items

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[60] rounded-lg border border-gray-200 bg-white py-1 shadow-xl"
    >
      {title && (
        <p className="truncate border-b border-gray-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
          {title}
        </p>
      )}

      {search && (
        <div className="px-2 py-1">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={search.placeholder}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      <div className="max-h-[60vh] overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-3 py-2 text-sm text-gray-500">No matches</p>
        ) : (
          shown.map((item, i) => <Row key={i} item={item} onClose={onClose} />)
        )}
      </div>
    </div>,
    document.body
  )
}

function Row({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [submenu, setSubmenu] = useState<{ x: number; y: number } | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  if (item.kind === 'separator') return <div className="my-1 border-t border-gray-100" />

  if (item.kind === 'header') {
    return (
      <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
        {item.label}
      </p>
    )
  }

  if (item.kind === 'action') {
    return (
      <button
        disabled={item.disabled}
        onClick={() => {
          item.onSelect()
          onClose()
        }}
        className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm disabled:opacity-40 ${
          item.danger ? 'text-red-700 hover:bg-red-50' : 'text-gray-800 hover:bg-blue-50'
        }`}
      >
        {item.icon && <span className="w-4 shrink-0 text-center">{item.icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.label}</span>
          {item.detail && (
            <span className="block truncate text-xs text-gray-500">{item.detail}</span>
          )}
        </span>
      </button>
    )
  }

  // Submenus are portaled at fixed coordinates rather than nested, so the
  // parent's scroll container can't clip them.
  const open = () => {
    window.clearTimeout(closeTimer.current)
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const toRight = rect.right + GAP
    const fitsRight = toRight + MENU_WIDTH + 8 <= window.innerWidth
    setSubmenu({
      x: fitsRight ? toRight : rect.left - MENU_WIDTH - GAP,
      y: rect.top - 4,
    })
  }

  const scheduleClose = () => {
    closeTimer.current = window.setTimeout(() => setSubmenu(null), 250)
  }

  return (
    <div onMouseEnter={open} onMouseLeave={scheduleClose}>
      <button
        ref={triggerRef}
        onClick={() => (submenu ? setSubmenu(null) : open())}
        className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-gray-800 hover:bg-blue-50"
      >
        {item.icon && <span className="w-4 shrink-0 text-center">{item.icon}</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.label}</span>
          {item.detail && (
            <span className="block truncate text-xs text-gray-500">{item.detail}</span>
          )}
        </span>
        <span className="shrink-0 text-gray-400" aria-hidden>
          ›
        </span>
      </button>

      {submenu && (
        <Panel
          items={item.items}
          search={item.search}
          x={submenu.x}
          y={submenu.y}
          onClose={onClose}
          onMouseEnter={() => window.clearTimeout(closeTimer.current)}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  )
}

export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state, onClose])

  if (!state) return null

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-50"
          onMouseDown={onClose}
          onContextMenu={(e) => {
            e.preventDefault()
            onClose()
          }}
        />,
        document.body
      )}
      <Panel
        items={state.items}
        title={state.title}
        x={state.x}
        y={state.y}
        onClose={onClose}
      />
    </>
  )
}
