import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://ueyprbyiceqwohhptgim.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVleXByYnlpY2Vxd29oaHB0Z2ltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4OTIyMzUsImV4cCI6MjA3NzQ2ODIzNX0.hYe4ex8PYNpyBFRzKSVNMXougnsCXmhI8URJoqYN4w4'

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase URL and Anon Key should be provided via environment variables.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
