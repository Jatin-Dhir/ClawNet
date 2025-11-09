import React, { useMemo, useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ArrowRight } from 'lucide-react';
import CommunityParticles from './CommunityParticles';

const CommunityIntro = ({ onSignInClick, triggerTransition }) => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: '-100px' });
  const { session } = useAuth();
  const navigate = useNavigate();
  const boardCopy = useMemo(
    () => [
      'GRID OPS BOARD • LIVE SIGNALS',
      'DAILY RUN • SIGNAL DECODE',
      'WEEKLY ASSIGNMENT • BEACON HUNT',
      'SEASONAL BRIEF • VAULT INTRUSION OPS',
    ],
    []
  );
  const publicMissions = useMemo(
    () => [
      {
        cadence: 'Daily Run',
        name: 'Signal Decode Sprint',
        summary: 'Classify the anomaly bundle and publish SOC guidance.',
        deadline: 'Resets every 24h',
        reward: 'Pattern Decoder badge · 250 XP',
      },
      {
        cadence: 'Weekly Assignment',
        name: 'Beacon Hunt',
        summary: 'Uncover the covert exfil channel seeded in the Grid.',
        deadline: 'Closes Sunday 23:00 UTC',
        reward: 'Signal Interceptor badge · Red Team drill invite',
      },
      {
        cadence: 'Seasonal Brief',
        name: 'Vault Intrusion Ops',
        summary: 'Secure the Specter token before the defenders lock the vault.',
        deadline: 'Invite-only rotation',
        reward: 'Vault Specter badge · Beta tooling access',
      },
    ],
    []
  );
  const handleClick = () => {
    if (session) {
      triggerTransition(() => navigate('/hub'));
    } else {
      triggerTransition(onSignInClick);
    }
  };

  const goToMissions = () => {
    navigate('/missions');
  };

  return (
    <section id="community" ref={ref} className="relative py-16 md:py-24 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 60, scale: 0.95 }}
          animate={isInView ? { opacity: 1, y: 0, scale: 1 } : {}}
          transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
          className="relative overflow-hidden"
        >
          <div className="max-w-6xl mx-auto">
            <motion.div
              className="cyber-card p-8 md:p-12 overflow-hidden"
              whileHover={{
                y: -6,
                scale: 1.01,
                boxShadow: '0 0 32px rgba(0, 224, 255, 0.22), inset 0 0 26px rgba(0, 224, 255, 0.08)',
                borderColor: 'rgba(0, 224, 255, 0.55)',
                transition: { duration: 0.3 },
              }}
            >
              <div className="absolute -inset-px bg-cyber-grid opacity-10 transition-opacity duration-300" style={{ backgroundSize: '30px 30px' }} />
              <CommunityParticles />
              <div className="relative z-10 flex flex-col items-center gap-6 text-center lg:flex-row lg:items-center lg:justify-between lg:text-left">
                <div className="max-w-2xl space-y-4">
                  <span className="inline-flex items-center gap-2 rounded-full border border-cyber-blue/40 bg-cyber-blue/10 px-4 py-1 font-orbitron text-xs uppercase tracking-[0.35em] text-cyber-cyan">
                    Operate together
                  </span>
                  <h2 className="section-title mb-2">Join The ClawNet Community</h2>
                  <p className="font-exo text-base md:text-lg text-gray-400">
                    Share tradecraft, deploy in cohorts, and keep the Grid hardened. Access live telemetry, curated missions, and verified operatives inside one command mesh.
                  </p>
                </div>
                <motion.button
                  onClick={handleClick}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  className="inline-flex items-center justify-center gap-3 rounded-lg bg-gradient-to-r from-cyber-blue to-cyber-cyan px-6 py-3 font-orbitron text-sm uppercase tracking-[0.35em] text-cyber-darker shadow-lg shadow-cyber-blue/40"
                >
                  {session ? 'Enter the Hub' : 'Authenticate and Engage'}
                  <ArrowRight className="h-4 w-4" />
                </motion.button>
              </div>
            </motion.div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: 0.2, duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
          className="mt-20 sm:mt-24 space-y-6"
        >
          <div className="relative overflow-hidden rounded-full border-2 border-cyber-blue/60 py-2">
            <div className="overflow-hidden">
              <motion.div
                className="flex min-w-full gap-10 whitespace-nowrap font-orbitron text-[11px] sm:text-xs uppercase tracking-[0.45em] text-cyber-cyan"
                animate={{ x: ['0%', '-50%'] }}
                transition={{ repeat: Infinity, duration: 22, ease: 'linear' }}
              >
                {[...boardCopy, ...boardCopy].map((text, idx) => (
                  <span key={`top-${idx}`} className="inline-block">
                    {text}
                  </span>
                ))}
              </motion.div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h3 className="font-orbitron text-lg sm:text-xl text-white uppercase tracking-[0.3em]">
                Public Operations Board
              </h3>
              <p className="font-exo text-sm text-gray-400 mt-2 max-w-2xl">
                Daily, weekly, and seasonal operations sourced from live telemetry. Pick a lane, push your findings, and level up your reputation.
              </p>
            </div>
            <button
              type="button"
              onClick={goToMissions}
              className="self-start sm:self-auto px-4 py-2 rounded-lg border border-cyber-blue/40 text-xs font-orbitron uppercase tracking-[0.3em] text-cyber-blue hover:border-cyber-blue/70 hover:text-white transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-cyber-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-cyber-black"
            >
              View Ops Board
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {publicMissions.map((mission, index) => (
              <motion.div
                key={mission.name}
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.25 + index * 0.08 }}
                className="relative border border-white/10 rounded-2xl bg-white/5 backdrop-blur-sm p-6 overflow-hidden"
              >
                <div className="absolute inset-0 opacity-30 pointer-events-none" style={{ background: 'radial-gradient(circle at 20% 20%, rgba(34,211,238,0.15), transparent 55%)' }} />
                <div className="relative z-10 space-y-4">
                  <div className="font-orbitron text-[10px] uppercase tracking-[0.4em] text-gray-400">
                    {mission.cadence}
                  </div>
                  <h4 className="font-orbitron text-xl text-white mb-3">{mission.name}</h4>
                  <p className="font-exo text-sm text-gray-300 leading-relaxed">{mission.summary}</p>
                  <div className="space-y-3 text-xs font-exo text-gray-400">
                    <div>
                      <span className="text-gray-500 uppercase tracking-[0.3em]">Deadline</span>
                      <p className="text-gray-200">{mission.deadline}</p>
                    </div>
                    <div>
                      <span className="text-gray-500 uppercase tracking-[0.3em]">Reward</span>
                      <p className="text-cyber-cyan">{mission.reward}</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          <div className="relative overflow-hidden rounded-full border-2 border-cyber-blue/60 py-2">
            <div className="overflow-hidden">
              <motion.div
                className="flex min-w-full gap-10 whitespace-nowrap font-orbitron text-[11px] sm:text-xs uppercase tracking-[0.45em] text-cyber-cyan"
                animate={{ x: ['-50%', '0%'] }}
                transition={{ repeat: Infinity, duration: 22, ease: 'linear' }}
              >
                {[...boardCopy, ...boardCopy].map((text, idx) => (
                  <span key={`bottom-${idx}`} className="inline-block">
                    {text}
                  </span>
                ))}
              </motion.div>
            </div>
          </div>
        </motion.div>
      </div>
      <style>
        {`
          @media (prefers-reduced-motion: reduce) {
            .marquee-line {
              animation: none !important;
              transform: translateX(0) !important;
            }
          }
        `}
      </style>
    </section>
  );
};

export default CommunityIntro;
