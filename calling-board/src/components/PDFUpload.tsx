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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.type !== 'application/pdf') {
        setError('Please select a PDF file')
        return
      }
      setSelectedFileName(file.name)
      setError('')
    }
  }

  const handleUpload = async () => {
    if (!fileInputRef.current?.files?.[0]) {
      setError('Please select a file')
      return
    }

    const file = fileInputRef.current.files[0]
    try {
      console.log('🚀 Starting PDF import from UI...')
      const result = await importMutation.mutateAsync(file)
      console.log('✅ Import successful! Redirecting to board...')
      // Redirect to the new board
      onSuccess(result.boardId)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Import failed'
      console.error('❌ Import failed:', errorMsg)
      setError(errorMsg)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Import from LCR PDF</h2>

      <div className="space-y-4">
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 font-medium"
          >
            Choose PDF
          </button>

          {selectedFileName && (
            <div className="flex-1 px-4 py-2 bg-gray-50 rounded border border-gray-200 flex items-center text-gray-700">
              <span className="text-sm font-medium truncate">{selectedFileName}</span>
            </div>
          )}
        </div>

        {error && <div className="text-sm text-red-600 font-medium">{error}</div>}

        {selectedFileName && (
          <>
            <button
              onClick={handleUpload}
              disabled={importMutation.isPending}
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {importMutation.isPending ? 'Importing...' : 'Import LCR Data'}
            </button>
            {importMutation.isPending && (
              <div className="mt-4 p-4 bg-blue-50 rounded border border-blue-200">
                <div className="text-sm text-blue-700 font-medium mb-2">
                  🔄 Import in progress...
                </div>
                <div className="text-xs text-blue-600 space-y-1">
                  <div>This may take a minute or two for large files.</div>
                  <div className="mt-2 font-mono text-blue-500">
                    Open your browser console (F12) to see detailed progress logs.
                  </div>
                  <div className="mt-2 text-blue-600">
                    Steps: Parsing → Creating Members → Creating Board → Importing Positions & Callings
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <div className="text-xs text-gray-500 space-y-1">
          <p>📄 Upload an LCR "Organizations and Callings" PDF export</p>
          <p>✓ Creates a draft board with all positions and assignments</p>
          <p>✓ You can review and edit before promoting to live</p>
        </div>
      </div>
    </div>
  )
}
