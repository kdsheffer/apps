import { useLayoutEffect, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { MemberChip } from '../MemberChip'
import { MemberCombobox } from '../MemberCombobox'
import { dropId } from '../../lib/dnd'
import { makePositionView, positionPassesFilters } from '../../lib/boardSelectors'
import type { BoardViewContext } from './shared'
import type { Position } from '../../types'

/**
 * Caps the two panes at whatever height is left below them in the viewport, so
 * each scrolls on its own and the member list stays put while you work down the
 * callings. Measured rather than hardcoded because the filter bar above wraps at
 * some widths, which moves where the panes start.
 *
 * Only applies once the panes sit side by side — stacked on a narrow screen they
 * need the page to scroll normally.
 */
function usePaneHeight() {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    // The breakpoint is re-read inside the measurement rather than tracked as
    // its own state: a separate matchMedia listener races the resize listener,
    // and whichever lost would leave the panes capped while stacked.
    const measure = () => {
      const el = ref.current
      if (!el) return

      if (!window.matchMedia('(min-width: 1024px)').matches) {
        setHeight(null)
        return
      }

      const rect = el.getBoundingClientRect()
      // Document-relative, so measuring while the page happens to be scrolled
      // still gives the right answer.
      const top = rect.top + window.scrollY

      // The container's bottom padding sits below the panes and still needs
      // room, or the page keeps a sliver of scroll. It's independent of the
      // height we're about to set, so measuring it here is stable.
      const container = el.closest('main')
      const below = container
        ? Math.max(0, container.getBoundingClientRect().bottom - rect.bottom)
        : 0

      // A floor keeps the panes usable if the chrome above ever grows tall.
      setHeight(Math.max(360, window.innerHeight - top - below))
    }

    measure()
    window.addEventListener('resize', measure)

    // A window resize isn't the only thing that moves the panes: the filter bar
    // wraps at some widths and the stats line reflows, both of which change
    // where the panes start without any resize event. Observing the layout
    // catches those. It can't loop — the measurement reads only what's above
    // the panes, so re-measuring after setting the height yields the same value
    // and React drops the no-op update.
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)

    return () => {
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [])

  return { ref, height }
}

/** A star that filters one panel down to its flagged rows. */
function FlagFilter({
  active,
  onClick,
  title,
}: {
  active: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded border px-2 py-1 text-sm ${
        active
          ? 'border-amber-300 bg-amber-50 text-amber-700'
          : 'border-gray-300 bg-white text-gray-400 hover:text-amber-500'
      }`}
    >
      ★
    </button>
  )
}

function OpenPositionRow({
  position,
  path,
  ctx,
}: {
  position: Position
  path: string
  ctx: BoardViewContext
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: dropId({ type: 'position', positionId: position.id }),
    data: { type: 'position', positionId: position.id },
    disabled: ctx.readOnly,
  })

  const occupants = ctx.index.byPosition.get(position.id) || []
  const heldBy = occupants
    .map((o) => o.member?.full_name)
    .filter(Boolean)
    .join(', ')

  return (
    <li
      ref={setNodeRef}
      onContextMenu={(e) => ctx.openPositionMenu(e, position)}
      className={`rounded border px-3 py-2 transition-colors ${
        isOver
          ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-300'
          : position.flagged
            ? 'border-amber-300 bg-amber-50/60'
            : heldBy
              ? 'border-gray-200 bg-gray-50'
              : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => ctx.actions.togglePositionFlag(position)}
          disabled={ctx.readOnly}
          title={position.flagged ? 'Remove flag' : 'Flag this calling'}
          className={`shrink-0 disabled:opacity-40 ${
            position.flagged ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'
          }`}
        >
          ★
        </button>
        {/* Long calling names get cut off next to the assign box, and several
            differ only in their tail ("… Assistant Activity Coordinator"), so
            the full text has to be reachable on hover. */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900" title={position.title}>
            {position.title}
          </p>
          <p className="truncate text-xs text-gray-500" title={path}>
            {path}
          </p>
          {heldBy ? (
            <p className="truncate text-xs text-gray-700" title={heldBy}>
              {heldBy}
            </p>
          ) : (
            <p className="text-xs font-medium text-blue-700">Open</p>
          )}
        </div>
        {!ctx.readOnly && (
          <div className="w-44 shrink-0 print:hidden">
            <MemberCombobox
              members={ctx.visibleMembers}
              suggested={ctx.unassigned}
              servingElsewhere={ctx.servingElsewhere}
              placeholder={heldBy ? 'Add…' : 'Assign…'}
              onSelect={(member) => ctx.actions.assign(position.id, member.id, 'add')}
            />
          </div>
        )}
      </div>
      {position.notes && (
        <p className="mt-1 truncate text-xs italic text-amber-800" title={position.notes}>
          {position.notes}
        </p>
      )}
    </li>
  )
}

export function AssignTab({ ctx }: { ctx: BoardViewContext }) {
  const { data, index, filters } = ctx

  // This tab shows two independent lists, so the shared "Flagged" filter in the
  // bar can't serve both — each panel gets its own. Vacancies are the usual
  // reason to be here, so the calling list starts narrowed to open ones.
  const [showAll, setShowAll] = useState(false)
  const [flaggedCallings, setFlaggedCallings] = useState(false)
  const [flaggedMembers, setFlaggedMembers] = useState(false)
  const panes = usePaneHeight()

  const callingFilters = {
    ...filters,
    openOnly: !showAll,
    // Handled per panel below, so the position's own flag is what counts here
    // rather than the shared rule that also matches a flagged occupant.
    flaggedOnly: false,
  }

  const sections = (data?.groups || [])
    .filter((g) => !g.parent_id)
    .filter((g) => filters.groupIds.length === 0 || filters.groupIds.includes(g.id))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((group) => {
      const subgroups = (data?.groups || [])
        .filter((c) => c.parent_id === group.id)
        .filter((c) => filters.subgroupIds.length === 0 || filters.subgroupIds.includes(c.id))
        .sort((a, b) => a.sort_order - b.sort_order)

      const shownIn = (groupId: string) =>
        (data?.positions || [])
          .filter((p) => p.group_id === groupId)
          .map((p) => makePositionView(p, index))
          .filter((v) => positionPassesFilters(v, callingFilters))
          .map((v) => v.position)
          .filter((p) => !flaggedCallings || p.flagged)

      return {
        group,
        positions: filters.subgroupIds.length > 0 ? [] : shownIn(group.id),
        subgroups: subgroups
          .map((subgroup) => ({ group: subgroup, positions: shownIn(subgroup.id) }))
          .filter((s) => s.positions.length > 0),
      }
    })
    .filter((s) => s.positions.length > 0 || s.subgroups.length > 0)

  const totalShown = sections.reduce(
    (sum, s) => sum + s.positions.length + s.subgroups.reduce((n, x) => n + x.positions.length, 0),
    0
  )

  const membersShown = ctx.unassigned.filter((m) => {
    if (!filters.showInactive && m.archived_at) return false
    if (flaggedMembers && !m.flagged) return false
    if (filters.search && !m.full_name.toLowerCase().includes(filters.search.trim().toLowerCase()))
      return false
    return true
  })

  const releaseZone = useDroppable({
    id: dropId({ type: 'unassigned' }),
    data: { type: 'unassigned' },
    disabled: ctx.readOnly,
  })

  return (
    <div
      ref={panes.ref}
      data-assign-panes
      style={panes.height ? { height: panes.height } : undefined}
      className="grid grid-cols-1 gap-4 lg:grid-cols-2"
    >
      {/* Callings */}
      <div className="flex min-h-0 flex-col rounded-lg bg-white shadow">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 p-4 sm:px-6">
          <h2 className="text-lg font-semibold text-gray-900">
            {showAll ? 'All callings' : 'Open callings'}
          </h2>
          <div className="flex items-center gap-2 print:hidden">
            <div className="flex rounded border border-gray-300">
              <button
                onClick={() => setShowAll(false)}
                aria-pressed={!showAll}
                className={`rounded-l px-2.5 py-1 text-sm ${
                  !showAll ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                Open
              </button>
              <button
                onClick={() => setShowAll(true)}
                aria-pressed={showAll}
                className={`rounded-r px-2.5 py-1 text-sm ${
                  showAll ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                All
              </button>
            </div>
            <FlagFilter
              active={flaggedCallings}
              onClick={() => setFlaggedCallings((f) => !f)}
              title="Show only flagged callings"
            />
            <span className="text-sm text-gray-500">{totalShown}</span>
          </div>
        </div>

        <div data-assign-scroll className="min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
          {sections.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">
              {flaggedCallings
                ? 'No flagged callings match your filters.'
                : showAll
                  ? 'No callings match your filters.'
                  : 'Nothing open here — every calling that matches your filters is filled.'}
            </p>
          ) : (
            <div className="space-y-5">
            {sections.map((section) => (
              <div key={section.group.id}>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                  {section.group.name}
                </h3>

                {section.positions.length > 0 && (
                  <ul className="space-y-2">
                    {section.positions.map((position) => (
                      <OpenPositionRow
                        key={position.id}
                        position={position}
                        path={section.group.name}
                        ctx={ctx}
                      />
                    ))}
                  </ul>
                )}

                {section.subgroups.map((sub) => (
                  <div key={sub.group.id} className="mt-3 border-l-4 border-blue-100 pl-3">
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                      {sub.group.name}
                    </h4>
                    <ul className="space-y-2">
                      {sub.positions.map((position) => (
                        <OpenPositionRow
                          key={position.id}
                          position={position}
                          path={`${section.group.name} › ${sub.group.name}`}
                          ctx={ctx}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Available members */}
      <div
        ref={releaseZone.setNodeRef}
        className={`flex min-h-0 flex-col rounded-lg shadow transition-colors ${
          releaseZone.isOver ? 'bg-blue-50 ring-2 ring-blue-300' : 'bg-white'
        }`}
      >
        <div className="shrink-0 border-b border-gray-100 p-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-gray-900">Available members</h2>
            <div className="flex items-center gap-2 print:hidden">
              <FlagFilter
                active={flaggedMembers}
                onClick={() => setFlaggedMembers((f) => !f)}
                title="Show only flagged members"
              />
              <span className="text-sm text-gray-500">{membersShown.length}</span>
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-500 print:hidden">
            Drag someone onto a calling to assign them, or drop an assigned member here to release
            them.
          </p>
        </div>

        <div data-assign-scroll className="min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
          {membersShown.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">
              {flaggedMembers
                ? 'No flagged members are without a calling.'
                : 'Everyone matching your filters already has a calling.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {membersShown.map((member) => (
                <MemberChip
                  key={member.id}
                  member={member}
                  compact
                  drag={{ type: 'member', memberId: member.id, name: member.full_name }}
                  onToggleFlag={
                    ctx.readOnly ? undefined : () => ctx.actions.toggleMemberFlag(member)
                  }
                  onContextMenu={(e) => ctx.openMemberMenu(e, member)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
