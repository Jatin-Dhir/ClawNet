import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useOutletContext } from 'react-router-dom';
import { Compass, Target, ShieldCheck, Trophy, Clock3 } from 'lucide-react';
import toast from 'react-hot-toast';

import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../supabaseClient';
import RewardToken from '../components/RewardToken';

const slotOrder = { seasonal: 0, weekly: 1, daily: 2, quick: 3 };

const ensureArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (error) {
      /* ignore parse error */
    }
    return value ? [value] : [];
  }
  if (typeof value === 'object') {
    return Object.values(value).filter(Boolean);
  }
  return [];
};

const getTimeRemaining = (deadline) => {
  if (!deadline) return null;
  const target = new Date(deadline).getTime();
  if (Number.isNaN(target)) return null;
  const diff = Math.max(target - Date.now(), 0);
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  const seconds = Math.floor((diff / 1000) % 60);
  return { diff, days, hours, minutes, seconds };
};

const pad = (value) => value.toString().padStart(2, '0');

const MissionsPage = () => {
  const { session } = useAuth();
  const { onSignInClick, triggerTransition } = useOutletContext() || {};

  const [missions, setMissions] = useState([]);
  const [missionsLoading, setMissionsLoading] = useState(true);
  const [missionsError, setMissionsError] = useState(null);
  const [selectedMissionId, setSelectedMissionId] = useState(null);
  const [timeRemaining, setTimeRemaining] = useState(null);

  const [submission, setSubmission] = useState({ summary: '', notes: '' });
  const [evidenceFile, setEvidenceFile] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [submittingReport, setSubmittingReport] = useState(false);

  const [leaderboard, setLeaderboard] = useState([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [leaderboardError, setLeaderboardError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const fetchMissions = async () => {
      setMissionsLoading(true);
      try {
        const { data, error } = await supabase
          .from('missions_featured')
          .select(`
            id,
            slug,
            slot_type,
            slot_position,
            title,
            band,
            category,
            difficulty,
            difficulty_color,
            status,
            deadline,
            summary,
            objectives,
            requirements,
            hints,
            rewards_xp,
            rewards_badge,
            rewards_bonus,
            mission_threads ( id, title, is_locked )
          `)
          .order('slot_type', { ascending: true })
          .order('slot_position', { ascending: true });

        if (error) throw error;

        const normalized = (data ?? []).map((mission) => {
          const threads = Array.isArray(mission.mission_threads) ? mission.mission_threads : [];
          const primaryThread = threads[0] ?? null;
          const rewards = {
            xp: mission.rewards_xp ?? 0,
            badge: mission.rewards_badge ?? 'TBA',
            extras: mission.rewards_bonus ?? 'TBA',
          };
          const tagCandidates = [mission.category, mission.band, mission.slot_type];
          const tags = Array.from(new Set(tagCandidates.filter(Boolean))).map((tag) =>
            typeof tag === 'string' ? tag : String(tag)
          );

          return {
            id: mission.id,
            slug: mission.slug,
            slotType: mission.slot_type,
            slotPosition: mission.slot_position ?? 0,
            title: mission.title,
            band: mission.band ?? 'Operation',
            category: mission.category ?? 'Mission',
            difficulty: mission.difficulty ?? 'Unrated',
            difficultyColor: mission.difficulty_color ?? '#00e0ff',
            status: mission.status ?? 'Live',
            deadline: mission.deadline,
            summary: mission.summary ?? 'No summary available yet.',
            objectives: ensureArray(mission.objectives),
            requirements: ensureArray(mission.requirements),
            hints: ensureArray(mission.hints),
            rewards,
            tags,
            threadId: primaryThread?.id ?? null,
            threadLocked: primaryThread?.is_locked ?? false,
            threadTitle: primaryThread?.title ?? null,
          };
        });

        normalized.sort((a, b) => {
          const slotDiff = (slotOrder[a.slotType] ?? 99) - (slotOrder[b.slotType] ?? 99);
          if (slotDiff !== 0) return slotDiff;
          return a.slotPosition - b.slotPosition;
        });

        if (!cancelled) {
          setMissions(normalized);
          setMissionsError(null);
          if (normalized.length > 0) {
            setSelectedMissionId((prev) => prev ?? normalized[0].slug);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setMissionsError(error.message ?? 'Unable to load missions.');
          setMissions([]);
        }
      } finally {
        if (!cancelled) {
          setMissionsLoading(false);
        }
      }
    };

    fetchMissions();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchLeaderboard = async () => {
      setLeaderboardLoading(true);
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, username, display_name, xp, badges, reputation')
          .order('xp', { ascending: false })
          .limit(3);

        if (error) throw error;
        if (!cancelled) {
          setLeaderboard(data ?? []);
          setLeaderboardError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setLeaderboardError(error.message ?? 'Unable to load leaderboard.');
          setLeaderboard([]);
        }
      } finally {
        if (!cancelled) {
          setLeaderboardLoading(false);
        }
      }
    };

    fetchLeaderboard();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedMission = useMemo(
    () => missions.find((mission) => mission.slug === selectedMissionId) ?? null,
    [missions, selectedMissionId]
  );

  useEffect(() => {
    if (!selectedMission) {
      setTimeRemaining(null);
      return undefined;
    }

    if (!selectedMission.deadline) {
      setTimeRemaining(null);
      return undefined;
    }

    setTimeRemaining(getTimeRemaining(selectedMission.deadline));
    const interval = setInterval(() => {
      setTimeRemaining(getTimeRemaining(selectedMission.deadline));
    }, 1000);

    return () => clearInterval(interval);
  }, [selectedMission]);

  const groupedMissions = useMemo(() => {
    if (missions.length === 0) return [];
    const core = missions.filter((mission) => ['seasonal', 'weekly', 'daily'].includes(mission.slotType));
    const quick = missions.filter((mission) => mission.slotType === 'quick');

    const groups = [];
    if (core.length) {
      groups.push({ title: 'Core Operations', items: core });
    }
    if (quick.length) {
      groups.push({ title: 'Quick Tasks', items: quick });
    }
    return groups;
  }, [missions]);

  const totalLive = useMemo(
    () => missions.filter((mission) => mission.status?.toLowerCase().includes('live')).length,
    [missions]
  );

  const timerFields = timeRemaining
    ? [
        { label: 'Days', short: 'Days', value: pad(timeRemaining.days) },
        { label: 'Hours', short: 'Hours', value: pad(timeRemaining.hours) },
        { label: 'Minutes', short: 'Min', value: pad(timeRemaining.minutes) },
        { label: 'Seconds', short: 'Sec', value: pad(timeRemaining.seconds) },
      ]
    : [];

  const monthlyLeader = leaderboard.length > 0 ? leaderboard[0] : null;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!session) {
      triggerTransition?.(() => onSignInClick?.());
      return;
    }
    if (!selectedMission) {
      toast.error('Select a mission first.');
      return;
    }

    const summary = submission.summary.trim();
    const notes = submission.notes.trim();

    if (!summary) {
      toast.error('Add a mission summary before submitting.');
      return;
    }

    if (!selectedMission.threadId) {
      toast.error('Mission command thread is not available yet.');
      return;
    }

    if (selectedMission.threadLocked) {
      toast.error('This mission thread is currently locked.');
      return;
    }

    const composedBody = [`## Findings Summary\n${summary}`];
    if (notes) {
      composedBody.push(`\n## Additional Notes\n${notes}`);
    }
    if (evidenceFile) {
      composedBody.push(`\n_(Attachment reminder: ${evidenceFile.name} — upload via secure channel.)_`);
    }

    setSubmittingReport(true);
    try {
      const { error } = await supabase
        .from('mission_posts')
        .insert({
          thread_id: selectedMission.threadId,
          body: composedBody.join('\n'),
          created_by: session.user.id,
        });

      if (error) throw error;
      toast.success('Report routed to the mission command thread.');
      setSubmitted(true);
      setSubmission({ summary: '', notes: '' });
      setEvidenceFile(null);
      setTimeout(() => setSubmitted(false), 3500);
    } catch (error) {
      toast.error(error.message ?? 'Unable to submit findings right now.');
    } finally {
      setSubmittingReport(false);
    }
  };

  return (
    <div className="min-h-screen bg-cyber-black text-white pt-28 pb-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.header
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-12"
        >
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 via-white/0 to-white/5 p-6 sm:p-10">
            <div className="absolute inset-0 pointer-events-none opacity-35" style={{ background: 'radial-gradient(circle at 20% 20%, rgba(34,211,238,0.18), transparent 55%)' }} />
            <div className="relative z-10 space-y-4">
              <span className="inline-flex items-center gap-2 rounded-full border border-cyber-blue/40 bg-cyber-blue/15 px-4 py-1 text-xs font-orbitron uppercase tracking-[0.4em] text-cyber-cyan">
                <Compass className="h-3.5 w-3.5" />
                Grid Ops Board
              </span>
              <h1 className="font-orbitron text-3xl sm:text-4xl lg:text-5xl font-black leading-tight">
                Shared Operations for The Grid
              </h1>
              <p className="font-exo text-sm sm:text-base text-gray-200 leading-relaxed max-w-2xl">
                Daily runs, weekly briefs, and seasonal ops sourced from live telemetry. Pick an assignment, hunt the signals, and report back to reinforce our defenses.
              </p>
              <div className="flex flex-wrap gap-3 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                <span className="rounded-md border border-white/15 px-3 py-1">Live Ops: {totalLive}</span>
                <span className="rounded-md border border-white/15 px-3 py-1">Reputation Pool: 1,250 XP</span>
                <span className="rounded-md border border-white/15 px-3 py-1">Active Badges: {missions.length}</span>
              </div>
            </div>
          </div>
        </motion.header>

        {missionsLoading ? (
          <div className="py-24 text-center font-exo text-sm uppercase tracking-[0.35em] text-gray-500">
            Syncing operations board…
          </div>
        ) : missionsError ? (
          <div className="rounded-3xl border border-red-500/40 bg-red-500/10 p-10 text-center">
            <p className="font-orbitron text-sm uppercase tracking-[0.35em] text-red-200">{missionsError}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-red-500/40 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.3em] text-red-200 hover:border-red-300 hover:text-white transition"
            >
              Retry Sync
            </button>
          </div>
        ) : missions.length === 0 ? (
          <div className="py-24 text-center font-exo text-sm uppercase tracking-[0.35em] text-gray-500">
            No missions have been published yet. Check back soon.
          </div>
        ) : (
          <div className="grid gap-10 lg:grid-cols-[1.2fr_1.8fr] items-start">
            <motion.section
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="space-y-4"
            >
              {groupedMissions.map(({ title, items }) => (
                <div key={title} className="space-y-4">
                  <p className="font-orbitron text-xs uppercase tracking-[0.35em] text-gray-500">{title}</p>
                  {items.map((mission) => {
                    const isActive = mission.slug === selectedMissionId;
                    return (
                      <motion.button
                        key={mission.slug}
                        onClick={() => setSelectedMissionId(mission.slug)}
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.99 }}
                        className={`w-full text-left rounded-2xl border p-5 sm:p-6 transition-all ${
                          isActive ? 'border-cyber-blue/70 bg-cyber-blue/15 shadow-lg shadow-cyber-blue/30' : 'border-white/10 bg-white/5 hover:border-cyber-blue/30'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span className="rounded-md bg-cyber-blue/20 p-2 text-cyber-cyan">
                              <Target className="h-4 w-4" />
                            </span>
                            <div>
                              <p className="font-orbitron text-[11px] uppercase tracking-[0.3em] text-gray-400">{mission.band}</p>
                              <h3 className="font-orbitron text-xl text-white">{mission.title}</h3>
                            </div>
                          </div>
                          <span className="rounded-full border border-white/15 px-3 py-1 text-[10px] font-orbitron uppercase tracking-[0.4em] text-gray-300">
                            {mission.difficulty}
                          </span>
                        </div>
                        <p className="mt-3 font-exo text-sm text-gray-300 leading-relaxed">{mission.summary}</p>
                        <div className="mt-4 flex flex-wrap gap-2 text-[10px] font-orbitron uppercase tracking-[0.35em] text-gray-400">
                          <span className="rounded-md border border-white/15 px-3 py-1">{mission.status}</span>
                          {mission.tags.map((tag) => (
                            <span key={tag} className="rounded-md border border-white/15 px-3 py-1">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </motion.button>
                    );
                  })}
                </div>
              ))}
            </motion.section>

            {selectedMission && (
              <motion.section
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.6, delay: 0.15 }}
                className="space-y-7"
              >
                <div className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-8">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="rounded-lg bg-cyber-blue/20 p-2">
                      <ShieldCheck className="h-5 w-5 text-cyber-cyan" />
                    </span>
                    <div>
                      <h2 className="font-orbitron text-xl text-white">{selectedMission.band}</h2>
                      <p className="font-exo text-xs uppercase tracking-[0.35em] text-gray-400">{selectedMission.status}</p>
                    </div>
                  </div>
                  <h3 className="font-orbitron text-2xl text-white mb-2">{selectedMission.title}</h3>
                  <p className="font-exo text-sm text-gray-300 leading-relaxed mb-6">{selectedMission.summary}</p>

                  <div className="space-y-5">
                    <div>
                      <h4 className="font-orbitron text-xs uppercase tracking-[0.3em] text-gray-500 mb-2">Objectives</h4>
                      <ul className="space-y-2">
                        {selectedMission.objectives.map((objective, index) => (
                          <li key={`${selectedMission.slug}-objective-${index}`} className="flex items-start gap-3">
                            <span className="mt-1 h-2 w-2 rounded-full bg-cyber-cyan shadow-[0_0_10px_rgba(34,211,238,0.6)]" />
                            <span className="font-exo text-sm text-gray-200 leading-relaxed">{objective}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h4 className="font-orbitron text-xs uppercase tracking-[0.3em] text-gray-500 mb-2">Requirements</h4>
                      <ul className="space-y-2">
                        {selectedMission.requirements.map((req, index) => (
                          <li key={`${selectedMission.slug}-requirement-${index}`} className="font-exo text-sm text-gray-300 leading-relaxed">
                            {index + 1}. {req}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {selectedMission.hints.length > 0 && (
                      <div className="rounded-xl border border-cyber-blue/40 bg-cyber-blue/10 p-4">
                        <h4 className="font-orbitron text-xs uppercase tracking-[0.3em] text-cyber-cyan mb-3">Signals</h4>
                        <ul className="space-y-2">
                          {selectedMission.hints.map((hint, index) => (
                            <li key={`${selectedMission.slug}-hint-${index}`} className="font-exo text-sm text-cyber-cyan/80 leading-relaxed">
                              {hint}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-6 space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
                        <span className="text-gray-300">Rewards Package</span>
                        <span className="rounded-md border border-white/15 px-3 py-1 text-[10px] text-cyber-cyan">
                          XP Crown Eligible
                        </span>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <RewardToken value={selectedMission.rewards.xp} label="XP" glow="#00e0ff" valueClassName="text-2xl" />
                        <RewardToken value={selectedMission.rewards.badge} label="Badge" glow="#9b30ff" valueClassName="text-base" />
                        <RewardToken value={selectedMission.rewards.extras} label="Bonus" glow="#00f5ff" valueClassName="text-sm leading-tight" />
                      </div>
                      <p className="font-exo text-xs text-gray-400">
                        Monthly XP Crown awards go to the operative with the highest cumulative XP score. Stay active across missions to stay in contention.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Link
                        to={`/hub/mission/${selectedMission.slug}`}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyber-blue/40 px-4 py-2 text-xs font-orbitron uppercase tracking-[0.32em] text-cyber-blue hover:border-cyber-blue/70 hover:text-white transition"
                      >
                        {selectedMission.threadLocked ? 'Thread Locked' : 'Open Command Thread'}
                      </Link>
                      {selectedMission.threadLocked && (
                        <span className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-exo uppercase tracking-[0.3em] text-gray-400">
                          Moderation holding — submissions paused
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-2">
                  <div className="flex h-full flex-col rounded-3xl border border-white/10 bg-white/5 p-5 sm:p-6 space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="font-orbitron text-sm uppercase tracking-[0.3em] text-white flex items-center gap-2">
                        <Trophy className="h-5 w-5 text-cyber-cyan" />
                        XP Leaderboard
                      </h3>
                      <span className="text-[11px] font-orbitron uppercase tracking-[0.3em] text-gray-400">Updated on load</span>
                    </div>
                    {leaderboardLoading ? (
                      <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-center font-exo text-xs uppercase tracking-[0.3em] text-gray-500">
                        Loading standings…
                      </div>
                    ) : leaderboardError ? (
                      <div className="rounded-xl border border-red-400/40 bg-red-500/10 p-4 text-center font-exo text-xs uppercase tracking-[0.3em] text-red-200">
                        {leaderboardError}
                      </div>
                    ) : leaderboard.length === 0 ? (
                      <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-center font-exo text-xs uppercase tracking-[0.3em] text-gray-500">
                        No operatives have earned XP yet.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {leaderboard.map((entry) => (
                          <div key={entry.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
                            <div className="flex items-center justify-between">
                              <p className="font-orbitron text-sm text-white">{entry.display_name || entry.username}</p>
                              <span className="rounded-md border border-cyber-blue/30 px-2 py-1 text-[10px] font-orbitron uppercase tracking-[0.3em] text-cyber-cyan">
                                {entry.xp ?? 0} XP
                              </span>
                            </div>
                            <p className="mt-2 font-exo text-[11px] uppercase tracking-[0.3em] text-gray-500">
                              Reputation: {entry.reputation ?? 0}
                            </p>
                            <p className="mt-1 font-exo text-sm text-gray-300">
                              Badges collected: {Array.isArray(entry.badges) ? entry.badges.length : 0}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                    {monthlyLeader && (
                      <div className="rounded-2xl border border-cyber-blue/30 bg-cyber-blue/10 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-orbitron text-sm uppercase tracking-[0.3em] text-cyber-cyan">Monthly XP Crown</p>
                            <p className="font-exo text-xs text-gray-400">
                              Highest cumulative XP operative this cycle.
                            </p>
                          </div>
                          <span className="rounded-md border border-cyber-cyan/40 px-3 py-1 text-[10px] font-orbitron uppercase tracking-[0.3em] text-cyber-cyan">
                            {monthlyLeader.xp ?? 0} XP
                          </span>
                        </div>
                        <div className="rounded-xl border border-white/15 bg-black/30 p-4">
                          <p className="font-orbitron text-base text-white">{monthlyLeader.display_name || monthlyLeader.username}</p>
                          <p className="mt-2 font-exo text-sm text-gray-300">
                            Reward: Grid merch drop + private briefing seat
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="rounded-3xl border border-white/10 bg-black/40 p-6 sm:p-7">
                    <form onSubmit={handleSubmit} className="flex h-full flex-col space-y-4">
                      <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between gap-3">
                          <h4 className="font-orbitron text-sm uppercase tracking-[0.3em] text-white">Submit findings</h4>
                          <span className="rounded-md border border-white/20 px-3 py-1 text-[10px] font-orbitron uppercase tracking-[0.3em] text-gray-400">
                            {session ? 'Authenticated' : 'Sign-in required'}
                          </span>
                        </div>
                        <p className="text-[11px] font-exo text-gray-500">
                          Publish the distilled report. Mission leads review and publish highlights to the Grid.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <label className="font-exo text-xs uppercase tracking-[0.3em] text-gray-500">Summary</label>
                        <textarea
                          value={submission.summary}
                          onChange={(event) => setSubmission((prev) => ({ ...prev, summary: event.target.value }))}
                          rows={3}
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-exo text-sm text-gray-200 placeholder-gray-500 focus:border-cyber-blue focus:outline-none"
                          placeholder="Outline attack path, indicators, and mitigation steps…"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="font-exo text-xs uppercase tracking-[0.3em] text-gray-500">Additional notes</label>
                        <textarea
                          value={submission.notes}
                          onChange={(event) => setSubmission((prev) => ({ ...prev, notes: event.target.value }))}
                          rows={2}
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-exo text-sm text-gray-200 placeholder-gray-500 focus:border-cyber-blue focus:outline-none"
                          placeholder="Optional: tooling, attack timeline, supporting intel."
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="font-exo text-xs uppercase tracking-[0.3em] text-gray-500">Attach evidence</label>
                        <input
                          type="file"
                          onChange={(event) => setEvidenceFile(event.target.files?.[0] ?? null)}
                          className="w-full cursor-pointer rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-exo text-sm text-gray-200 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-cyber-blue/20 file:px-3 file:py-1 file:text-xs file:font-orbitron file:uppercase file:tracking-[0.3em] file:text-cyber-cyan focus:border-cyber-blue focus:outline-none"
                        />
                        {evidenceFile && (
                          <p className="font-exo text-xs text-white/70">Selected: {evidenceFile.name}</p>
                        )}
                      </div>
                      {timeRemaining && (
                        <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <span className="inline-flex items-center gap-2 font-orbitron text-xs uppercase tracking-[0.3em] text-gray-400">
                              <Clock3 className="h-4 w-4 text-cyber-cyan" />
                              Deadline
                            </span>
                            <span className="font-exo text-xs text-gray-500">
                              {selectedMission.deadline ? new Date(selectedMission.deadline).toLocaleString() : 'TBA'}
                            </span>
                          </div>
                          <div className="grid grid-cols-4 gap-2 text-center">
                            {timerFields.map(({ short, value }) => (
                              <div key={short} className="rounded-lg border border-white/10 bg-black/30 p-2">
                                <p className="font-orbitron text-lg text-white">{value}</p>
                                <p className="mt-1 font-exo text-[10px] uppercase tracking-[0.3em] text-gray-400">{short}</p>
                              </div>
                            ))}
                          </div>
                          {timeRemaining.diff === 0 && (
                            <p className="font-orbitron text-[11px] uppercase tracking-[0.3em] text-cyber-cyan">
                              Deadline elapsed — submit post-action report.
                            </p>
                          )}
                        </div>
                      )}
                      <div className="mt-auto flex flex-col sm:flex-row gap-3">
                        <motion.button
                          type="submit"
                          whileHover={{ scale: submittingReport || submitted ? 1 : 1.02 }}
                          whileTap={{ scale: submittingReport || submitted ? 1 : 0.98 }}
                          className="flex-1 rounded-lg bg-gradient-to-r from-cyber-blue to-cyber-cyan px-4 py-3 font-orbitron text-sm uppercase tracking-[0.27em] text-cyber-darker shadow-lg shadow-cyber-blue/40 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={submittingReport || submitted}
                        >
                          {submitted ? 'Report Received' : submittingReport ? 'Submitting…' : 'Submit Findings'}
                        </motion.button>
                      </div>
                    </form>
                  </div>

                  <div className="rounded-3xl border border-white/10 bg-white/5 p-5 text-center">
                    <p className="font-exo text-sm text-gray-400 mb-4">
                      Need to coordinate with other operatives? Jump into the Grid mission threads for {selectedMission.title}.
                    </p>
                    <Link
                      to={`/hub/mission/${selectedMission.slug}`}
                      className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-cyber-blue/40 text-xs font-orbitron uppercase tracking-[0.3em] text-cyber-blue hover:border-cyber-blue/70 hover:text-white transition-all"
                    >
                      Open Mission Thread
                    </Link>
                  </div>
                </div>
              </motion.section>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MissionsPage;

