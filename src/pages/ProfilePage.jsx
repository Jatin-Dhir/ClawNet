import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
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
  RefreshCw,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../contexts/AuthContext';
import RewardToken from '../components/RewardToken';

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
  const nextLevel = (level) * 500;
  const prevLevel = (level - 1) * 500;
  const progress = Math.min(1, Math.max(0, ((xp ?? 0) - prevLevel) / (nextLevel - prevLevel || 1)));
  return { level, progress, nextLevel };
};

const resolveBadges = (badgePayload) => {
  if (!badgePayload) return [];
  if (Array.isArray(badgePayload)) {
    return badgePayload.map((item) => {
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
    }).filter(Boolean);
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
  const outletContext = typeof useOutletContext === 'function' ? useOutletContext() : {};
  const { triggerTransition, onSignInClick } = outletContext || {};
  const { session, profile } = useAuth();

  const usernameParam = params?.username;
  const viewingOwnProfile = !usernameParam || (profile?.username && usernameParam?.toLowerCase() === profile.username?.toLowerCase());

  const [profileData, setProfileData] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isFallback, setIsFallback] = useState(false);

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

        let query = supabase
          .from('profiles')
          .select(PROFILE_SELECT);

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
          const fallback = viewingOwnProfile
            ? { ...(profile ?? {}), ...(FALLBACK_PROFILE(profile?.username)) }
            : FALLBACK_PROFILE(usernameParam);
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
                className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 via-white/5 to-transparent p-6 sm:p-10 relative overflow-hidden"
              >
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute -top-24 right-0 h-48 w-48 rounded-full bg-cyber-blue/10 blur-3xl" />
                  <div className="absolute -bottom-16 left-8 h-40 w-40 rounded-full bg-cyber-purple/20 blur-3xl" />
                </div>
                <div className="relative flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8">
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
                      <p className="mt-2 font-exo text-sm text-gray-400">
                        @{profileData.username}
                      </p>
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
                            Joined {joinedDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
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
                  </div>
                </div>
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
                                <p className="mt-1 text-xs font-exo text-gray-400">
                                  {badge.description}
                                </p>
                              )}
                              {badge.earned_at && (
                                <p className="mt-2 text-[10px] font-exo uppercase tracking-[0.3em] text-gray-500">
                                  Earned {new Date(badge.earned_at).toLocaleDateString()}
                                </p>
                              )}
                            </div>
                          </div>
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
                              {new Date(entry.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
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
            </div>
          )
        )}
      </div>
    </div>
  );
};

export default ProfilePage;

