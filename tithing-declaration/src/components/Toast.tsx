interface ToastProps {
  tone?: 'info' | 'error'
  children: React.ReactNode
  onDismiss: () => void
  action?: { label: string; onClick: () => void }
}

export function Toast({ tone = 'info', children, onDismiss, action }: ToastProps) {
  return (
    <div className="fixed inset-x-4 bottom-4 z-40 flex justify-center sm:inset-x-auto sm:right-6">
      <div
        role="status"
        className={`flex max-w-md items-start gap-3 rounded-lg px-4 py-3 shadow-lg ${
          tone === 'error' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'
        }`}
      >
        <p className="flex-1 text-sm">{children}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="shrink-0 text-sm font-semibold underline underline-offset-2"
          >
            {action.label}
          </button>
        )}
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-white/60 hover:text-white"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
