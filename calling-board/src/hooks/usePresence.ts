import { useEffect, useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { Profile } from '../types'

export interface ActiveUser extends Profile {
  user_id: string
  email: string
  full_name?: string
}

export function usePresence(boardId: string | undefined) {
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([])
  const [currentUser, setCurrentUser] = useState<ActiveUser | null>(null)
  const presenceRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  useEffect(() => {
    const fetchCurrentUser = async () => {
      const { data } = await supabase.auth.getUser()
      if (data.user) {
        // Fetch profile to get is_super_admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', data.user.id)
          .single()

        setCurrentUser({
          id: data.user.id,
          user_id: data.user.id,
          email: data.user.email || '',
          is_super_admin: profile?.is_super_admin || false,
          created_at: profile?.created_at || new Date().toISOString(),
          full_name: data.user.user_metadata?.full_name,
        })
      }
    }

    fetchCurrentUser()
  }, [])

  useEffect(() => {
    if (!boardId || !currentUser) return

    // Create presence channel
    const channel = supabase.channel(`presence_${boardId}`, {
      config: {
        presence: {
          key: currentUser.user_id,
        },
      },
    })

    presenceRef.current = channel

    // Listen for presence changes
    channel
      .on('presence', { event: 'sync' }, () => {
        const presence = channel.presenceState()
        const users = Object.values(presence)
          .flat()
          .map((presence: any) => ({
            id: presence.user_id,
            user_id: presence.user_id,
            email: presence.email,
            full_name: presence.full_name,
            is_super_admin: presence.is_super_admin || false,
            created_at: new Date().toISOString(),
          }))
          .filter((user) => user.user_id !== currentUser.user_id) // Don't include current user

        setActiveUsers(users)
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        const newUser = newPresences[0]
        if (newUser && newUser.user_id !== currentUser.user_id) {
          setActiveUsers((prev) => {
            const exists = prev.some((u) => u.user_id === newUser.user_id)
            if (exists) return prev
            return [
              ...prev,
              {
                id: newUser.user_id,
                user_id: newUser.user_id,
                email: newUser.email,
                full_name: newUser.full_name,
                is_super_admin: newUser.is_super_admin || false,
                created_at: new Date().toISOString(),
              },
            ]
          })
        }
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        const leftUser = leftPresences[0]
        if (leftUser) {
          setActiveUsers((prev) => prev.filter((u) => u.user_id !== leftUser.user_id))
        }
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({
            user_id: currentUser.user_id,
            email: currentUser.email,
            full_name: currentUser.full_name,
            is_super_admin: currentUser.is_super_admin,
          })
        }
      })

    return () => {
      channel.unsubscribe()
    }
  }, [boardId, currentUser])

  return {
    activeUsers,
    currentUser,
  }
}
