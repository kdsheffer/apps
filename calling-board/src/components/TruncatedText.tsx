import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const GAP = 6

/** Where the text sits in the viewport, captured when the pointer arrives. */
interface Anchor {
  left: number
  top: number
  bottom: number
}

/**
 * A single line that clips when it doesn't fit, with the full text on hover.
 *
 * Long calling names are why this exists: several differ only in their tail
 * ("… Assistant Activity Coordinator"), so the part that gets cut is the part
 * you need. A native `title` isn't enough — it waits a second or two and won't
 * show at all on touch.
 *
 * The bubble renders in a portal because both Assign panes scroll: in place it
 * would be clipped at the pane's edge. It only appears once the text has
 * actually been cut off, since repeating a line you can already read is noise.
 */
export function TruncatedText({ text, className = '' }: { text: string; className?: string }) {
  const textRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })

  // Runs before paint, so the bubble is never seen at its unplaced position.
  useLayoutEffect(() => {
    if (!anchor) return

    const bubble = bubbleRef.current
    if (bubble) {
      const { width, height } = bubble.getBoundingClientRect()
      // Below the line by default, above when there's no room down there —
      // which is where the last rows of a tall pane end up.
      const below = anchor.bottom + GAP
      const top = below + height + GAP < window.innerHeight ? below : anchor.top - height - GAP

      setPos({
        left: Math.max(GAP, Math.min(anchor.left, window.innerWidth - width - GAP)),
        top: Math.max(GAP, top),
      })
    }

    // Any scroll slides the text out from under its bubble, and a pane
    // scrolling doesn't reach the window — hence the capturing listener.
    const close = () => setAnchor(null)
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [anchor])

  const show = () => {
    const el = textRef.current
    if (!el || el.scrollWidth <= el.clientWidth + 1) return

    const rect = el.getBoundingClientRect()
    setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom })
  }

  return (
    <>
      <span
        ref={textRef}
        onMouseEnter={show}
        onMouseLeave={() => setAnchor(null)}
        // Starting a drag shouldn't leave a bubble parked over the board.
        onPointerDown={() => setAnchor(null)}
        className={`block truncate ${className}`}
      >
        {text}
      </span>

      {anchor &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            style={{ left: pos.left, top: pos.top }}
            className="pointer-events-none fixed z-[70] max-w-xs rounded bg-gray-900 px-2 py-1 text-xs text-white shadow-lg print:hidden"
          >
            {text}
          </div>,
          document.body
        )}
    </>
  )
}
