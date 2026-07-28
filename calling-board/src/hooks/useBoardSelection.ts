import { useCallback, useEffect, useState } from 'react'
import type { Board } from '../types'

const keyFor = (wardId: string) => `calling-board:selectedBoard:${wardId}`

function read(wardId: string): string | null {
  try {
    return window.localStorage.getItem(keyFor(wardId))
  } catch {
    return null
  }
}

/**
 * Remembers which board version is loaded, per ward, so a refresh or a fresh
 * visit lands back where you were rather than snapping to the live board.
 *
 * The stored id is only a preference — if that board has since been promoted
 * away or deleted, it's dropped and the caller's default takes over.
 */
export function useBoardSelection(wardId: string, boards: Board[] | undefined) {
  // Read during initialisation so the first render already has the right board
  // and the page doesn't flash the live one.
  const [selected, setSelected] = useState<string | null>(() => read(wardId))

  useEffect(() => {
    setSelected(read(wardId))
  }, [wardId])

  const select = useCallback(
    (boardId: string) => {
      setSelected(boardId)
      try {
        window.localStorage.setItem(keyFor(wardId), boardId)
      } catch {
        // A full or blocked localStorage shouldn't break loading a board.
      }
    },
    [wardId]
  )

  useEffect(() => {
    if (!boards || !selected) return
    if (boards.some((b) => b.id === selected)) return

    setSelected(null)
    try {
      window.localStorage.removeItem(keyFor(wardId))
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }, [boards, selected, wardId])

  return { selected, select }
}
