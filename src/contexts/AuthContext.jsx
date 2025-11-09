import React, { createContext, useState, useEffect, useContext } from 'react';
import { supabase } from '../supabaseClient';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);
      setLoading(false);
    };
    getSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      return;
    }

    const fetchOrCreateProfile = async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .single();

        if (!error && data) {
          setProfile(data);
          return;
        }

        if (error && error.code !== 'PGRST116') {
          throw error;
        }

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
        const normalizedUsername =
          rawUsername && rawUsername.length >= 3 ? rawUsername : `user-${session.user.id.slice(0, 6)}`;

        const defaultProfile = {
          id: session.user.id,
          username: normalizedUsername,
          avatar_url: metadata.avatar_url || metadata.picture || null,
        };

        const { data: insertData, error: insertError } = await supabase
          .from('profiles')
          .insert(defaultProfile)
          .select('*')
          .single();

        if (insertError) {
          throw insertError;
        }

        setProfile(insertData);
      } catch (fetchError) {
        console.error('Error ensuring profile:', fetchError);
        setProfile(null);
      }
    };

    fetchOrCreateProfile();
  }, [session]);

  const value = {
    session,
    profile,
    loading,
    signUp: (data) => supabase.auth.signUp(data),
    signIn: (data) => supabase.auth.signInWithPassword(data),
    signOut: () => supabase.auth.signOut(),
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  return useContext(AuthContext);
};
