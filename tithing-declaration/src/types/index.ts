export interface Profile {
  id: string
  created_at: string
  is_super_admin: boolean
  email: string | null
  full_name: string | null
}

export type WardRoleName = 'admin' | 'viewer'
export type EffectiveRole = WardRoleName | 'super_admin' | 'none'

export interface WardRole {
  id: string
  ward_id: string
  user_id: string
  role: WardRoleName
  granted_by: string
  granted_at: string
}

export interface Ward {
  id: string
  name: string
  slug: string
  /** IANA name. Every slot time in the app is rendered in this zone, not the reader's. */
  timezone: string
  instructions: string | null
  contact_name: string | null
  contact_phone: string | null
  reminder_lead_hours: number
  created_at: string
  created_by: string
}

/** What the public booking page is allowed to know about a ward. */
export interface PublicWard {
  id: string
  name: string
  timezone: string
  instructions: string | null
  contact_name: string | null
  contact_phone: string | null
}

export interface ScheduleDay {
  id: string
  ward_id: string
  service_date: string
  location: string | null
  notes: string | null
  /** Non-null means it is open for booking on the public page. */
  published_at: string | null
  created_by: string
  created_at: string
}

export interface Slot {
  id: string
  day_id: string
  starts_at: string
  duration_minutes: number
  /** Non-null means the slot exists but nobody may book it. */
  blocked_at: string | null
  blocked_reason: string | null
  created_at: string
}

export interface Appointment {
  id: string
  slot_id: string
  ward_id: string
  family_name: string
  /** Optional: the secretary can write down a family name and nothing else. */
  phone: string | null
  phone_digits: string | null
  email: string | null
  notes: string | null
  cancel_token: string
  booked_by: string | null
  booked_by_admin: boolean
  cancelled_at: string | null
  cancelled_by: string | null
  cancelled_reason: string | null
  created_at: string
}

/** One row of `public_schedule()` — a free time, and nothing about who isn't free. */
export interface PublicSlot {
  day_id: string
  service_date: string
  location: string | null
  notes: string | null
  slot_id: string
  starts_at: string
  duration_minutes: number
}

/** What `book_slot()` hands back. */
export interface BookingReceipt {
  appointment_id: string
  cancel_token: string
  /** Absolute, built server-side from `app_settings.site_url`. */
  cancel_url: string
  starts_at: string
  timezone: string
  location: string | null
}

export type NotificationKind = 'confirmation' | 'reminder' | 'cancellation'
export type NotificationStatus = 'queued' | 'sent' | 'failed' | 'skipped'

export interface Notification {
  id: string
  ward_id: string
  appointment_id: string | null
  kind: NotificationKind
  to_address: string
  subject: string | null
  body: string
  status: NotificationStatus
  attempts: number
  error: string | null
  sent_at: string | null
  requested_by: string | null
  created_at: string
}

/** A slot with whoever holds it, as the admin schedule shows it. */
export interface SlotWithAppointment extends Slot {
  appointment: Appointment | null
}
