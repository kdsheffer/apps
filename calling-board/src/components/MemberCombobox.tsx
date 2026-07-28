import { useEffect, useMemo, useRef, useState } from 'react'
import { searchMembers } from '../lib/boardSelectors'
import type { Member } from '../types'

interface MemberComboboxProps {
  /** Everyone eligible — typing searches this whole list. */
  members: Member[]
  /** Shown before the user types anything. Usually the unassigned members. */
  suggested: Member[]
  /** Ids of members already serving somewhere, for the "serving elsewhere" hint. */
  servingElsewhere: Map<string, string[]>
  onSelect: (member: Member) => void
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
}

const MAX_RESULTS = 20

export function MemberCombobox({
  members,
  suggested,
  servingElsewhere,
  onSelect,
  placeholder = '+ Assign member',
  autoFocus = false,
  disabled = false,
}: MemberComboboxProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // With nothing typed the list is the unassigned members — the people you're
  // most likely reaching for. Typing widens the search to everyone.
  const results = useMemo(() => {
    if (!query.trim()) return suggested.slice(0, MAX_RESULTS)
    return searchMembers(members, query, MAX_RESULTS)
  }, [members, suggested, query])

  useEffect(() => setHighlight(0), [query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const choose = (member: Member) => {
    onSelect(member)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setHighlight((h) => Math.min(h + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const member = results[highlight]
      if (member) choose(member)
    } else if (event.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div ref={containerRef} className="relative print:hidden">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        disabled={disabled}
        autoFocus={autoFocus}
        value={query}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
      />

      {open && (
        <div className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {!query.trim() && (
            <p className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-400 border-b border-gray-100">
              Unassigned members
            </p>
          )}

          {results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-500">
              {query.trim() ? `No member matches "${query}"` : 'Everyone has a calling.'}
            </p>
          ) : (
            <ul role="listbox">
              {results.map((member, i) => {
                const elsewhere = servingElsewhere.get(member.id) || []
                return (
                  <li key={member.id}>
                    <button
                      role="option"
                      aria-selected={i === highlight}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => choose(member)}
                      className={`w-full px-3 py-2 text-left text-sm ${
                        i === highlight ? 'bg-blue-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {member.flagged && <span aria-label="Flagged">★</span>}
                        <span className="font-medium text-gray-900 truncate">
                          {member.full_name}
                        </span>
                        {!!member.archived_at && (
                          <span className="text-xs text-gray-400">inactive</span>
                        )}
                      </span>
                      {elsewhere.length > 0 && (
                        <span className="mt-0.5 block text-xs text-amber-700">
                          Serving as {elsewhere.join(', ')}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {!query.trim() && suggested.length > MAX_RESULTS && (
            <p className="px-3 py-2 text-xs text-gray-400 border-t border-gray-100">
              Showing {MAX_RESULTS} of {suggested.length} — type to search everyone.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
