import { useRef, useState } from 'react'
import { usePDFImport } from '../hooks/usePDFImport'

interface PDFUploadProps {
  wardId: string
  onSuccess: (boardId: string) => void
}

export function PDFUpload({ wardId, onSuccess }: PDFUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFileName, setSelectedFileName] = useState<string>('')
  const [error, setError] = useState<string>('')
  const importMutation = usePDFImport(wardId)

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
  }

  const handleUpload = async () => {
    const file = fileInputRef.current?.files?.[0]
    if (!file) {
      setError('Choose a PDF first.')
      return
    }

    setError('')
    try {
      const result = await importMutation.mutateAsync(file)
      onSuccess(result.boardId)
      clearSelection()
    } catch (err) {
      console.error('[Import] Failed:', err)
      setError(err instanceof Error ? err.message : 'The import failed. Please try again.')
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Import from LCR PDF</h2>

      <div className="space-y-4">
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
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 font-medium disabled:opacity-50 sm:shrink-0"
          >
            Choose PDF
          </button>

          {selectedFileName && (
            <div className="flex flex-1 min-w-0 items-center gap-2 px-4 py-2 bg-gray-50 rounded border border-gray-200 text-gray-700">
              <span className="text-sm font-medium truncate">{selectedFileName}</span>
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
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importMutation.isPending ? 'Importing…' : 'Import LCR Data'}
            </button>
            {importMutation.isPending && (
              <p className="text-sm text-gray-600">
                Reading the report and building a draft board. Large reports take a few moments.
              </p>
            )}
          </>
        )}

        <div className="text-xs text-gray-500 space-y-1">
          <p>Upload the "Organizations and Callings" report exported from LCR.</p>
          <p>The import creates a draft you can review and edit before promoting it.</p>
        </div>
      </div>
    </div>
  )
}
