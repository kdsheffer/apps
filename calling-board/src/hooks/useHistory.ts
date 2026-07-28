import { useCallback, useReducer, useRef, useState } from 'react'

/**
 * One reversible edit. `undo` and `redo` are closures created at the time of the
 * edit, so they already hold the ids the change actually landed on — including
 * when the edit was redirected into a working draft.
 *
 * Rows created by a restore get fresh ids, so an entry is allowed to mutate the
 * ids it captured; that's why these are closures rather than plain data.
 */
export interface HistoryEntry {
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

const LIMIT = 50

/**
 * A linear undo/redo stack. Kept in memory for the session — a reload starts
 * fresh, which is the usual bargain for undo and avoids replaying stale ids
 * against a board that may have moved on.
 */
export function useHistory() {
  // Refs rather than state for the stacks: undo and redo are async, and reading
  // the top of the stack from a stale closure would apply the wrong entry.
  const past = useRef<HistoryEntry[]>([])
  const future = useRef<HistoryEntry[]>([])
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const [busy, setBusy] = useState(false)

  const push = useCallback((entry: HistoryEntry) => {
    past.current = [...past.current, entry].slice(-LIMIT)
    // A fresh edit invalidates anything that was undone past this point.
    future.current = []
    refresh()
  }, [])

  const run = useCallback(
    async (direction: 'undo' | 'redo') => {
      const from = direction === 'undo' ? past : future
      const to = direction === 'undo' ? future : past
      const entry =
        direction === 'undo' ? from.current[from.current.length - 1] : from.current[0]
      if (!entry || busy) return

      setBusy(true)
      try {
        await entry[direction]()
        from.current =
          direction === 'undo' ? from.current.slice(0, -1) : from.current.slice(1)
        to.current = direction === 'undo' ? [entry, ...to.current] : [...to.current, entry]
        refresh()
      } finally {
        setBusy(false)
      }
    },
    [busy]
  )

  const clear = useCallback(() => {
    past.current = []
    future.current = []
    refresh()
  }, [])

  return {
    push,
    clear,
    busy,
    undo: () => run('undo'),
    redo: () => run('redo'),
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    undoLabel: past.current[past.current.length - 1]?.label ?? null,
    redoLabel: future.current[0]?.label ?? null,
  }
}
