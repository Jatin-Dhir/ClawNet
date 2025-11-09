import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Supabase URL and anonymous key are required. Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your environment.'
  );
}

const getPreferredStorage = () => {
  if (typeof window === 'undefined') return null;

  const rememberPreference = window.localStorage.getItem('clawnet_remember_me');
  const shouldRemember = rememberPreference !== 'false';

  return shouldRemember ? window.localStorage : window.sessionStorage;
};

const storageAdapter = {
  getItem: (key) => {
    if (typeof window === 'undefined') return null;
    const storage = getPreferredStorage();
    return storage?.getItem(key) ?? null;
  },
  setItem: (key, value) => {
    if (typeof window === 'undefined') return;
    const storage = getPreferredStorage();
    if (storage) {
      storage.setItem(key, value);
    }
  },
  removeItem: (key) => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  },
};

if (typeof window !== 'undefined' && window.localStorage.getItem('clawnet_remember_me') === null) {
  window.localStorage.setItem('clawnet_remember_me', 'true');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: storageAdapter,
  },
});
