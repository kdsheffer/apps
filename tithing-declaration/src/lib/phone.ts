/**
 * Phone numbers, as typed by people who are not thinking about phone numbers.
 *
 * The database compares on digits only (`appointments.phone_digits`), so
 * nothing here has to produce a canonical form for storage — the original text
 * is kept exactly as entered. These functions are for showing it back and for
 * catching a mistyped number before it becomes a booking nobody can reach.
 */

/** Just the digits: what the database matches on. */
export function digitsOf(phone: string): string {
  return (phone ?? '').replace(/\D/g, '')
}

/**
 * A US ten-digit number as (801) 555-0123, or an eleven-digit one with a
 * leading 1. Anything else — an international number, an extension, something
 * half-typed — is handed back untouched rather than mangled into a shape it
 * isn't.
 */
export function formatPhone(phone: string): string {
  const digits = digitsOf(phone)
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (local.length !== 10) return phone
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
}

/**
 * Whether this is worth submitting. Deliberately loose: seven digits is the
 * shortest thing that could be a real number, and the database agrees. Being
 * stricter here would reject somebody's perfectly good number and leave them
 * with no way to book.
 */
export function isPlausiblePhone(phone: string): boolean {
  const n = digitsOf(phone).length
  return n >= 7 && n <= 15
}

/** Loose enough to catch a typo, not so strict it argues with a valid address. */
export function isPlausibleEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
}

