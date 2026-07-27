export function formatTimeInCalling(calledDate: string): string {
  const called = new Date(calledDate)
  const today = new Date()

  // Calculate difference in milliseconds
  let ms = today.getTime() - called.getTime()
  if (ms < 0) return 'Future'

  // Convert to days
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))

  // Calculate years and months
  let years = 0
  let months = 0
  let remaining = days

  // Approximate: 365 days per year
  years = Math.floor(remaining / 365)
  remaining -= years * 365

  // Approximate: 30 days per month
  months = Math.floor(remaining / 30)

  if (years === 0 && months === 0) {
    return `${days}d`
  }

  if (years === 0) {
    return `${months}m`
  }

  if (months === 0) {
    return `${years}y`
  }

  return `${years}y${months}m`
}
