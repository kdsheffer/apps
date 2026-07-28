import { useEffect, useRef, useState } from 'react'

export interface MultiSelectOption {
  id: string
  label: string
  hint?: string
}

interface MultiSelectProps {
  label: string
  options: MultiSelectOption[]
  selected: string[]
  onChange: (selected: string[]) => void
  emptyLabel?: string
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  emptyLabel = 'All',
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id])
  }

  const summary =
    selected.length === 0
      ? emptyLabel
      : selected.length === 1
        ? options.find((o) => o.id === selected[0])?.label ?? '1 selected'
        : `${selected.length} selected`

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={options.length === 0}
        className={`flex w-full items-center justify-between gap-2 rounded border px-3 py-2 text-sm disabled:opacity-50 ${
          selected.length > 0
            ? 'border-blue-300 bg-blue-50 text-blue-800'
            : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
        }`}
      >
        <span className="truncate">
          <span className="text-gray-500">{label}:</span> {summary}
        </span>
        <span className="shrink-0 text-gray-400" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
              {label}
            </span>
            {selected.length > 0 && (
              <button
                onClick={() => onChange([])}
                className="text-xs text-blue-600 hover:underline"
              >
                Clear
              </button>
            )}
          </div>
          {options.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-500">Nothing to filter by yet.</p>
          ) : (
            <ul>
              {options.map((option) => (
                <li key={option.id}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={selected.includes(option.id)}
                      onChange={() => toggle(option.id)}
                      className="rounded border-gray-300"
                    />
                    <span className="flex-1 truncate text-gray-800">{option.label}</span>
                    {option.hint && (
                      <span className="text-xs text-gray-400">{option.hint}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
