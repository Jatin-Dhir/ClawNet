import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';

const AuthContext = createContext();

const buildFallbackProfile = (session) => {
  if (!session?.user) return null;

  const metadata = session.user.user_metadata || {};
  const email = session.user.email?.toLowerCase() || '';
  const usernameFromEmail = email ? email.split('@')[0] : null;
  const rawUsername =
    metadata.username ||
    metadata.user_name ||
    metadata.preferred_username ||
    metadata.full_name?.replace(/\s+/g, '') ||
    usernameFromEmail ||
    `user-${session.user.id.slice(0, 6)}`;
  const normalizedUsername = rawUsername && rawUsername.length >= 3 ? rawUsername : `user-${session.user.id.slice(0, 6)}`;

  return {
    id: session.user.id,
    username: normalizedUsername,
    avatar_url: metadata.avatar_url || metadata.picture || null,
  };
};

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const initialise = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) {
          console.error('Error retrieving session:', error);
        }
        if (!isMounted) return;
        setSession(data?.session ?? null);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    initialise();

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);

      if (event === 'SIGNED_OUT') {
        setProfile(null);
      }
    });

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      return;
    }

    let cancelled = false;
    const fallback = buildFallbackProfile(session);
    setProfile((prev) => prev ?? fallback);

    const fetchOrCreateProfile = async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .single();

        if (cancelled) return;

        if (!error && data) {
          setProfile(data);
          return;
        }

        if (error && error.code !== 'PGRST116') {
          throw error;
        }

        const defaultProfile = {
          id: fallback.id,
          username: fallback.username,
          avatar_url: fallback.avatar_url,
        };

        const { data: insertData, error: insertError } = await supabase
          .from('profiles')
          .insert(defaultProfile)
          .select('*')
          .single();

        if (cancelled) return;

        if (insertError) {
          throw insertError;
        }

        setProfile(insertData);
      } catch (fetchError) {
        if (!cancelled) {
          console.error('Error ensuring profile:', fetchError);
          setProfile(fallback);
        }
      }
    };

    fetchOrCreateProfile();

    return () => {
      cancelled = true;
    };
  }, [session]);

  const value = useMemo(
    () => ({
      session,
      profile,
      loading,
      signUp: (data) => supabase.auth.signUp(data),
      signIn: (data) => supabase.auth.signInWithPassword(data),
      signOut: () => supabase.auth.signOut(),
      refreshProfile: async () => {
        if (!session?.user) {
          setProfile(null);
          return null;
        }

        try {
          const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();

          if (error) {
            throw error;
          }

          setProfile(data);
          return data;
        } catch (error) {
          console.error('Error refreshing profile:', error);
          const fallback = buildFallbackProfile(session);
          setProfile(fallback);
          return fallback;
        }
      },
    }),
    [session, profile, loading],
  );

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
