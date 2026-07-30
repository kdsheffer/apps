import { useState } from 'react'
import { useBoardVersioning } from '../../hooks/useBoardVersioning'
import { PDFUpload } from '../PDFUpload'
import type { Board } from '../../types'
import type { ConfirmRequest } from './shared'

interface BoardsTabProps {
  wardId: string
  currentBoardId: string
  canEdit: boolean
  onLoadBoard: (boardId: string) => void
  confirm: (request: ConfirmRequest) => void
}

function StatusPill({ status }: { status: Board['status'] }) {
  if (status === 'promoted') {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
        Live · read-only
      </span>
    )
  }
  if (status === 'archived') {
    return (
      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600">
        Archived · read-only
      </span>
    )
  }
  return (
    <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
      Draft · editable
    </span>
  )
}

export function BoardsTab({
  wardId,
  currentBoardId,
  canEdit,
  onLoadBoard,
  confirm,
}: BoardsTabProps) {
  const versioning = useBoardVersioning(wardId)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const live = versioning.promotedBoard.data ?? null
  const draft = versioning.draft.data ?? null
  const archived = (versioning.allBoards.data || []).filter((b) => b.status === 'archived')

  const row = (board: Board, extra?: React.ReactNode) => {
    const isCurrent = board.id === currentBoardId

    return (
      <div
        key={board.id}
        className={`flex flex-col gap-3 rounded border p-3 sm:flex-row sm:items-center ${
          isCurrent ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-gray-50'
        }`}
      >
        <div className="min-w-0 flex-1">
          {renaming?.id === board.id ? (
            <div className="flex gap-2">
              <input
                autoFocus
                value={renaming.name}
                onChange={(e) => setRenaming({ id: board.id, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renaming.name.trim()) {
                    versioning.renameBoard.mutate({ boardId: board.id, name: renaming.name.trim() })
                    setRenaming(null)
                  }
                  if (e.key === 'Escape') setRenaming(null)
                }}
                className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => {
                  if (renaming.name.trim())
                    versioning.renameBoard.mutate({ boardId: board.id, name: renaming.name.trim() })
                  setRenaming(null)
                }}
                className="rounded bg-blue-600 px-2 py-1 text-xs text-white"
              >
                Save
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium text-gray-900">{board.name}</p>
              <StatusPill status={board.status} />
              {isCurrent && (
                <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
                  Loaded
                </span>
              )}
            </div>
          )}
          <p className="mt-0.5 text-xs text-gray-500">
            {board.status === 'promoted' && board.promoted_at
              ? `Promoted ${new Date(board.promoted_at).toLocaleDateString()}`
              : `Created ${new Date(board.created_at).toLocaleDateString()}`}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 sm:shrink-0">
          <button
            onClick={() => onLoadBoard(board.id)}
            disabled={isCurrent}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-default disabled:opacity-40"
          >
            {isCurrent ? 'Loaded' : 'Load'}
          </button>
          {extra}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-white p-4 shadow sm:p-6">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Board versions</h2>
            <p className="mt-1 text-sm text-gray-600">
              A ward has one live board and one draft. The live board can't be edited — change
              anything while it's loaded and the edit lands in the draft instead. Promoting the
              draft makes it live and files the old live board under history.
            </p>
          </div>
          {canEdit && !draft && (
            <button
              onClick={() => versioning.createDraft.mutate()}
              disabled={versioning.createDraft.isPending || !live}
              className="shrink-0 rounded bg-green-600 px-4 py-2 font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {versioning.createDraft.isPending ? 'Creating…' : 'Start a draft'}
            </button>
          )}
        </div>

        {live && (
          <div className="mb-5">
            <h3 className="mb-2 text-sm font-semibold text-gray-700">Live</h3>
            {row(live)}
          </div>
        )}

        <div className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Draft</h3>
          {!draft ? (
            <p className="text-sm text-gray-500">
              No draft yet. One opens automatically the first time you change the live board.
            </p>
          ) : (
            row(
              draft,
              canEdit ? (
                <>
                  <button
                    onClick={() => setRenaming({ id: draft.id, name: draft.name })}
                    className="rounded bg-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-300"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() =>
                      confirm({
                        title: 'Promote this draft?',
                        message: `"${draft.name}" becomes the live board.${
                          live ? ' The current live board moves into history.' : ''
                        }`,
                        confirmLabel: 'Promote',
                        onConfirm: async () => {
                          await versioning.promoteDraft.mutateAsync(draft.id)
                          onLoadBoard(draft.id)
                        },
                      })
                    }
                    disabled={versioning.promoteDraft.isPending}
                    className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    Promote
                  </button>
                  <button
                    onClick={() =>
                      confirm({
                        title: 'Discard this draft?',
                        message: `"${draft.name}" and every change in it will be permanently deleted.`,
                        confirmLabel: 'Discard',
                        onConfirm: async () => {
                          await versioning.deleteDraft.mutateAsync(draft.id)
                          if (draft.id === currentBoardId && live) onLoadBoard(live.id)
                        },
                      })
                    }
                    disabled={versioning.deleteDraft.isPending}
                    className="rounded bg-red-100 px-3 py-1.5 text-sm text-red-700 hover:bg-red-200 disabled:opacity-50"
                  >
                    Discard
                  </button>
                </>
              ) : null
            )
          )}
        </div>

        {archived.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-700">
              History ({archived.length})
            </h3>
            <div className="space-y-2">{archived.map((board) => row(board))}</div>
          </div>
        )}
      </div>

      <PDFUpload wardId={wardId} onSuccess={onLoadBoard} disabled={!canEdit} />
    </div>
  )
}
