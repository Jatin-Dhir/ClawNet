import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Compass, ShieldCheck, Cpu, Users, Globe2, Archive } from 'lucide-react';

const exploreItems = [
  {
    title: 'Services Command Center',
    description: 'See how our response teams execute VAPT, cloud audits, and incident containment.',
    href: '/cyber-operations',
    icon: ShieldCheck,
    accent: 'from-cyber-blue to-cyber-cyan',
  },
  {
    title: 'Tool Lab',
    description: 'Preview PortLock, ClawNet Core, and ClawView in action before you deploy.',
    href: '#tools',
    icon: Cpu,
    accent: 'from-purple-500 to-pink-500',
  },
  {
    title: 'Community Hub',
    description: 'Drop into The Grid, share intel, and study what other analysts are building.',
    href: '/hub',
    icon: Users,
    accent: 'from-green-400 to-cyan-400',
    requiresAuth: true,
  },
  {
    title: 'Research & Intel',
    description: 'Read threat briefings, red-team notes, and security playbooks from our labs.',
    href: '/research/featured',
    icon: Archive,
    accent: 'from-orange-400 to-red-500',
  },
  {
    title: 'Global Presence',
    description: 'Understand how ClawNet deployments secure campuses, finance, and public infra.',
    href: '#about',
    icon: Globe2,
    accent: 'from-cyber-blue to-purple-500',
  },
];

const ExploreNavigator = ({ onSignInClick, triggerTransition }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const handleNavigate = (item) => {
    if (item.requiresAuth && typeof onSignInClick === 'function') {
      triggerTransition?.(onSignInClick);
      return;
    }

    const isAnchor = item.href.startsWith('#');

    if (isAnchor) {
      if (location.pathname !== '/') {
        navigate('/');
        setTimeout(() => {
          document.querySelector(item.href)?.scrollIntoView({ behavior: 'smooth' });
        }, 150);
      } else {
        document.querySelector(item.href)?.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }

    navigate(item.href);
  };

  return (
    <section id="explore-grid" className="relative py-16 sm:py-20 bg-gradient-to-b from-transparent via-cyber-black/60 to-transparent">
      <div className="absolute inset-0 pointer-events-none">
        <div className="mx-auto h-full w-full max-w-6xl opacity-30">
          <div className="h-full w-full rounded-3xl bg-gradient-to-r from-cyber-blue/10 via-transparent to-cyber-purple/10 blur-3xl" />
        </div>
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6 mb-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyber-blue/30 bg-cyber-blue/10 text-xs font-exo uppercase tracking-wider text-cyber-blue">
              <Compass className="w-4 h-4" />
              Explore the Platform
            </div>
            <h2 className="mt-4 font-orbitron text-2xl sm:text-3xl md:text-4xl text-white leading-tight">
              Chart your path through ClawNet
            </h2>
            <p className="mt-3 font-exo text-sm sm:text-base text-gray-400 max-w-2xl">
              Pick a mission track and we&apos;ll guide you—whether you want services intel, product demos, or a seat in the community hub.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {exploreItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <motion.button
                key={item.title}
                type="button"
                onClick={() => handleNavigate(item)}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05, duration: 0.4 }}
                whileHover={{ y: -6 }}
                whileTap={{ scale: 0.98 }}
                className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-left transition-all duration-300 hover:border-cyber-blue/40 focus:outline-none focus:ring-2 focus:ring-cyber-cyan"
              >
                <div
                  className={`pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gradient-to-br ${item.accent}`}
                  style={{ mixBlendMode: 'screen' }}
                />
                <div className="relative z-10 flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${item.accent} text-white shadow-lg shadow-cyber-black/30`}>
                      <Icon className="w-6 h-6" />
                    </div>
                    <span className="font-orbitron text-lg text-white">
                      {item.title}
                    </span>
                  </div>
                  <p className="font-exo text-sm text-gray-300 leading-relaxed">
                    {item.description}
                  </p>
                  <div className="mt-auto flex items-center gap-2 text-xs font-orbitron uppercase tracking-[0.2em] text-cyber-blue group-hover:text-white transition-colors">
                    <span>{item.requiresAuth ? 'Sign In to Enter' : 'Launch Segment'}</span>
                    <motion.span
                      animate={{ x: [0, 4, 0] }}
                      transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut', delay: index * 0.1 }}
                    >
                      →
                    </motion.span>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default ExploreNavigator;

