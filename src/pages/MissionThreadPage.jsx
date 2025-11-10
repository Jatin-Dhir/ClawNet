import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useOutletContext, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../supabaseClient';
import MissionThreadSummary from '../components/mission/MissionThreadSummary';
import MissionPostList from '../components/mission/MissionPostList';
import MissionComposer from '../components/mission/MissionComposer';
import { ArrowLeft } from 'lucide-react';

const fallbackThreads = {
  'grid-challenge-07': {
    id: 'grid-challenge-07',
    mission_id: 'grid-challenge-07',
    title: 'Beacon Hunt • Thread',
    summary:
      'Weekly ops focusing on beacon detection hardening. Share telemetry packs, Sigma rules, and mitigation playbooks.',
    status: 'Live – ends in 6d',
    mission: {
      title: 'Beacon Hunt',
      band: 'Weekly Assignment',
      difficulty: 'Advanced',
      difficulty_color: '#00e0ff',
      accent_glow: '#00e0ff',
      rewards_xp: 400,
      rewards_badge: 'Signal Interceptor',
      rewards_bonus: 'Private red-team drill invite',
    },
    posts: [
      {
        id: 'fallback-post-1',
        body: 'Telemetry pack uploaded to the shared bucket. Beacon rotates ports every 11 minutes – match on entropy spikes rather than static IOC.',
        author_display: 'NullSweep',
        created_at: '2025-11-09T08:12:00Z',
        status: 'visible',
      },
      {
        id: 'fallback-post-2',
        body: 'Correlation rule for Splunk:\n```\nindex=grid\n| stats count by dest_ip, dest_port\n| where count > 20 AND dest_port IN (443,8443)\n```\nConfirming positive hits on two sandbox nodes.',
        author_display: 'DeltaSpectre',
        created_at: '2025-11-09T09:45:00Z',
        status: 'visible',
      },
    ],
    isFallback: true,
    is_locked: false,
  },
  'vault-intrusion': {
    id: 'vault-intrusion',
    mission_id: 'vault-intrusion',
    title: 'Vault Intrusion Ops • Thread',
    summary:
      'Seasonal simulation thread. Coordinate offensive / defensive cells, document Specter token extraction strategies.',
    status: 'Invite only',
    mission: {
      title: 'Vault Intrusion Ops',
      band: 'Seasonal Brief',
      difficulty: 'Expert',
      difficulty_color: '#ff6b6b',
      accent_glow: '#ff6b6b',
      rewards_xp: 600,
      rewards_badge: 'Vault Specter',
      rewards_bonus: 'Access to closed beta tooling',
    },
    posts: [
      {
        id: 'fallback-post-3',
        body: 'Offensive cell Alpha reporting successful lateral chain using patched JuicyPotato exploit. Token located in memory snapshot #14.',
        author_display: 'BinarySynth',
        created_at: '2025-11-08T21:33:00Z',
        status: 'visible',
      },
      {
        id: 'fallback-post-4',
        body: 'Defensive perspective: consider instrumenting LSASS handle audits. We caught Alpha by diffing ETW traces.',
        author_display: 'BlueShift',
        created_at: '2025-11-09T01:12:00Z',
        status: 'visible',
      },
    ],
    isFallback: true,
    is_locked: false,
  },
  'signal-decode-sprint': {
    id: 'signal-decode-sprint',
    mission_id: 'signal-decode-sprint',
    title: 'Signal Decode Sprint • Thread',
    summary:
      'Daily anomaly decoding stand-up. Drop your classifier insights, ML feature tweaks, and remediation snippets.',
    status: 'Resets 24h',
    mission: {
      title: 'Signal Decode Sprint',
      band: 'Daily Run',
      difficulty: 'Intermediate',
      difficulty_color: '#00f5ff',
      accent_glow: '#00f5ff',
      rewards_xp: 250,
      rewards_badge: 'Pattern Decoder',
      rewards_bonus: 'Featured slot in community briefing',
    },
    posts: [
      {
        id: 'fallback-post-5',
        body: 'Latest anomaly bundle flagged DNS over HTTPS pivot. Added feature weighting to highlight anomalous JA3 fingerprints.',
        author_display: 'MatrixPulse',
        created_at: '2025-11-09T06:05:00Z',
        status: 'visible',
      },
    ],
    isFallback: true,
    is_locked: false,
  },
};

const MissionThreadPage = () => {
  const { missionId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const { triggerTransition, onSignInClick } = useOutletContext() || {};
  const [thread, setThread] = useState(null);
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fallback = fallbackThreads[missionId];

    if (fallback) {
      setThread({ ...fallback });
      setPosts(fallback.posts ?? []);
      setError(null);
      setLoading(false);
    } else {
      setLoading(true);
      setThread(null);
      setPosts([]);
    }

    const fetchThread = async () => {
      if (!fallback) {
        setLoading(true);
        setError(null);
      }
      try {
        const { data, error: threadError } = await supabase
          .from('mission_threads')
          .select(
            `
              id,
              mission_id,
              title,
              summary,
              status,
              last_activity_at,
              is_locked,
              mission:missions_featured!inner(
                id,
                slug,
                title,
                band,
                difficulty,
                difficulty_color,
                accent_glow,
                rewards_badge,
                rewards_xp,
                rewards_bonus
              )
            `
          )
          .eq('mission.slug', missionId)
          .maybeSingle();

        if (threadError) throw threadError;
        if (!data) {
          if (!fallback) {
            throw new Error('Mission thread not found.');
          }
          return;
        }

        const { data: postsData, error: postsError } = await supabase
          .from('mission_posts')
          .select(`
            *,
            profiles:created_by (
              id,
              username,
              display_name,
              avatar_url
            )
          `)
          .eq('thread_id', data.id)
          .order('created_at', { ascending: true });

        if (postsError) throw postsError;

        if (!cancelled) {
          setThread({ ...data, isFallback: false });
          setPosts(postsData ?? []);
          setLoading(false);
        }
      } catch (fetchError) {
        if (!cancelled) {
          if (!fallback) {
            setError(fetchError.message || 'Unable to load mission discussion.');
            setLoading(false);
          }
        }
      }
    };

    fetchThread();
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  const handleRequireAuth = () => {
    triggerTransition?.(() => onSignInClick?.());
  };

  const handlePostCreated = (newPost) => {
    setPosts((prev) => [...prev, newPost]);
  };

  const missionMeta = useMemo(() => thread?.mission ?? null, [thread]);
  const composerDisabled = !thread || thread?.is_locked === true;

  return (
    <div className="min-h-screen bg-cyber-black text-white pt-24 pb-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400 transition-colors hover:border-cyber-blue/60 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
        </div>

        {loading && (
          <div className="py-20 text-center text-gray-500 font-exo text-sm uppercase tracking-[0.35em]">
            Loading mission thread…
          </div>
        )}

        {!loading && error && (
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-6 text-center">
            <p className="font-orbitron text-sm uppercase tracking-[0.3em] text-red-300">{error}</p>
            <button
              type="button"
              onClick={() => navigate('/missions')}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-md border border-red-500/40 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.3em] text-red-200 hover:border-red-300 hover:text-red-100 transition-colors"
            >
              View Missions
            </button>
          </div>
        )}

        {!loading && !error && thread && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="space-y-6"
          >
            <MissionThreadSummary thread={thread} />
            <div className="space-y-4">
              <MissionPostList posts={posts} />
              <MissionComposer
                threadId={thread.id}
                session={session}
                onRequireAuth={handleRequireAuth}
                onPostCreated={handlePostCreated}
                accentColor={missionMeta?.accent_glow}
                disabled={composerDisabled}
                disabledMessage={thread?.is_locked ? "This thread is currently locked. Contact an admin to unlock it." : "Thread is not available."}
              />
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default MissionThreadPage;

