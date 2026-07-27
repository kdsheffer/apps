import { createClient } from '@supabase/supabase-js'

// @ts-ignore - Vite env types
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
// @ts-ignore - Vite env types
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseKey)
