import { useEffect, useMemo, useRef, useState } from 'react'
import { usePDFImport, type BaseBoardChoice, type ImportResult } from '../hooks/usePDFImport'
import { useBoardVersioning } from '../hooks/useBoardVersioning'

interface PDFUploadProps {
  wardId: string
  onSuccess: (boardId: string) => void
  disabled?: boolean
}

const START_FRESH = '__fresh__'

export function PDFUpload({ wardId, onSuccess, disabled }: PDFUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFileName, setSelectedFileName] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [base, setBase] = useState<string | null>(null)

  const importMutation = usePDFImport(wardId)
  const versioning = useBoardVersioning(wardId)

  const draft = versioning.draft.data ?? null
  const live = versioning.promotedBoard.data ?? null
  const allBoards = versioning.allBoards.data
  const archived = useMemo(
    () => (allBoards || []).filter((b) => b.status === 'archived'),
    [allBoards]
  )

  /**
   * The board the merge starts from. Merging into the draft that already exists
   * is nearly always what you want — it's where your unpromoted work lives — so
   * it leads, and it's the default.
   */
  const options = useMemo(() => {
    const list: { value: string; label: string; hint?: string }[] = []
    if (draft) {
      list.push({
        value: draft.id,
        label: `${draft.name} (working draft)`,
        hint: 'Merges into the draft you have been editing. Nothing is lost.',
      })
    }
    if (live) {
      list.push({
        value: live.id,
        label: `${live.name} (live board)`,
        hint: draft
          ? 'Starts a new draft from the live board. Your current draft is discarded.'
          : 'Starts a draft from the live board and merges the report into it.',
      })
    }
    for (const board of archived) {
      list.push({
        value: board.id,
        label: `${board.name} (archived)`,
        hint: draft
          ? 'Starts a new draft from this archived board. Your current draft is discarded.'
          : 'Starts a draft from this archived board.',
      })
    }
    list.push({
      value: START_FRESH,
      label: 'Start fresh — no base board',
      hint: draft
        ? 'Builds a board from the report alone. Your current draft is discarded, and nothing you flagged or marked inactive carries over.'
        : 'Builds a board from the report alone. Nothing carries over.',
    })
    return list
  }, [archived, draft, live])

  // Default to the draft, then the live board, then the only option there is.
  useEffect(() => {
    if (base && options.some((o) => o.value === base)) return
    setBase(options[0]?.value ?? START_FRESH)
  }, [base, options])

  const chosen = options.find((o) => o.value === base)
  const replacesDraft = !!draft && base !== draft.id

  const clearSelection = () => {
    if (fileInputRef.current) fileInputRef.current.value = ''
    setSelectedFileName('')
    setError('')
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.type !== 'application/pdf') {
      setError('That file is not a PDF. Export the report from LCR using "Save as PDF".')
      clearSelection()
      return
    }
    setSelectedFileName(file.name)
    setError('')
    setResult(null)
  }

  const handleUpload = async () => {
    const file = fileInputRef.current?.files?.[0]
    if (!file) {
      setError('Choose a PDF first.')
      return
    }

    setError('')
    try {
      const baseBoardId: BaseBoardChoice = base === START_FRESH ? null : base
      const imported = await importMutation.mutateAsync({ file, baseBoardId })
      setResult(imported)
      onSuccess(imported.boardId)
      clearSelection()
    } catch (err) {
      console.error('[Import] Failed:', err)
      setError(err instanceof Error ? err.message : 'The import failed. Please try again.')
    }
  }

  if (disabled) return null

  return (
    <div className="rounded-lg bg-white p-6 shadow">
      <h2 className="mb-1 text-lg font-semibold text-gray-900">Import from LCR PDF</h2>
      <p className="mb-4 text-sm text-gray-600">
        The report is merged into your draft rather than replacing it. Flags, notes, parked
        callings and callings you added by hand all survive — what comes across from LCR is who
        holds which calling.
      </p>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="import-base"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Merge into
          </label>
          <select
            id="import-base"
            value={base ?? START_FRESH}
            onChange={(e) => setBase(e.target.value)}
            disabled={importMutation.isPending}
            className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {chosen?.hint && <p className="mt-1 text-xs text-gray-500">{chosen.hint}</p>}
        </div>

        {replacesDraft && (
          <div className="rounded border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-900">
              This discards your current draft <strong>{draft?.name}</strong> and everything in it
              that hasn't been promoted.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importMutation.isPending}
            className="rounded bg-gray-200 px-4 py-2 font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 sm:shrink-0"
          >
            Choose PDF
          </button>

          {selectedFileName && (
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded border border-gray-200 bg-gray-50 px-4 py-2 text-gray-700">
              <span className="truncate text-sm font-medium">{selectedFileName}</span>
              {!importMutation.isPending && (
                <button
                  onClick={clearSelection}
                  aria-label="Clear selected file"
                  className="ml-auto shrink-0 text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-medium text-red-800">Import failed</p>
            <p className="mt-1 text-sm text-red-700">{error}</p>
          </div>
        )}

        {selectedFileName && (
          <>
            <button
              onClick={handleUpload}
              disabled={importMutation.isPending}
              className="w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importMutation.isPending ? 'Importing…' : 'Import LCR Data'}
            </button>
            {importMutation.isPending && (
              <p className="text-sm text-gray-600">
                Reading the report and merging it in. Large reports take a few moments.
              </p>
            )}
          </>
        )}

        {result && <ImportSummary result={result} />}
      </div>
    </div>
  )
}

function ImportSummary({ result }: { result: ImportResult }) {
  const s = result.summary

  const lines: string[] = []
  if (s.called) lines.push(`${s.called} called`)
  if (s.released) lines.push(`${s.released} released`)
  if (s.unchanged) lines.push(`${s.unchanged} unchanged`)
  if (s.callingsAdded) lines.push(`${s.callingsAdded} new callings`)
  if (s.groupsAdded) lines.push(`${s.groupsAdded} new organizations`)
  if (s.membersAdded) lines.push(`${s.membersAdded} new members`)
  if (s.callingsReactivated) lines.push(`${s.callingsReactivated} callings reactivated`)
  if (s.membersReactivated) lines.push(`${s.membersReactivated} members reactivated`)
  if (s.manualKept) lines.push(`${s.manualKept} hand-added callings untouched`)

  return (
    <div className="rounded border border-green-200 bg-green-50 p-4">
      <p className="text-sm font-medium text-green-900">
        Merged into {result.boardName}
      </p>
      <p className="mt-1 text-sm text-green-800">
        {lines.length > 0 ? lines.join(' · ') : 'Nothing changed — the report matches the board.'}
      </p>

      {result.retired.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-green-900">
            {result.retired.length} calling(s) are no longer in the report
          </summary>
          <p className="mt-1 text-xs text-green-800">
            Left on the board and now vacant, in case they're still yours to track. Delete any you
            don't need.
          </p>
          <ul className="mt-2 list-inside list-disc text-xs text-green-800">
            {result.retired.map((position) => (
              <li key={position.id}>{position.title}</li>
            ))}
          </ul>
        </details>
      )}

      {result.absentMembers.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-green-900">
            {result.absentMembers.length} member(s) weren't in the report
          </summary>
          <p className="mt-1 text-xs text-green-800">
            They may have moved out. Nothing was changed — mark them inactive from the Members tab
            if they've gone.
          </p>
          <ul className="mt-2 list-inside list-disc text-xs text-green-800">
            {result.absentMembers.map((member) => (
              <li key={member.id}>{member.full_name}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
