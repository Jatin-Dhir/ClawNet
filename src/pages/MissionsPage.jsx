import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useOutletContext } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  Target,
  Trophy,
  ShieldCheck,
  Compass,
  Clock3,
} from 'lucide-react';

const missions = [
  {
    id: 'vault-intrusion',
    title: 'Vault Intrusion Ops',
    band: 'Seasonal Brief',
    category: 'Core Operation',
    difficulty: 'Expert',
    status: 'Invite Only • Ends in 22d',
    deadline: '2025-12-01T23:59:59Z',
    summary:
      'Collaborate with another team to simulate a full intrusion of the ClawNet Vault environment. Capture the hidden credential cache before the defenders shut you down.',
    objectives: [
      'Form a two-person cell and request attack surface brief.',
      'Stage a lateral movement chain within 45 minutes.',
      'Extract the “Specter” token and publish a sanitized after-action.',
    ],
    requirements: [
      'Invite from a current mission lead or maintain 1,000+ Grid reputation.',
      'Ability to operate both offensive and defensive tooling.',
      'Strict adherence to the ClawNet simulation charter.',
    ],
    rewards: {
      xp: 600,
      badge: 'Vault Specter',
      extras: 'Access to closed beta tooling',
    },
    tags: ['red-vs-blue', 'collaboration', 'simulation'],
    hints: [
      'The target environment resets hourly — document everything.',
      'Watch for deceptive traps; defenders seeded fake creds in memory.',
    ],
  },
  {
    id: 'grid-challenge-07',
    title: 'Beacon Hunt',
    band: 'Weekly Assignment',
    category: 'Core Operation',
    difficulty: 'Advanced',
    status: 'Live • Ends in 6d',
    deadline: '2025-11-15T23:59:59Z',
    summary:
      'Track and neutralize a covert data exfiltration channel seeded inside the Community Grid. You will need to combine log sleuthing with payload analysis to find the embedded key.',
    objectives: [
      'Locate the hidden beacon signal embedded inside the community hub assets.',
      'Reverse-engineer the obfuscated payload and extract the command sequence.',
      'Publish a mitigation playbook for the community.',
    ],
    requirements: [
      'Proficiency with traffic analysis (Wireshark, Zeek, or similar).',
      'Understanding of modern steganography and encoding schemes.',
      'Ability to document findings in the Grid with reproducible steps.',
    ],
    rewards: {
      xp: 400,
      badge: 'Signal Interceptor',
      extras: 'Private red-team drill invite',
    },
    tags: ['threat-hunting', 'reverse-engineering', 'forensics'],
    hints: [
      'The beacon cycles every 11 minutes — watch for repeating entropy spikes.',
      'Payload fragments append to legitimate asset requests; compare checksums.',
    ],
  },
  {
    id: 'signal-decode-sprint',
    title: 'Signal Decode Sprint',
    band: 'Daily Run',
    category: 'Core Operation',
    difficulty: 'Intermediate',
    status: 'Resets 24h',
    deadline: '2025-11-10T12:00:00Z',
    summary:
      'Decode the latest ClawView anomaly bundle and classify the threat category. Your report feeds the production ML model used in ClawNet Core deployments.',
    objectives: [
      'Download the anomaly bundle from the missions repo.',
      'Classify the attacker TTP based on traffic shape and metadata.',
      'Submit a remediation snippet compatible with ClawView playbooks.',
    ],
    requirements: [
      'Familiarity with MITRE ATT&CK mapping.',
      'Ability to craft concise SOC recommendations.',
      'Optional: experience with sigma/kql detection formats.',
    ],
    rewards: {
      xp: 250,
      badge: 'Pattern Decoder',
      extras: 'Featured slot in community briefing',
    },
    tags: ['clawview', 'analysis', 'intel'],
    hints: [
      'Look for privilege escalation attempts disguised as analytics jobs.',
      'Remember to normalize timestamps before running correlation pivot.',
    ],
  },
  {
    id: 'arcade-probe',
    title: 'Arcade Probe',
    band: 'Weekend Warmup',
    category: 'Quick Task',
    difficulty: 'Beginner',
    status: 'Live • Ends in 2d',
    deadline: '2025-11-11T18:00:00Z',
    summary:
      'Trace the noisy credential stuffing wave hitting our arcade endpoints. Correlate IP clusters and recommend mitigation tiers.',
    objectives: [
      'Pull the weekend logs from the ClawNet Arcade proxy.',
      'Group offending IPs by ASN and reputation.',
      'Draft tiered rate-limit guidance for deployment.',
    ],
    requirements: [
      'Comfort with log parsing (jq, pandas, or similar).',
      'Ability to summarize findings clearly for engineers.',
      'Understand basic credential stuffing behaviors.',
    ],
    rewards: {
      xp: 140,
      badge: 'Arcade Sentinel',
      extras: 'Invite to weekend anomaly debrief',
    },
    tags: ['defense', 'log-analysis', 'automation'],
    hints: [
      'Look for repeated user-agents that mimic outdated browsers.',
      'ASN 20473 has several nodes rotating credentials every 8 minutes.',
    ],
  },
  {
    id: 'artifact-trace',
    title: 'Artifact Trace',
    band: 'Quick Task',
    category: 'Quick Task',
    difficulty: 'Beginner',
    status: 'Live • Ends in 12h',
    deadline: '2025-11-10T00:00:00Z',
    summary:
      'Identify which community upload introduced the rogue DLL artefact last night and notify the submitter with remediation steps.',
    objectives: [
      'Review the last 24h of uploads in the sandbox queue.',
      'Hash the rogue DLL and cross-reference the artifact cache.',
      'Prepare a remediation note the submitter can follow.',
    ],
    requirements: [
      'Basic familiarity with hashing tools.',
      'Ability to write concise remediation instructions.',
      'Comfort with Git or asset history tools.',
    ],
    rewards: {
      xp: 120,
      badge: 'Artifact Analyst',
      extras: 'Fast-track to Grid analyst interviews',
    },
    tags: ['forensics', 'triage', 'community'],
    hints: [
      'The rogue DLL was bundled inside a compressed evidence pack.',
      'Only uploads tagged with “sandbox-staging” need inspection.',
    ],
  },
  {
    id: 'perimeter-pulse',
    title: 'Perimeter Pulse',
    band: 'Baseline Check',
    category: 'Quick Task',
    difficulty: 'Beginner',
    status: 'Live • Ends in 18h',
    deadline: '2025-11-10T06:00:00Z',
    summary:
      'Scan the community perimeter sensors for misconfigured TLS endpoints and raise tickets for the owners.',
    objectives: [
      'Pull the latest TLS scan results from the telemetry dashboard.',
      'Flag endpoints with weak cipher suites or expired certificates.',
      'Draft communication for each affected project lead.',
    ],
    requirements: [
      'Knowledge of TLS versions and cipher strength basics.',
      'Comfort creating tickets in the Grid issue system.',
      'Attention to detail when validating hostnames.',
    ],
    rewards: {
      xp: 160,
      badge: 'Pulse Responder',
      extras: 'Priority access to infra hardening workshops',
    },
    tags: ['infra', 'tls', 'ops'],
    hints: [
      'Pay attention to endpoints still advertising TLS 1.0.',
      'Expired certificates cluster around the “legacy-tools” subdomain.',
    ],
  },
];

const scoreboard = [
  { team: 'NullSweep', mission: 'Grid Challenge 07', time: '4h 12m', xp: 400 },
  { team: 'DeltaSpectre', mission: 'Signal Decode Sprint', time: '1h 05m', xp: 250 },
  { team: 'BinarySynth', mission: 'Vault Intrusion', time: 'Completed', xp: 600 },
];
const getTimeRemaining = (deadline) => {
  if (!deadline) return null;
  const target = new Date(deadline).getTime();
  if (Number.isNaN(target)) return null;
  const diff = target - Date.now();
  const clamped = Math.max(diff, 0);
  const days = Math.floor(clamped / (1000 * 60 * 60 * 24));
  const hours = Math.floor((clamped / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((clamped / (1000 * 60)) % 60);
  const seconds = Math.floor((clamped / 1000) % 60);
  return { diff: clamped, days, hours, minutes, seconds };
};

const formatDeadline = (deadline) => {
  if (!deadline) return 'TBA';
  try {
    const formatter =
      typeof window !== 'undefined' && window.Intl
        ? new window.Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short',
          })
        : null;

    if (!formatter) {
      return new Date(deadline).toISOString();
    }

    return formatter.format(new Date(deadline));
  } catch (error) {
    return deadline;
  }
};

const pad = (value) => value.toString().padStart(2, '0');

const MissionsPage = () => {
  const { session } = useAuth();
  const { onSignInClick, triggerTransition } = useOutletContext() || {};
  const [selectedMissionId, setSelectedMissionId] = useState(missions[0].id);
  const [submission, setSubmission] = useState({ summary: '', notes: '' });
  const [evidenceFile, setEvidenceFile] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(() => getTimeRemaining(missions[0].deadline));
  const monthlyLeader = useMemo(
    () => [...scoreboard].sort((a, b) => b.xp - a.xp)[0],
    []
  );
  const groupedMissions = useMemo(
    () => [
      { title: 'Core Operations', items: missions.slice(0, 3) },
      { title: 'Quick Tasks', items: missions.slice(3) },
    ],
    []
  );
  const selectedMission = useMemo(
    () => missions.find((mission) => mission.id === selectedMissionId) ?? missions[0],
    [selectedMissionId]
  );
  const totalLive = missions.filter((mission) => mission.status.toLowerCase().includes('live')).length;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!session) {
      triggerTransition?.(onSignInClick);
      return;
    }
    setSubmitted(true);
    setSubmission({ summary: '', notes: '' });
    setEvidenceFile(null);
    setTimeout(() => setSubmitted(false), 3500);
  };

  useEffect(() => {
    setTimeRemaining(getTimeRemaining(selectedMission.deadline));
    if (!selectedMission.deadline) return undefined;
    const interval = setInterval(() => {
      setTimeRemaining(getTimeRemaining(selectedMission.deadline));
    }, 1000);
    return () => clearInterval(interval);
  }, [selectedMission.deadline]);

  const timerFields = timeRemaining
    ? [
        { label: 'Days', value: pad(timeRemaining.days) },
        { label: 'Hours', value: pad(timeRemaining.hours) },
        { label: 'Minutes', value: pad(timeRemaining.minutes) },
        { label: 'Seconds', value: pad(timeRemaining.seconds) },
      ]
    : [];

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
                <span className="rounded-md border border-white/15 px-3 py-1">Active Badges: 7</span>
              </div>
            </div>
          </div>
        </motion.header>

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
                  const isActive = mission.id === selectedMissionId;
                  return (
                    <motion.button
                      key={mission.id}
                      onClick={() => setSelectedMissionId(mission.id)}
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
                            <p className="font-orbitron text-[11px] uppercase tracking-[0.3em] text-gray-400">
                              {mission.band}
                            </p>
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
                      <li key={index} className="flex items-start gap-3">
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
                      <li key={index} className="font-exo text-sm text-gray-300 leading-relaxed">
                        {index + 1}. {req}
                      </li>
                    ))}
                  </ul>
                </div>
                {selectedMission.hints?.length > 0 && (
                  <div className="rounded-xl border border-cyber-blue/40 bg-cyber-blue/10 p-4">
                    <h4 className="font-orbitron text-xs uppercase tracking-[0.3em] text-cyber-cyan mb-3">Signals</h4>
                    <ul className="space-y-2">
                      {selectedMission.hints.map((hint, index) => (
                        <li key={index} className="font-exo text-sm text-cyber-cyan/80 leading-relaxed">
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
                    <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-center">
                      <p className="font-orbitron text-2xl text-white">{selectedMission.rewards.xp}</p>
                      <p className="mt-1 font-exo text-[10px] uppercase tracking-[0.3em] text-gray-400">XP</p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-center">
                      <p className="font-orbitron text-base text-white">{selectedMission.rewards.badge}</p>
                      <p className="mt-1 font-exo text-[10px] uppercase tracking-[0.3em] text-gray-400">Badge</p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-center">
                      <p className="font-orbitron text-base text-white">{selectedMission.rewards.extras}</p>
                      <p className="mt-1 font-exo text-[10px] uppercase tracking-[0.3em] text-gray-400">Bonus</p>
                    </div>
                  </div>
                  <p className="font-exo text-xs text-gray-400">
                    Monthly XP Crown awards go to the operative with the highest cumulative XP score. Stay active across missions to stay in contention.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-2">
              <div className="flex h-full flex-col rounded-3xl border border-white/10 bg-white/5 p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-orbitron text-sm uppercase tracking-[0.3em] text-white flex items-center gap-2">
                    <Trophy className="h-5 w-5 text-cyber-cyan" />
                    Weekly Leaderboard
                  </h3>
                  <span className="text-[11px] font-orbitron uppercase tracking-[0.3em] text-gray-400">Updated hourly</span>
                </div>
                <div className="space-y-3">
                  {scoreboard.map((entry) => (
                    <div key={`${entry.team}-${entry.mission}`} className="rounded-xl border border-white/10 bg-black/30 p-3">
                      <div className="flex items-center justify-between">
                        <p className="font-orbitron text-sm text-white">{entry.team}</p>
                        <span className="rounded-md border border-cyber-blue/30 px-2 py-1 text-[10px] font-orbitron uppercase tracking-[0.3em] text-cyber-cyan">
                          {entry.xp} XP
                        </span>
                      </div>
                      <p className="mt-2 font-exo text-[11px] uppercase tracking-[0.3em] text-gray-500">{entry.mission}</p>
                      <p className="mt-1 font-exo text-sm text-gray-300">Completion Time: {entry.time}</p>
                    </div>
                  ))}
                </div>
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
                      {monthlyLeader.xp} XP
                    </span>
                  </div>
                  <div className="rounded-xl border border-white/15 bg-black/30 p-4">
                    <p className="font-orbitron text-base text-white">{monthlyLeader.team}</p>
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
                      Upload the distilled report. Mission leads review and publish highlights to the Grid.
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
                          {formatDeadline(selectedMission.deadline)}
                        </span>
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-center">
                        {timerFields.map(({ label, value }) => (
                          <div key={label} className="rounded-lg border border-white/10 bg-black/30 p-2">
                            <p className="font-orbitron text-lg text-white">{value}</p>
                            <p className="mt-1 font-exo text-[10px] uppercase tracking-[0.3em] text-gray-400">
                              {label}
                            </p>
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
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="flex-1 rounded-lg bg-gradient-to-r from-cyber-blue to-cyber-cyan px-4 py-3 font-orbitron text-sm uppercase tracking-[0.27em] text-cyber-darker shadow-lg shadow-cyber-blue/40 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={submitted}
                    >
                      {submitted ? 'Report Received' : 'Submit Findings'}
                    </motion.button>
                  </div>
                </form>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-5 text-center">
                <p className="font-exo text-sm text-gray-400 mb-4">
                  Need to coordinate with other operatives? Jump into the Grid mission threads.
                </p>
                <Link
                  to="/hub#mission-threads"
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-cyber-blue/40 text-xs font-orbitron uppercase tracking-[0.3em] text-cyber-blue hover:border-cyber-blue/70 hover:text-white transition-all"
                >
                  Open Mission Threads
                </Link>
              </div>
            </div>
          </motion.section>
        </div>

      </div>
    </div>
  );
};

export default MissionsPage;

