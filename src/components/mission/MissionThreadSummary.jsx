import React from 'react';
import RewardToken from '../RewardToken';

const MissionThreadSummary = ({ thread }) => {
  const { mission } = thread;
  if (!mission) return null;

  const accent = mission.accent_glow || mission.difficulty_color || '#00e0ff';
  const rewards = {
    xp: mission.rewards_xp ?? 0,
    badge: mission.rewards_badge ?? 'Badge',
    bonus: mission.rewards_bonus ?? 'Bonus',
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-8">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-3">
          <p className="font-orbitron text-xs uppercase tracking-[0.35em] text-gray-500">
            {mission.band}
          </p>
          <h1 className="font-orbitron text-3xl sm:text-4xl text-white">{mission.title}</h1>
          <p className="font-exo text-sm text-gray-300 leading-relaxed max-w-2xl">{thread.summary}</p>
        </div>
        <div className="flex flex-wrap gap-3 text-xs font-orbitron uppercase tracking-[0.3em] text-gray-400">
          {mission.difficulty && (
            <span className="rounded-md border border-white/15 px-3 py-1" style={{ borderColor: accent, color: accent }}>
              {mission.difficulty}
            </span>
          )}
          {thread.status && (
            <span className="rounded-md border border-white/15 px-3 py-1">
              {thread.status}
            </span>
          )}
        </div>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <RewardToken value={rewards.xp} label="XP Reward" glow={accent} valueClassName="text-2xl" />
        <RewardToken value={rewards.badge} label="Badge" glow="#9b30ff" valueClassName="text-base" />
        <RewardToken
          value={rewards.bonus}
          label="Bonus"
          glow="#00f5ff"
          valueClassName="text-sm leading-snug"
        />
      </div>
    </section>
  );
};

export default MissionThreadSummary;

