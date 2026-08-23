import type { ReactNode } from 'react'

/**
 * A labelled input with room for a hint and an error underneath.
 *
 * The public booking form is the one screen in this app used by people who
 * aren't leadership, on a phone, once a year — so its fields get real labels
 * rather than placeholders, and errors sit against the field they belong to
 * instead of in a banner at the top.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string
  label: string
  hint?: ReactNode
  error?: string | null
  required?: boolean
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ml-1 text-red-700" aria-hidden="true">*</span>}
        {!required && <span className="ml-2 text-xs font-normal text-gray-500">optional</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-sm text-red-700">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  )
}

export const inputClass =
  'w-full rounded-md border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500'

export const errorInputClass =
  'w-full rounded-md border border-red-200 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-red-200'
