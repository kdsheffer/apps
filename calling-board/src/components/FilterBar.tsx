import { MultiSelect } from './MultiSelect'
import type { BoardFilters, Group } from '../types'
import { emptyFilters } from '../types'

interface FilterBarProps {
  filters: BoardFilters
  onChange: (filters: BoardFilters) => void
  groups: Group[]
  /** Only the subgroups of the currently selected groups, when any are selected. */
  subgroups: Group[]
  /**
   * The "show only what's unfilled" toggle. It means open callings on the board
   * and members without a calling on the roster, so the wording comes from the
   * tab; omit to hide it.
   */
  openToggle?: { label: string; title: string }
  /**
   * The Assign tab shows callings and members side by side and carries its own
   * flag filter over each, so the single shared one is hidden there.
   */
  showFlaggedToggle?: boolean
  right?: React.ReactNode
}

function Toggle({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`whitespace-nowrap rounded border px-3 py-2 text-sm font-medium ${
        active
          ? 'border-blue-300 bg-blue-50 text-blue-800'
          : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  )
}

export function FilterBar({
  filters,
  onChange,
  groups,
  subgroups,
  openToggle,
  showFlaggedToggle = true,
  right,
}: FilterBarProps) {
  const set = (patch: Partial<BoardFilters>) => onChange({ ...filters, ...patch })

  const isFiltered =
    filters.search !== '' ||
    filters.groupIds.length > 0 ||
    filters.subgroupIds.length > 0 ||
    filters.flaggedOnly ||
    filters.openOnly ||
    filters.showInactive

  return (
    <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-gray-200 bg-gray-50/95 px-4 py-3 backdrop-blur print:hidden sm:mx-0 sm:rounded-lg sm:border sm:bg-white sm:shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Search callings, people, notes…"
          className="min-w-[12rem] flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <div className="w-44">
          <MultiSelect
            label="Group"
            options={groups.map((g) => ({ id: g.id, label: g.name }))}
            selected={filters.groupIds}
            onChange={(groupIds) => {
              // Subgroup choices that no longer belong to a selected group would
              // filter everything away, so drop them.
              const stillValid = filters.subgroupIds.filter((id) =>
                groupIds.length === 0
                  ? true
                  : subgroups.some((s) => s.id === id && groupIds.includes(s.parent_id || ''))
              )
              set({ groupIds, subgroupIds: stillValid })
            }}
          />
        </div>

        <div className="w-44">
          <MultiSelect
            label="Subgroup"
            options={subgroups.map((g) => ({ id: g.id, label: g.name }))}
            selected={filters.subgroupIds}
            onChange={(subgroupIds) => set({ subgroupIds })}
          />
        </div>

        {showFlaggedToggle && (
          <Toggle
            active={filters.flaggedOnly}
            onClick={() => set({ flaggedOnly: !filters.flaggedOnly })}
            title="Show only flagged callings and people"
          >
            ★ Flagged
          </Toggle>
        )}

        {openToggle && (
          <Toggle
            active={filters.openOnly}
            onClick={() => set({ openOnly: !filters.openOnly })}
            title={openToggle.title}
          >
            {openToggle.label}
          </Toggle>
        )}

        <Toggle
          active={filters.showInactive}
          onClick={() => set({ showInactive: !filters.showInactive })}
          title="Inactive callings and members are hidden by default"
        >
          Show inactive
        </Toggle>

        {isFiltered && (
          <button
            onClick={() => onChange(emptyFilters)}
            className="whitespace-nowrap px-2 py-2 text-sm text-blue-600 hover:underline"
          >
            Clear filters
          </button>
        )}

        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
    </div>
  )
}
