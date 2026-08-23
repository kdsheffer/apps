import { createClient } from '@supabase/supabase-js'

// @ts-ignore - Vite env types
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
// @ts-ignore - Vite env types
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables')
}

/**
 * One client for both audiences. Most visitors never sign in, so this is
 * usually the anon key with no session — which reaches nothing but the
 * `public_*`, `book_slot`, `appointment_by_token` and `cancel_appointment`
 * functions. Every table is revoked from `anon` in migration 001.
 */
export const supabase = createClient(supabaseUrl, supabaseKey)
