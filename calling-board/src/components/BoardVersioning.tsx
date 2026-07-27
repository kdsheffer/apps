import { useState } from 'react'
import { useBoardVersioning } from '../hooks/useBoardVersioning'
import { ConfirmDialog } from './ConfirmDialog'
import type { Board } from '../types'

interface BoardVersioningProps {
  wardId: string
  currentBoardId: string
  onSwitchBoard: (boardId: string) => void
}

export function BoardVersioning({
  wardId,
  currentBoardId,
  onSwitchBoard,
}: BoardVersioningProps) {
  const versioning = useBoardVersioning(wardId)
  const [promoteConfirm, setPromoteConfirm] = useState<{
    isOpen: boolean
    draftBoardId: string | null
    draftName: string
    otherDraftsCount: number
  }>({
    isOpen: false,
    draftBoardId: null,
    draftName: '',
    otherDraftsCount: 0,
  })

  const [deleteConfirm, setDeleteConfirm] = useState<{
    isOpen: boolean
    draftBoardId: string | null
    draftName: string
  }>({
    isOpen: false,
    draftBoardId: null,
    draftName: '',
  })

  const handlePromoteClick = (draft: Board) => {
    const otherDrafts = versioning.drafts.data?.filter((d) => d.id !== draft.id) || []
    setPromoteConfirm({
      isOpen: true,
      draftBoardId: draft.id,
      draftName: draft.name,
      otherDraftsCount: otherDrafts.length,
    })
  }

  const handleConfirmPromote = async () => {
    if (promoteConfirm.draftBoardId) {
      await versioning.promoteDraft.mutateAsync(promoteConfirm.draftBoardId)
      onSwitchBoard(promoteConfirm.draftBoardId)
      setPromoteConfirm({
        isOpen: false,
        draftBoardId: null,
        draftName: '',
        otherDraftsCount: 0,
      })
    }
  }

  const handleDeleteClick = (draft: Board) => {
    setDeleteConfirm({
      isOpen: true,
      draftBoardId: draft.id,
      draftName: draft.name,
    })
  }

  const handleConfirmDelete = async () => {
    if (deleteConfirm.draftBoardId) {
      await versioning.deleteDraft.mutateAsync(deleteConfirm.draftBoardId)
      setDeleteConfirm({
        isOpen: false,
        draftBoardId: null,
        draftName: '',
      })
    }
  }

  const currentBoard = versioning.allBoards.data?.find((b) => b.id === currentBoardId)

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Board Version</h2>
          {currentBoard && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm text-gray-600">Current:</span>
              <span className="px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                {currentBoard.status === 'promoted' ? '✓ Promoted' : '📋 Draft'}
              </span>
            </div>
          )}
        </div>

        <button
          onClick={() => versioning.createDraft.mutate()}
          disabled={versioning.createDraft.isPending || !versioning.promotedBoard.data}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {versioning.createDraft.isPending ? 'Creating...' : '+ New Draft'}
        </button>
      </div>

      {/* Drafts section */}
      {versioning.drafts.data && versioning.drafts.data.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Drafts</h3>
          <div className="space-y-2">
            {versioning.drafts.data.map((draft) => (
              <div
                key={draft.id}
                className={`flex items-center justify-between p-3 rounded border ${
                  draft.id === currentBoardId
                    ? 'border-blue-300 bg-blue-50'
                    : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                }`}
              >
                <div className="flex-1">
                  <p className="font-medium text-gray-900">{draft.name}</p>
                  <p className="text-xs text-gray-500">
                    Created {new Date(draft.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  {draft.id !== currentBoardId && (
                    <button
                      onClick={() => onSwitchBoard(draft.id)}
                      className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded"
                    >
                      Switch
                    </button>
                  )}
                  <button
                    onClick={() => handlePromoteClick(draft)}
                    disabled={versioning.promoteDraft.isPending}
                    className="px-3 py-1 text-sm bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50"
                  >
                    Promote
                  </button>
                  {draft.id !== currentBoardId && (
                    <button
                      onClick={() => handleDeleteClick(draft)}
                      disabled={versioning.deleteDraft.isPending}
                      className="px-3 py-1 text-sm bg-red-100 hover:bg-red-200 text-red-700 rounded disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Archived boards section (read-only info) */}
      {versioning.allBoards.data && versioning.allBoards.data.some((b) => b.status === 'archived') && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Archived Boards</h3>
          <div className="space-y-2">
            {versioning.allBoards.data
              .filter((b) => b.status === 'archived')
              .map((archived) => (
                <div key={archived.id} className="p-3 rounded border border-gray-200 bg-gray-50">
                  <p className="font-medium text-gray-900">{archived.name}</p>
                  <p className="text-xs text-gray-500">
                    Archived {new Date(archived.promoted_at || archived.created_at).toLocaleDateString()}
                  </p>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Promote confirmation */}
      <ConfirmDialog
        isOpen={promoteConfirm.isOpen}
        title="Promote Draft to Live?"
        message={`
          "${promoteConfirm.draftName}" will become the live board.
          ${
            promoteConfirm.otherDraftsCount > 0
              ? `${promoteConfirm.otherDraftsCount} other draft(s) will be deleted.`
              : 'The current live board will be archived.'
          }
        `}
        confirmLabel="Promote"
        isDangerous
        isLoading={versioning.promoteDraft.isPending}
        onConfirm={handleConfirmPromote}
        onCancel={() =>
          setPromoteConfirm({
            isOpen: false,
            draftBoardId: null,
            draftName: '',
            otherDraftsCount: 0,
          })
        }
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title="Delete Draft?"
        message={`"${deleteConfirm.draftName}" will be permanently deleted.`}
        confirmLabel="Delete"
        isDangerous
        isLoading={versioning.deleteDraft.isPending}
        onConfirm={handleConfirmDelete}
        onCancel={() =>
          setDeleteConfirm({
            isOpen: false,
            draftBoardId: null,
            draftName: '',
          })
        }
      />
    </div>
  )
}
