import type { BoardActions } from '../../hooks/useBoardActions'
import type { BoardData } from '../../hooks/useBoardData'
import type { BoardIndex, FilteredNode } from '../../lib/boardSelectors'
import type { BoardFilters, Member, Position } from '../../types'

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void | Promise<void>
}

/** Everything the tab views share, assembled once in BoardPage. */
export interface BoardViewContext {
  wardId: string
  data: BoardData | undefined
  index: BoardIndex
  tree: FilteredNode[]
  actions: BoardActions
  filters: BoardFilters
  /** member id -> titles of every calling they hold on this board */
  servingElsewhere: Map<string, string[]>
  /** Members visible given the inactive filter. */
  visibleMembers: Member[]
  unassigned: Member[]
  readOnly: boolean
  openMemberMenu: (event: React.MouseEvent, member: Member, assignmentId?: string) => void
  /** `onRename` is supplied by whichever card owns the inline rename field. */
  openPositionMenu: (
    event: React.MouseEvent,
    position: Position,
    handlers?: { onRename?: () => void }
  ) => void
  confirm: (request: ConfirmRequest) => void
}
