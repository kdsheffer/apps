import {
  describeWindow,
  newWindow,
  overlapping,
  windowError,
  type TimeWindow,
} from '../lib/timeWindows'
import { inputClass } from './Field'

/**
 * A repeatable list of time blocks.
 *
 * A ward taking declarations before church and again after needs two blocks on
 * one date, and doing that as two trips through the form works but makes the
 * secretary hold the state in her head. This edits the whole day at once.
 *
 * Each row validates on its own so a mistake in the second block doesn't hide
 * the first, and rows carry a stable `id` rather than being keyed by index —
 * without it, removing a row makes React reuse the wrong DOM node and the
 * values appear to jump between rows as you delete.
 */
export function TimeWindows({
  windows,
  onChange,
  idPrefix,
  disabled = false,
}: {
  windows: TimeWindow[]
  onChange: (windows: TimeWindow[]) => void
  idPrefix: string
  disabled?: boolean
}) {
  const update = (id: string, patch: Partial<TimeWindow>) =>
    onChange(windows.map((w) => (w.id === id ? { ...w, ...patch } : w)))

  const remove = (id: string) => onChange(windows.filter((w) => w.id !== id))

  const add = () => {
    // Start the new block after the last one ends, which is nearly always what
    // a second block is — an afternoon sitting, not a repeat of the morning.
    const last = windows[windows.length - 1]
    const start = last?.end && last.end < '22:00' ? last.end : '13:00'
    onChange([...windows, newWindow(start, addHours(start, 2))])
  }

  return (
    <fieldset disabled={disabled}>
      <legend className="mb-2 text-sm font-medium text-gray-700">
        Blocks of times
        <span className="ml-2 text-xs font-normal text-gray-500">
          add more than one for a morning and an afternoon sitting
        </span>
      </legend>

      <ul className="space-y-3">
        {windows.map((window, index) => {
          const error = windowError(window)
          return (
            <li key={window.id} className="rounded border border-gray-200 bg-gray-50 p-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label
                    htmlFor={`${idPrefix}-start-${window.id}`}
                    className="mb-1 block text-xs font-medium text-gray-600"
                  >
                    From
                  </label>
                  <input
                    id={`${idPrefix}-start-${window.id}`}
                    type="time"
                    step={900}
                    required
                    value={window.start}
                    onChange={(e) => update(window.id, { start: e.target.value })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label
                    htmlFor={`${idPrefix}-end-${window.id}`}
                    className="mb-1 block text-xs font-medium text-gray-600"
                  >
                    Until
                  </label>
                  <input
                    id={`${idPrefix}-end-${window.id}`}
                    type="time"
                    step={900}
                    required
                    value={window.end}
                    onChange={(e) => update(window.id, { end: e.target.value })}
                    className={inputClass}
                  />
                </div>

                <div className="flex-1 pb-2 text-sm text-gray-600">
                  {error ? (
                    <span className="text-red-700">{error}</span>
                  ) : (
                    describeWindow(window)
                  )}
                </div>

                {/* The last remaining block can't be removed — a day with no
                    blocks is a form that can't be submitted, and an empty list
                    gives the secretary nothing to type into. */}
                {windows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => remove(window.id)}
                    aria-label={`Remove block ${index + 1}`}
                    className="mb-1 rounded px-2 py-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                  >
                    ✕
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {overlapping(windows) && (
        <p className="mt-2 text-sm text-amber-800">
          Two of these blocks cover the same time. Nothing will break — times
          that already exist are left alone — but you'll get fewer new times
          than the blocks suggest.
        </p>
      )}

      <button
        type="button"
        onClick={add}
        className="mt-3 rounded bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300"
      >
        + Add another block
      </button>
    </fieldset>
  )
}

/** "13:00" + 2h = "15:00", clamped so a late block can't roll past midnight. */
function addHours(clock: string, hours: number): string {
  const [h, m] = clock.split(':').map(Number)
  const end = Math.min(h * 60 + m + hours * 60, 23 * 60 + 45)
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
}
