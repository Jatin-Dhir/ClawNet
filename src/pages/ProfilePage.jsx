import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useOutletContext, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Award,
  Calendar,
  MapPin,
  Link as LinkIcon,
  Sparkles,
  Zap,
  Shield,
  Activity,
  Medal,
  Target,
  Edit3,
  UploadCloud,
  Image as ImageIcon,
  Settings2,
  Bell,
  Mail,
  Globe,
  UserCog,
  Save,
  Star,
  Eye,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../contexts/AuthContext';
import RewardToken from '../components/RewardToken';
import toast from 'react-hot-toast';

const STORAGE_BUCKET = 'profile-media';

const DEFAULT_PREFERENCES = {
  missionAlerts: true,
  weeklyDigest: true,
  showcasePublic: true,
  emailUpdates: true,
  darkInterface: true,
};

const BADGE_LIBRARY = {
  'vault-specter': {
    title: 'Vault Specter',
    description: 'Seasonal vault intrusion champion',
    accent: '#FF6B6B',
  },
  'signal-interceptor': {
    title: 'Signal Interceptor',
    description: 'Weekly beacon hunt finisher',
    accent: '#00E0FF',
  },
  'pattern-decoder': {
    title: 'Pattern Decoder',
    description: 'Daily anomaly decoding streak',
    accent: '#00F5FF',
  },
  'arcade-auditor': {
    title: 'Arcade Auditor',
    description: 'First-response quick task',
    accent: '#A78BFA',
  },
  'artifact-analyst': {
    title: 'Artifact Analyst',
    description: 'Malware trace analyst',
    accent: '#FACC15',
  },
  'perimeter-pinger': {
    title: 'Perimeter Pinger',
    description: 'Perimeter scan specialist',
    accent: '#34D399',
  },
};

const FALLBACK_PROFILE = (username) => ({
  username: username ?? 'operative',
  display_name: 'ClawNet Operative',
  avatar_url: null,
  bio: 'Cybersecurity operative keeping ClawNet safe.',
  location: 'Unknown Grid Node',
  website: null,
  pronouns: null,
  xp: 0,
  badges: ['perimeter-pinger'],
  created_at: new Date().toISOString(),
  preferences: DEFAULT_PREFERENCES,
  badge_showcase_order: ['perimeter-pinger'],
});

const PROFILE_SELECT = `
  id,
  username,
  display_name,
  avatar_url,
  bio,
  location,
  website,
  pronouns,
  banner_url,
  xp,
  badges,
  reputation,
  preferences,
  badge_showcase_order,
  created_at
`;

const ACTIVITY_SELECT = `
  id,
  body,
  created_at,
  mission_threads(
    mission_id,
    mission:missions_featured(
      title,
      slug,
      band,
      difficulty,
      difficulty_color
    )
  )
`;

const xpLevelFromTotal = (xp) => {
  const level = Math.floor((xp ?? 0) / 500) + 1;
  const nextLevel = level * 500;
  const prevLevel = (level - 1) * 500;
  const progress = Math.min(1, Math.max(0, ((xp ?? 0) - prevLevel) / (nextLevel - prevLevel || 1)));
  return { level, progress, nextLevel };
};

const resolveBadges = (badgePayload) => {
  if (!badgePayload) return [];
  if (Array.isArray(badgePayload)) {
    return badgePayload
      .map((item) => {
        if (typeof item === 'string') {
          return { slug: item, ...(BADGE_LIBRARY[item] ?? { title: item }) };
        }
        if (item && typeof item === 'object') {
          const slug = item.slug ?? item.id ?? item.code ?? item.title?.toLowerCase()?.replace(/\s+/g, '-');
          return {
            slug,
            ...(BADGE_LIBRARY[slug] ?? {}),
            ...item,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  if (typeof badgePayload === 'string') {
    try {
      const parsed = JSON.parse(badgePayload);
      return resolveBadges(parsed);
    } catch (error) {
      return resolveBadges([badgePayload]);
    }
  }

  return [];
};

const ProfilePage = () => {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const outletContext = useOutletContext() || {};
  const { triggerTransition, onSignInClick } = outletContext || {};
  const { session, profile } = useAuth();

  const usernameParam = params?.username;
  const viewingOwnProfile =
    !usernameParam ||
    (profile?.username && usernameParam?.toLowerCase() === profile.username?.toLowerCase());
  const queryPanel = useMemo(() => {
    const query = new URLSearchParams(location.search);
    return query.get('panel');
  }, [location.search]);

  const [profileData, setProfileData] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isFallback, setIsFallback] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [formState, setFormState] = useState({
    displayName: '',
    bio: '',
    location: '',
    website: '',
    pronouns: '',
  });
  const [preferencesForm, setPreferencesForm] = useState(DEFAULT_PREFERENCES);
  const [badgeShowcase, setBadgeShowcase] = useState([]);
  const [emailForm, setEmailForm] = useState(session?.user?.email ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [bannerUploading, setBannerUploading] = useState(false);
  const avatarInputRef = useRef(null);
  const bannerInputRef = useRef(null);

  const handleRequestSignIn = useCallback(() => {
    if (typeof triggerTransition === 'function' && typeof onSignInClick === 'function') {
      triggerTransition(() => onSignInClick());
    } else if (typeof onSignInClick === 'function') {
      onSignInClick();
    }
  }, [triggerTransition, onSignInClick]);

  useEffect(() => {
    let cancelled = false;
    const loadProfile = async () => {
      setLoading(true);
      setError(null);
      setIsFallback(false);

      try {
        if (!usernameParam && !session?.user?.id) {
          throw new Error('Sign in required');
        }

        let query = supabase.from('profiles').select(PROFILE_SELECT);

        if (usernameParam) {
          query = query.eq('username', usernameParam.toLowerCase()).maybeSingle();
        } else {
          query = query.eq('id', session.user.id).maybeSingle();
        }

        const { data, error: profileError } = await query;

        if (profileError) {
          if (['42P01', '42703'].includes(profileError.code)) {
            const fallback = viewingOwnProfile
              ? { ...(profile ?? {}), ...(FALLBACK_PROFILE(profile?.username)) }
              : FALLBACK_PROFILE(usernameParam);
            if (!cancelled) {
              setProfileData(fallback);
              setIsFallback(true);
            }
            return;
          }
          throw profileError;
        }

        if (!data) {
          if (viewingOwnProfile) {
            const fallbackProfile = {
              ...(profile ?? {}),
              ...(FALLBACK_PROFILE(profile?.username)),
              id: session.user.id,
            };

            const { data: createdProfile, error: createError } = await supabase
              .from('profiles')
              .upsert(
                {
                  id: fallbackProfile.id,
                  username: fallbackProfile.username,
                  display_name: fallbackProfile.display_name,
                  avatar_url: fallbackProfile.avatar_url,
                  banner_url: fallbackProfile.banner_url,
                  bio: fallbackProfile.bio,
                  location: fallbackProfile.location,
                  website: fallbackProfile.website,
                  pronouns: fallbackProfile.pronouns,
                  xp: fallbackProfile.xp,
                  badges: fallbackProfile.badges,
                  reputation: fallbackProfile.reputation,
                  preferences: fallbackProfile.preferences,
                  badge_showcase_order: fallbackProfile.badge_showcase_order,
                },
                { onConflict: 'id' }
              )
              .select('*')
              .single();

            if (!cancelled) {
              if (createError) {
                console.error('Profile auto-create error', createError);
                setProfileData(fallbackProfile);
                setIsFallback(true);
              } else {
                setProfileData({
                  ...createdProfile,
                  badges: resolveBadges(createdProfile.badges),
                  preferences: {
                    ...DEFAULT_PREFERENCES,
                    ...(createdProfile.preferences ?? {}),
                  },
                });
              }
            }
            return;
          }

          const fallback = FALLBACK_PROFILE(usernameParam);
          if (!cancelled) {
            setProfileData(fallback);
            setIsFallback(true);
          }
          return;
        }

        if (!cancelled) {
          setProfileData({
            ...data,
            badges: resolveBadges(data.badges),
            preferences: { ...DEFAULT_PREFERENCES, ...(data.preferences ?? {}) },
          });
        }
      } catch (err) {
        console.error('Profile load error', err);
        if (!cancelled) {
          setError(err.message ?? 'Unable to load profile.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadProfile();

    return () => {
      cancelled = true;
    };
  }, [usernameParam, session?.user?.id, profile, viewingOwnProfile]);

  useEffect(() => {
    if (!profileData) return;
    setFormState({
      displayName: profileData.display_name ?? '',
      bio: profileData.bio ?? '',
      location: profileData.location ?? '',
      website: profileData.website ?? '',
      pronouns: profileData.pronouns ?? '',
    });
    setPreferencesForm({
      ...DEFAULT_PREFERENCES,
      ...(profileData.preferences ?? {}),
    });
    setEmailForm(session?.user?.email ?? '');
    const badgeSlugs = (profileData.badges ?? []).map((badge) => badge.slug).filter(Boolean);
    const savedOrder = Array.isArray(profileData.badge_showcase_order)
      ? profileData.badge_showcase_order.filter((slug) => badgeSlugs.includes(slug))
      : [];
    const fallbackOrder = badgeSlugs.filter((slug) => !savedOrder.includes(slug));
    setBadgeShowcase([...savedOrder, ...fallbackOrder].slice(0, 3));
  }, [profileData, session?.user?.email]);

  useEffect(() => {
    if (viewingOwnProfile && queryPanel === 'settings') {
      setEditMode(true);
    }
  }, [queryPanel, viewingOwnProfile]);

  useEffect(() => {
    let cancelled = false;
    const loadActivity = async () => {
      if (!profileData?.id || isFallback) {
        setActivity([]);
        return;
      }

      setActivityLoading(true);
      try {
        const { data, error: activityError } = await supabase
          .from('mission_posts')
          .select(ACTIVITY_SELECT)
          .eq('created_by', profileData.id)
          .order('created_at', { ascending: false })
          .limit(12);

        if (activityError) {
          if (activityError.code === '42P01') {
            setIsFallback(true);
            setActivity([]);
            return;
          }
          throw activityError;
        }

        if (!cancelled) {
          setActivity(data ?? []);
        }
      } catch (err) {
        console.error('Activity load error', err);
        if (!cancelled) {
          setActivity([]);
        }
      } finally {
        if (!cancelled) {
          setActivityLoading(false);
        }
      }
    };

    loadActivity();

    return () => {
      cancelled = true;
    };
  }, [profileData?.id, isFallback]);

  const xpSummary = useMemo(() => xpLevelFromTotal(profileData?.xp ?? 0), [profileData?.xp]);

  const joinedDate = useMemo(() => {
    if (!profileData?.created_at) return null;
    try {
      return new Date(profileData.created_at);
    } catch {
      return null;
    }
  }, [profileData?.created_at]);

  const featuredBadges = useMemo(() => {
    if (!profileData?.badges || badgeShowcase.length === 0) return [];
    return badgeShowcase
      .map((slug) => profileData.badges.find((badge) => badge.slug === slug))
      .filter(Boolean);
  }, [profileData?.badges, badgeShowcase]);

  const normalizeWebsite = (value) => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  };

  const handleFormChange = (event) => {
    const { name, value } = event.target;
    setFormState((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleToggleBadgeSpotlight = (slug) => {
    if (!viewingOwnProfile) return;
    setBadgeShowcase((prev) => {
      if (prev.includes(slug)) {
        return prev.filter((item) => item !== slug);
      }
      const next = [...prev, slug];
      if (next.length > 3) {
        next.shift();
      }
      return next;
    });
  };

  const handleSaveProfile = async () => {
    if (!viewingOwnProfile) {
      toast.error('You can only edit your own profile.');
      return;
    }
    if (isFallback) {
      toast.error('Profile editing is unavailable while using fallback data.');
      return;
    }
    if (!profileData?.id) return;

    setSavingProfile(true);

    const updates = {
      display_name: formState.displayName.trim() || null,
      bio: formState.bio.trim() || null,
      location: formState.location.trim() || null,
      pronouns: formState.pronouns.trim() || null,
      website: normalizeWebsite(formState.website),
      badge_showcase_order: badgeShowcase,
    };

    try {
      const { error: updateError } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', profileData.id);

      if (updateError) throw updateError;

      setProfileData((prev) =>
        prev
          ? {
              ...prev,
              ...updates,
            }
          : prev,
      );
      toast.success('Profile updated.');
      setEditMode(false);
    } catch (err) {
      console.error('Profile update error', err);
      toast.error(err.message ?? 'Failed to update profile.');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSavePreferences = async () => {
    if (!viewingOwnProfile) {
      toast.error('You can only edit your own preferences.');
      return;
    }
    if (isFallback) {
      toast.error('Preferences are unavailable while using fallback data.');
      return;
    }
    if (!profileData?.id) return;

    setSavingPreferences(true);
    try {
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ preferences: preferencesForm })
        .eq('id', profileData.id);

      if (updateError) throw updateError;

      setProfileData((prev) =>
        prev
          ? {
              ...prev,
              preferences: preferencesForm,
            }
          : prev,
      );
      toast.success('Preferences saved.');
    } catch (err) {
      console.error('Preferences update error', err);
      toast.error(err.message ?? 'Failed to save preferences.');
    } finally {
      setSavingPreferences(false);
    }
  };

  const handleEmailUpdate = async (event) => {
    event.preventDefault();
    if (!session?.user) {
      handleRequestSignIn();
      return;
    }
    const nextEmail = emailForm.trim();
    if (!nextEmail) {
      toast.error('Email cannot be empty.');
      return;
    }
    if (nextEmail === session.user.email) {
      toast('Email is unchanged.');
      return;
    }
    setSavingEmail(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ email: nextEmail });
      if (updateError) throw updateError;
      toast.success('Verification sent to your new email. Please confirm to complete the change.');
    } catch (err) {
      console.error('Email update error', err);
      toast.error(err.message ?? 'Failed to update email.');
    } finally {
      setSavingEmail(false);
    }
  };

  const uploadImage = async (file, folder) => {
    if (!file || !profileData?.id) return null;
    const extension = file.name.split('.').pop();
    const filePath = `${folder}/${profileData.id}-${Date.now()}.${extension}`;
    const storage = supabase.storage.from(STORAGE_BUCKET);

    const { error: uploadError } = await storage.upload(filePath, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type,
    });

    if (uploadError) throw uploadError;

    const { data } = storage.getPublicUrl(filePath);
    return data?.publicUrl ?? null;
  };

  const handleAvatarUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!viewingOwnProfile) {
      toast.error('You can only update your own avatar.');
      return;
    }
    if (isFallback) {
      toast.error('Avatar uploads are disabled while using fallback data.');
      return;
    }
    setAvatarUploading(true);
    try {
      const publicUrl = await uploadImage(file, 'avatars');
      if (!publicUrl) throw new Error('Unable to generate avatar URL.');
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: publicUrl })
        .eq('id', profileData.id);
      if (updateError) throw updateError;
      setProfileData((prev) =>
        prev
          ? {
              ...prev,
              avatar_url: publicUrl,
            }
          : prev,
      );
      toast.success('Avatar updated.');
    } catch (err) {
      console.error('Avatar upload error', err);
      toast.error(err.message ?? 'Failed to upload avatar.');
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) {
        avatarInputRef.current.value = '';
      }
    }
  };

  const handleBannerUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!viewingOwnProfile) {
      toast.error('You can only update your own banner.');
      return;
    }
    if (isFallback) {
      toast.error('Banner uploads are disabled while using fallback data.');
      return;
    }
    setBannerUploading(true);
    try {
      const publicUrl = await uploadImage(file, 'banners');
      if (!publicUrl) throw new Error('Unable to generate banner URL.');
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ banner_url: publicUrl })
        .eq('id', profileData.id);
      if (updateError) throw updateError;
      setProfileData((prev) =>
        prev
          ? {
              ...prev,
              banner_url: publicUrl,
            }
          : prev,
      );
      toast.success('Banner updated.');
    } catch (err) {
      console.error('Banner upload error', err);
      toast.error(err.message ?? 'Failed to upload banner.');
    } finally {
      setBannerUploading(false);
      if (bannerInputRef.current) {
        bannerInputRef.current.value = '';
      }
    }
  };

  const handlePreferenceToggle = (key) => {
    setPreferencesForm((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  if (!usernameParam && !session && !loading) {
    return (
      <div className="min-h-screen bg-cyber-black text-white flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="max-w-md w-full rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-md text-center space-y-6"
        >
          <Shield className="mx-auto h-12 w-12 text-cyber-blue" />
          <div>
            <h1 className="font-orbitron text-2xl font-bold tracking-[0.3em] uppercase">Operative Access</h1>
            <p className="mt-3 font-exo text-sm text-gray-400">
              Sign in to view your ClawNet profile, badges, and mission progress.
            </p>
          </div>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.96 }}
            onClick={handleRequestSignIn}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyber-blue/60 bg-cyber-blue/20 px-5 py-2.5 font-orbitron text-xs uppercase tracking-[0.35em] text-cyber-blue transition-all hover:bg-cyber-blue/30 hover:text-white"
          >
            Sign In
          </motion.button>
        </motion.div>
      </div>
    );
  }

  const disableEdits = !viewingOwnProfile || isFallback;
  const preferencesDisabledMessage = !viewingOwnProfile
    ? 'Preferences can only be changed from your own profile.'
    : isFallback
    ? 'Preferences are read-only until Supabase migration completes.'
    : null;

  return (
    <div className="min-h-screen bg-cyber-black text-white pt-24 pb-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400 transition-colors hover:border-cyber-blue/60 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
          {viewingOwnProfile && (
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => navigate('/missions')}
              className="inline-flex items-center gap-2 rounded-lg border border-cyber-blue/50 bg-cyber-blue/10 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.35em] text-cyber-blue transition-all hover:bg-cyber-blue/20 hover:text-white"
            >
              <Target className="h-4 w-4" />
              New Mission
            </motion.button>
          )}
        </div>

        {loading ? (
          <div className="rounded-3xl border border-white/10 bg-white/5 p-12 text-center">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.8, ease: 'linear' }}
              className="mx-auto mb-6 h-16 w-16 rounded-full border border-cyber-blue/30 border-t-transparent"
            />
            <p className="font-exo text-sm uppercase tracking-[0.4em] text-gray-400">
              Initializing profile node…
            </p>
          </div>
        ) : error ? (
          <div className="rounded-3xl border border-red-500/40 bg-red-500/10 p-12 text-center">
            <h2 className="font-orbitron text-lg uppercase tracking-[0.35em] text-red-300">
              Profile Unavailable
            </h2>
            <p className="mt-3 font-exo text-sm text-red-200/80">{error}</p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="mt-6 inline-flex items-center gap-2 rounded-lg border border-red-500/40 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.3em] text-red-200 transition-colors hover:border-red-300 hover:text-white"
            >
              Return Home
            </button>
          </div>
        ) : (
          profileData && (
            <div className="space-y-10">
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/40"
              >
                <div className="absolute inset-0 opacity-60">
                  {profileData.banner_url ? (
                    <img
                      src={profileData.banner_url}
                      alt="Profile banner"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="h-full w-full bg-gradient-to-br from-cyber-blue/40 via-cyber-purple/30 to-transparent" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-br from-black/70 via-black/60 to-black/40" />
                </div>
                <div className="relative flex flex-col gap-8 p-6 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-6">
                    <div className="relative h-28 w-28 flex-shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-black/40">
                      {profileData.avatar_url ? (
                        <img
                          src={profileData.avatar_url}
                          alt={profileData.display_name ?? profileData.username}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-cyber-blue/40 to-cyber-purple/40">
                          <span className="font-orbitron text-3xl text-white">
                            {(profileData.display_name ?? profileData.username ?? '?')
                              .slice(0, 1)
                              .toUpperCase()}
                          </span>
                        </div>
                      )}
                      <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-cyber-cyan/40 bg-cyber-cyan/20 px-3 py-1 text-[10px] font-orbitron uppercase tracking-[0.35em] text-cyber-cyan">
                        Level {xpSummary.level}
                      </div>
                      {viewingOwnProfile && (
                        <>
                          <input
                            ref={avatarInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handleAvatarUpload}
                          />
                          <button
                            type="button"
                            onClick={() => avatarInputRef.current?.click()}
                            className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[10px] font-orbitron uppercase tracking-[0.3em] text-gray-200 hover:bg-black/80 transition"
                            disabled={avatarUploading}
                          >
                            <UploadCloud className="h-3 w-3" />
                            {avatarUploading ? 'Uploading…' : 'Avatar'}
                          </button>
                        </>
                      )}
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-3">
                        <h1 className="font-orbitron text-3xl sm:text-4xl font-black tracking-wider">
                          {profileData.display_name ?? profileData.username}
                        </h1>
                        {profileData.pronouns && (
                          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-exo uppercase tracking-[0.3em] text-gray-400">
                            {profileData.pronouns}
                          </span>
                        )}
                      </div>
                      <p className="mt-2 font-exo text-sm text-gray-400">@{profileData.username}</p>
                      {profileData.bio && (
                        <p className="mt-4 max-w-xl font-exo text-sm leading-relaxed text-gray-300">
                          {profileData.bio}
                        </p>
                      )}
                      <div className="mt-4 flex flex-wrap gap-4 text-xs font-exo text-gray-400">
                        {profileData.location && (
                          <span className="inline-flex items-center gap-2">
                            <MapPin className="h-3.5 w-3.5 text-cyber-cyan" />
                            {profileData.location}
                          </span>
                        )}
                        {joinedDate && (
                          <span className="inline-flex items-center gap-2">
                            <Calendar className="h-3.5 w-3.5 text-cyber-cyan" />
                            Joined{' '}
                            {joinedDate.toLocaleDateString(undefined, {
                              month: 'short',
                              year: 'numeric',
                            })}
                          </span>
                        )}
                        {profileData.website && (
                          <a
                            href={profileData.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 text-cyber-blue hover:text-cyber-cyan transition-colors"
                          >
                            <LinkIcon className="h-3.5 w-3.5" />
                            {profileData.website.replace(/^https?:\/\//, '')}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-full sm:w-72">
                      <div className="flex items-center justify-between text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                        <span>XP Progress</span>
                        <span>{profileData.xp ?? 0} XP</span>
                      </div>
                      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${xpSummary.progress * 100}%` }}
                          transition={{ duration: 0.6 }}
                          className="h-full rounded-full bg-gradient-to-r from-cyber-blue to-cyber-cyan"
                        />
                      </div>
                      <p className="mt-2 text-right text-[10px] font-exo uppercase tracking-[0.3em] text-gray-500">
                        Next level at {xpSummary.nextLevel} XP
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <RewardToken type="xp" value={`${profileData.xp ?? 0}`} label="Total XP" accentColor="#00E0FF" />
                      <RewardToken type="badge" value={`${profileData.badges?.length ?? 0}`} label="Badges" accentColor="#FF6B6B" />
                      <RewardToken type="bonus" value={`${profileData.reputation ?? 0}`} label="Reputation" accentColor="#7C3AED" />
                    </div>
                    {viewingOwnProfile && (
                      <div className="flex flex-wrap justify-center gap-2 text-[10px] font-orbitron uppercase tracking-[0.3em] text-gray-400">
                        <button
                          type="button"
                          onClick={() => setEditMode((prev) => !prev)}
                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-1.5 hover:border-cyber-blue/50 hover:text-white transition"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          {editMode ? 'Cancel' : 'Edit Profile'}
                        </button>
                        <button
                          type="button"
                          onClick={() => bannerInputRef.current?.click()}
                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-1.5 hover:border-cyber-purple/50 hover:text-white transition"
                          disabled={bannerUploading}
                        >
                          <ImageIcon className="h-3.5 w-3.5" />
                          {bannerUploading ? 'Uploading…' : 'Update Banner'}
                        </button>
                        <input
                          ref={bannerInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleBannerUpload}
                        />
                      </div>
                    )}
                  </div>
                </div>
                {featuredBadges.length > 0 && (
                  <div className="relative z-10 border-t border-white/10 bg-black/40 px-6 pb-6 sm:px-10 sm:pb-10">
                    <div className="mt-6 grid gap-4 sm:grid-cols-2">
                      {featuredBadges.map((badge) => {
                        const accent = badge.accent ?? BADGE_LIBRARY[badge.slug ?? '']?.accent ?? '#0EA5E9';
                        return (
                          <div
                            key={`spotlight-${badge.slug}`}
                            className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-black/70 via-black/60 to-black/30 p-5"
                            style={{ boxShadow: `0 0 40px ${accent}22` }}
                          >
                            <div className="absolute inset-0 pointer-events-none bg-gradient-to-br from-white/5 to-transparent" />
                            <div className="relative flex items-center gap-4">
                              <div
                                className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-black/60"
                                style={{ boxShadow: `0 0 24px ${accent}33` }}
                              >
                                <Award className="h-6 w-6" style={{ color: accent }} />
                              </div>
                              <div>
                                <p className="font-orbitron text-xs uppercase tracking-[0.4em] text-gray-400">Spotlight</p>
                                <h3 className="font-orbitron text-base uppercase tracking-[0.3em] text-white">
                                  {badge.title ?? badge.slug}
                                </h3>
                                {badge.description && (
                                  <p className="mt-1 font-exo text-xs text-gray-400">{badge.description}</p>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.05 }}
                className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-8"
              >
                <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-orbitron text-2xl font-semibold uppercase tracking-[0.35em]">
                      Badge Case
                    </h2>
                    <p className="mt-2 font-exo text-sm text-gray-400">
                      Track your mission accolades and community honors.
                    </p>
                  </div>
                  {viewingOwnProfile && (
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => navigate('/missions')}
                      className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-300 transition-all hover:border-cyber-blue/50 hover:text-white"
                    >
                      <Sparkles className="h-4 w-4 text-cyber-cyan" />
                      Earn More
                    </motion.button>
                  )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {(profileData.badges?.length ?? 0) > 0 ? (
                    profileData.badges.map((badge) => {
                      const accent = badge.accent ?? BADGE_LIBRARY[badge.slug ?? '']?.accent ?? '#00E0FF';
                      const isFeatured = badgeShowcase.includes(badge.slug);
                      return (
                        <div
                          key={badge.slug ?? badge.title}
                          className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-5"
                        >
                          <div
                            className="absolute inset-0 opacity-0 transition-opacity duration-300 hover:opacity-100"
                            style={{
                              background: `radial-gradient(circle at top left, ${accent}33 0%, transparent 70%)`,
                            }}
                          />
                          <div className="relative flex items-center gap-4">
                            <div
                              className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-black/40"
                              style={{ boxShadow: `0 0 24px ${accent}22` }}
                            >
                              <Medal className="h-6 w-6" style={{ color: accent }} />
                            </div>
                            <div>
                              <h3 className="font-orbitron text-sm uppercase tracking-[0.3em]">
                                {badge.title ?? badge.slug ?? 'Badge'}
                              </h3>
                              {badge.description && (
                                <p className="mt-1 text-xs font-exo text-gray-400">{badge.description}</p>
                              )}
                              {badge.earned_at && (
                                <p className="mt-2 text-[10px] font-exo uppercase tracking-[0.3em] text-gray-500">
                                  Earned {new Date(badge.earned_at).toLocaleDateString()}
                                </p>
                              )}
                            </div>
                          </div>
                          {viewingOwnProfile && (
                            <button
                              type="button"
                              onClick={() => handleToggleBadgeSpotlight(badge.slug)}
                              className={`absolute top-4 right-4 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/50 transition ${
                                isFeatured ? 'text-amber-300' : 'text-gray-400 hover:text-white'
                              }`}
                            >
                              <Star
                                className="h-4 w-4"
                                fill={isFeatured ? '#FCD34D' : 'transparent'}
                                strokeWidth={isFeatured ? 1 : 1.5}
                              />
                            </button>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-2xl border border-dashed border-white/20 bg-white/5 p-6 text-center sm:col-span-2 lg:col-span-3">
                      <p className="font-exo text-sm text-gray-400">
                        No badges yet. Complete missions to start filling your badge case.
                      </p>
                    </div>
                  )}
                </div>
              </motion.section>

              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.1 }}
                className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-8"
              >
                <div className="mb-6 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-orbitron text-2xl font-semibold uppercase tracking-[0.35em]">
                      Mission Feed
                    </h2>
                    <p className="mt-2 font-exo text-sm text-gray-400">
                      Your latest drops across ClawNet missions and threads.
                    </p>
                  </div>
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => navigate('/hub')}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-300 transition-all hover:border-cyber-blue/50 hover:text-white"
                  >
                    <Activity className="h-4 w-4 text-cyber-cyan" />
                    Open Hub
                  </motion.button>
                </div>

                {activityLoading ? (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
                    <motion.div
                      animate={{ opacity: [0.2, 1, 0.2] }}
                      transition={{ repeat: Infinity, duration: 1.2 }}
                      className="mx-auto mb-4 h-10 w-10 rounded-full border border-cyber-blue/30 border-t-transparent"
                    />
                    <p className="font-exo text-xs uppercase tracking-[0.4em] text-gray-500">
                      Syncing activity…
                    </p>
                  </div>
                ) : activity.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/20 bg-white/5 p-6 text-center">
                    <p className="font-exo text-sm text-gray-400">
                      No mission posts yet. Engage with a mission thread to populate your feed.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {activity.map((entry) => {
                      const mission = entry.mission_threads?.mission;
                      return (
                        <div
                          key={entry.id}
                          className="rounded-2xl border border-white/10 bg-black/40 p-5 sm:p-6"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="font-orbitron text-xs uppercase tracking-[0.3em] text-gray-500">
                                {mission?.band ?? 'Mission Thread'}
                              </p>
                              <h3 className="mt-1 font-orbitron text-base tracking-[0.15em] text-white">
                                {mission?.title ?? 'Thread Activity'}
                              </h3>
                            </div>
                            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-orbitron uppercase tracking-[0.35em] text-gray-400">
                              <Zap className="h-3.5 w-3.5 text-cyber-cyan" />
                              {new Date(entry.created_at).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                              })}
                            </div>
                          </div>
                          <div className="mt-4 rounded-xl border border-white/5 bg-black/60 p-4">
                            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-200">
                              {entry.body}
                            </pre>
                          </div>
                          {mission?.slug && (
                            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                              <div className="flex items-center gap-2 text-[10px] font-orbitron uppercase tracking-[0.35em] text-gray-500">
                                <Shield className="h-3.5 w-3.5 text-cyber-blue" />
                                {mission.difficulty}
                              </div>
                              <button
                                type="button"
                                onClick={() => navigate(`/hub/mission/${mission.slug}`)}
                                className="inline-flex items-center gap-2 rounded-lg border border-cyber-blue/40 px-3 py-1.5 text-[10px] font-orbitron uppercase tracking-[0.3em] text-cyber-blue hover:bg-cyber-blue/10"
                              >
                                View Thread
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.section>

              {viewingOwnProfile && (
                <motion.section
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: 0.12 }}
                  className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
                >
                  <div className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-8">
                    <div className="mb-6 flex items-center justify-between gap-3">
                      <div>
                        <h2 className="font-orbitron text-2xl font-semibold uppercase tracking-[0.35em]">
                          Operative Profile
                        </h2>
                        <p className="mt-2 font-exo text-sm text-gray-400">
                          Update your public identity across ClawNet.
                        </p>
                      </div>
                      <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-[10px] font-orbitron uppercase tracking-[0.3em] text-gray-400">
                        <UserCog className="h-3.5 w-3.5 text-cyber-cyan" />
                        {editMode ? 'Editing' : 'Preview'}
                      </div>
                    </div>
                    {isFallback && (
                      <div className="mb-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs font-exo text-amber-100/90">
                        Fallback profile active. Changes will not persist until Supabase migrations are applied.
                      </div>
                    )}
                    <div className="space-y-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="flex flex-col gap-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                          Display Name
                          <input
                            type="text"
                            name="displayName"
                            value={formState.displayName}
                            onChange={handleFormChange}
                            readOnly={!editMode || disableEdits}
                            className={`w-full rounded-lg border bg-black/40 px-4 py-3 font-exo text-sm text-white transition focus:outline-none focus:ring-2 focus:ring-cyber-blue/60 ${
                              !editMode || disableEdits
                                ? 'border-white/10 text-gray-400 cursor-not-allowed'
                                : 'border-white/10 hover:border-cyber-blue/40'
                            }`}
                            placeholder="ClawNet Operative"
                          />
                        </label>
                        <label className="flex flex-col gap-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                          Pronouns
                          <input
                            type="text"
                            name="pronouns"
                            value={formState.pronouns}
                            onChange={handleFormChange}
                            readOnly={!editMode || disableEdits}
                            className={`w-full rounded-lg border bg-black/40 px-4 py-3 font-exo text-sm text-white transition focus:outline-none focus:ring-2 focus:ring-cyber-blue/60 ${
                              !editMode || disableEdits
                                ? 'border-white/10 text-gray-400 cursor-not-allowed'
                                : 'border-white/10 hover:border-cyber-blue/40'
                            }`}
                            placeholder="They/Them"
                          />
                        </label>
                      </div>
                      <label className="flex flex-col gap-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                        Bio
                        <textarea
                          name="bio"
                          value={formState.bio}
                          onChange={handleFormChange}
                          readOnly={!editMode || disableEdits}
                          rows={4}
                          className={`w-full rounded-lg border bg-black/40 px-4 py-3 font-exo text-sm text-white transition focus:outline-none focus:ring-2 focus:ring-cyber-blue/60 ${
                            !editMode || disableEdits
                              ? 'border-white/10 text-gray-400 cursor-not-allowed'
                              : 'border-white/10 hover:border-cyber-blue/40'
                          }`}
                          placeholder="Tell the network about your specialties."
                        />
                      </label>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="flex flex-col gap-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                          Location
                          <input
                            type="text"
                            name="location"
                            value={formState.location}
                            onChange={handleFormChange}
                            readOnly={!editMode || disableEdits}
                            className={`w-full rounded-lg border bg-black/40 px-4 py-3 font-exo text-sm text-white transition focus:outline-none focus:ring-2 focus:ring-cyber-blue/60 ${
                              !editMode || disableEdits
                                ? 'border-white/10 text-gray-400 cursor-not-allowed'
                                : 'border-white/10 hover:border-cyber-blue/40'
                            }`}
                            placeholder="Unknown Grid Node"
                          />
                        </label>
                        <label className="flex flex-col gap-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                          Website
                          <input
                            type="text"
                            name="website"
                            value={formState.website}
                            onChange={handleFormChange}
                            readOnly={!editMode || disableEdits}
                            className={`w-full rounded-lg border bg-black/40 px-4 py-3 font-exo text-sm text-white transition focus:outline-none focus:ring-2 focus:ring-cyber-blue/60 ${
                              !editMode || disableEdits
                                ? 'border-white/10 text-gray-400 cursor-not-allowed'
                                : 'border-white/10 hover:border-cyber-blue/40'
                            }`}
                            placeholder="clawnet.network"
                          />
                        </label>
                      </div>
                    </div>
                    {editMode && (
                      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-xs font-exo text-gray-400">
                          Tip: Website links are normalised with HTTPS. Badge spotlight remembers your top three picks.
                        </p>
                        <motion.button
                          whileHover={{ scale: 1.03 }}
                          whileTap={{ scale: 0.97 }}
                          onClick={handleSaveProfile}
                          disabled={savingProfile || disableEdits}
                          className="inline-flex items-center gap-2 rounded-lg border border-cyber-blue/40 bg-cyber-blue/10 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.35em] text-cyber-blue transition-all hover:bg-cyber-blue/20 hover:text-white disabled:cursor-not-allowed disabled:border-white/10 disabled:text-gray-400"
                        >
                          <Save className="h-4 w-4" />
                          {savingProfile ? 'Saving…' : 'Save Profile'}
                        </motion.button>
                      </div>
                    )}
                  </div>
                  <div className="space-y-6">
                    <div className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-8">
                      <div className="mb-5 flex items-center justify-between gap-3">
                        <div>
                          <h3 className="font-orbitron text-lg uppercase tracking-[0.3em]">Preferences</h3>
                          <p className="mt-1 font-exo text-xs text-gray-400">
                            Tailor your notifications and visibility.
                          </p>
                        </div>
                        <Settings2 className="h-5 w-5 text-cyber-cyan" />
                      </div>
                      {preferencesDisabledMessage && (
                        <div className="mb-4 rounded-2xl border border-white/10 bg-black/40 p-4 text-xs font-exo text-gray-300">
                          {preferencesDisabledMessage}
                        </div>
                      )}
                      <div className="space-y-4">
                        {[
                          {
                            key: 'missionAlerts',
                            label: 'Mission Alerts',
                            description: 'Receive push and email alerts when new missions go live.',
                            icon: Target,
                          },
                          {
                            key: 'weeklyDigest',
                            label: 'Weekly Digest',
                            description: 'Get a curated recap of mission progress every Monday.',
                            icon: Bell,
                          },
                          {
                            key: 'emailUpdates',
                            label: 'Critical Updates',
                            description: 'Stay informed about security advisories and claw-wide notices.',
                            icon: Mail,
                          },
                          {
                            key: 'showcasePublic',
                            label: 'Public Showcase',
                            description: 'Allow other operatives to view your badge spotlight.',
                            icon: Eye,
                          },
                          {
                            key: 'darkInterface',
                            label: 'Dark Interface',
                            description: 'Prioritise the cyber-night interface on supported devices.',
                            icon: Globe,
                          },
                        ].map(({ key, label, description, icon: Icon }) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => handlePreferenceToggle(key)}
                            disabled={disableEdits}
                            className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                              preferencesForm[key]
                                ? 'border-cyber-blue/50 bg-cyber-blue/10'
                                : 'border-white/10 bg-black/40 hover:border-cyber-blue/40'
                            } ${disableEdits ? 'cursor-not-allowed opacity-60' : ''}`}
                          >
                            <div>
                              <div className="flex items-center gap-2">
                                <Icon className="h-4 w-4 text-cyber-cyan" />
                                <p className="font-orbitron text-xs uppercase tracking-[0.3em] text-gray-200">
                                  {label}
                                </p>
                              </div>
                              <p className="mt-1 font-exo text-xs text-gray-400">{description}</p>
                            </div>
                            <motion.span
                              animate={{ backgroundColor: preferencesForm[key] ? '#22d3ee55' : '#ffffff10' }}
                              className={`relative flex h-6 w-11 items-center rounded-full border transition ${
                                preferencesForm[key] ? 'border-cyber-cyan/60' : 'border-white/10'
                              }`}
                            >
                              <motion.span
                                layout
                                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                                className={`absolute h-4 w-4 rounded-full bg-white shadow ${
                                  preferencesForm[key] ? 'right-1' : 'left-1'
                                }`}
                              />
                            </motion.span>
                          </button>
                        ))}
                      </div>
                      <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={handleSavePreferences}
                        disabled={disableEdits || savingPreferences}
                        className="mt-6 inline-flex items-center gap-2 rounded-lg border border-cyber-blue/40 bg-cyber-blue/10 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.3em] text-cyber-blue transition hover:bg-cyber-blue/20 hover:text-white disabled:cursor-not-allowed disabled:border-white/10 disabled:text-gray-400"
                      >
                        <Settings2 className="h-4 w-4" />
                        {savingPreferences ? 'Saving…' : 'Save Preferences'}
                      </motion.button>
                    </div>
                    <div className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-8">
                      <div className="mb-5 flex items-center justify-between gap-3">
                        <div>
                          <h3 className="font-orbitron text-lg uppercase tracking-[0.3em]">
                            Account & Security
                          </h3>
                          <p className="mt-1 font-exo text-xs text-gray-400">
                            Maintain your operative credentials.
                          </p>
                        </div>
                        <Shield className="h-5 w-5 text-cyber-cyan" />
                      </div>
                      <form className="space-y-4" onSubmit={handleEmailUpdate}>
                        <label className="flex flex-col gap-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                          Email Address
                          <input
                            type="email"
                            value={emailForm}
                            onChange={(event) => setEmailForm(event.target.value)}
                            className="w-full rounded-lg border border-white/10 bg-black/40 px-4 py-3 font-exo text-sm text-white transition focus:outline-none focus:ring-2 focus:ring-cyber-blue/60"
                            placeholder="you@clawnet.network"
                          />
                        </label>
                        <p className="text-[11px] font-exo text-gray-500">
                          Updating your email triggers a verification email. The new address becomes active once confirmed.
                        </p>
                        <motion.button
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                          type="submit"
                          disabled={savingEmail}
                          className="inline-flex items-center gap-2 rounded-lg border border-cyber-blue/40 bg-cyber-blue/10 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.3em] text-cyber-blue transition hover:bg-cyber-blue/20 hover:text-white disabled:cursor-not-allowed disabled:border-white/10 disabled:text-gray-400"
                        >
                          <Mail className="h-4 w-4" />
                          {savingEmail ? 'Sending…' : 'Update Email'}
                        </motion.button>
                      </form>
                    </div>
                  </div>
                </motion.section>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
};

export default ProfilePage;

