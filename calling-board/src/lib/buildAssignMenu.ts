import type { MenuItem } from '../components/ContextMenu'
import type { BoardIndex } from './boardSelectors'
import type { AssignAction, GroupNode, Position } from '../types'

interface Options {
  tree: GroupNode[]
  index: BoardIndex
  /** The member being assigned — used to word the actions and skip no-ops. */
  memberId: string
  memberName: string
  onAssign: (positionId: string, action: AssignAction) => void
}

function actionsFor(
  position: Position,
  { index, memberId, memberName, onAssign }: Options
): MenuItem[] {
  const occupants = index.byPosition.get(position.id) || []
  const alreadyHere = occupants.some((o) => o.assignment.member_id === memberId)
  const holdsSomething = (index.byMember.get(memberId) || []).length > 0

  const items: MenuItem[] = [
    { kind: 'header', label: position.title },
    {
      kind: 'action',
      icon: '+',
      label: 'Add',
      detail: `${memberName} keeps any other callings`,
      disabled: alreadyHere,
      onSelect: () => onAssign(position.id, 'add'),
    },
    {
      kind: 'action',
      icon: '→',
      label: 'Move here',
      detail: holdsSomething
        ? 'Releases their current calling first'
        : 'They hold nothing to release',
      disabled: alreadyHere,
      onSelect: () => onAssign(position.id, 'move'),
    },
  ]

  if (occupants.length > 0) {
    items.push({
      kind: 'action',
      icon: '⇄',
      label: 'Replace',
      detail: `Releases ${occupants.map((o) => o.member?.full_name).filter(Boolean).join(', ')}`,
      danger: true,
      onSelect: () => onAssign(position.id, 'replace'),
    })
  }

  return items
}

function positionItem(position: Position, path: string, options: Options): MenuItem {
  const occupants = options.index.byPosition.get(position.id) || []
  const held = occupants.map((o) => o.member?.full_name).filter(Boolean).join(', ')

  return {
    kind: 'submenu',
    label: position.title,
    // Naming the current occupant makes "add vs replace" obvious before you
    // open the submenu; an open calling shows its path instead.
    detail: held ? `${path} — ${held}` : `${path} — open`,
    items: actionsFor(position, options),
  }
}

/**
 * The "Assign to calling" tree: organization › subgroup › calling › action.
 * Also produces a flattened, fully-qualified list so the submenu's search box
 * can jump straight to a calling instead of walking the hierarchy.
 */
export function buildAssignMenu(options: Options): MenuItem {
  const { tree } = options
  const flat: MenuItem[] = []

  const groupItems: MenuItem[] = tree.map((node) => {
    const children: MenuItem[] = []

    if (node.positions.length > 0) {
      children.push({ kind: 'header', label: node.group.name })
      for (const position of node.positions) {
        children.push(positionItem(position, node.group.name, options))
        flat.push(positionItem(position, node.group.name, options))
      }
    }

    for (const sub of node.subgroups) {
      const subItems = sub.positions.map((position) =>
        positionItem(position, `${node.group.name} › ${sub.group.name}`, options)
      )

      for (const position of sub.positions) {
        flat.push(positionItem(position, `${node.group.name} › ${sub.group.name}`, options))
      }

      children.push({
        kind: 'submenu',
        label: sub.group.name,
        icon: '›',
        items:
          subItems.length > 0
            ? subItems
            : [{ kind: 'header', label: 'No callings in this subgroup' }],
      })
    }

    return {
      kind: 'submenu',
      label: node.group.name,
      items:
        children.length > 0
          ? children
          : [{ kind: 'header', label: 'No callings in this organization' }],
    }
  })

  return {
    kind: 'submenu',
    icon: '⌖',
    label: 'Assign to calling…',
    items:
      groupItems.length > 0
        ? groupItems
        : [{ kind: 'header', label: 'This board has no callings yet' }],
    search: { placeholder: 'Search callings…', flat },
  }
}
