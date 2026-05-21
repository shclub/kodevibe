// Re-export from pg-client — drop-in replacement for @supabase/supabase-js
export { createClient, createServerClient, isDBConnectionError } from './pg-client'
export type { User, OneTimeToken, Session } from './database.types'
