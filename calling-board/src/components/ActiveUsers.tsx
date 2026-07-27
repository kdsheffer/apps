import type { ActiveUser } from '../hooks/usePresence'

interface ActiveUsersProps {
  activeUsers: ActiveUser[]
}

function getInitials(email: string, fullName?: string): string {
  if (fullName) {
    const parts = fullName.split(' ')
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    return fullName.substring(0, 2).toUpperCase()
  }
  return email.substring(0, 2).toUpperCase()
}

function getColorForEmail(email: string): string {
  const colors = [
    'bg-blue-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-red-500',
    'bg-orange-500',
    'bg-green-500',
    'bg-indigo-500',
    'bg-cyan-500',
  ]
  const hash = email.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return colors[hash % colors.length]
}

export function ActiveUsers({ activeUsers }: ActiveUsersProps) {
  if (activeUsers.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-gray-600">Viewing:</span>
      <div className="flex gap-1">
        {activeUsers.map((user) => {
          const initials = getInitials(user.email, user.full_name)
          const color = getColorForEmail(user.email)

          return (
            <div key={user.user_id} className="group relative">
              <div
                className={`w-8 h-8 rounded-full ${color} flex items-center justify-center text-xs font-semibold text-white cursor-pointer hover:ring-2 hover:ring-offset-2 hover:ring-gray-300`}
                title={user.full_name || user.email}
              >
                {initials}
              </div>
              <div className="invisible group-hover:visible absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap z-50 pointer-events-none">
                {user.full_name || user.email}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
