/** Payloads carried by @dnd-kit drags on the board. */
export type DragData =
  | { type: 'member'; memberId: string; name: string }
  | {
      type: 'assignment'
      memberId: string
      name: string
      assignmentId: string
      positionId: string
    }

export type DropData = { type: 'position'; positionId: string } | { type: 'unassigned' }

export const dragId = (data: DragData) =>
  data.type === 'member' ? `member:${data.memberId}` : `assignment:${data.assignmentId}`

export const dropId = (data: DropData) =>
  data.type === 'position' ? `position:${data.positionId}` : 'unassigned'
