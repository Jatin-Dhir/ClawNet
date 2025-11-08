import React from 'react';
import { motion } from 'framer-motion';
import { Shield, BookOpen, Users, Cpu, Globe, Zap, Network, ShieldCheck, Wrench } from 'lucide-react';

const storyHighlights = [
  'A student-led prototype, engineered after hours in the PCTE computer labs, matured into ClawNet’s adaptive defense fabric.',
  'Faculty mentors guided every architecture and policy review, aligning the platform with enterprise expectations and regulatory rigor.',
  'Their mentorship continues through technical councils that vet features, stress-test release candidates, and keep the platform honest.',
];

const reviews = [
  {
    author: 'Prof. Ekta Sharma, PCTE',
    quote:
      '“ClawNet’s team brings a rare mix of discipline and experimentation—the platform now safeguards partner networks with precision we once only modeled in class.”',
  },
  {
    author: 'Arjun Singh, Cyber Analyst',
    quote:
      '“Deploying ClawNet gave us visibility we lacked for years. Their response crew works beside us, not above us, which lets our analysts move faster.”',
  },
  {
    author: 'Neha Kapoor, Partner Organization',
    quote:
      '“From onboarding to red-team rehearsals, ClawNet delivered a mature, battle-tested service. It feels like a long-term ally invested in our resilience.”',
  },
];

const communityPillars = [
  {
    icon: Network,
    title: 'Community Grid',
    description:
      'A moderated space where practitioners exchange playbooks, share threat intel, and co-author defensive patterns in real time.',
  },
  {
    icon: ShieldCheck,
    title: 'Managed Services',
    description:
      'Advisory, detection, and response services that scale from first assessment to 24/7 coverage, backed by our mentor-led review board.',
  },
  {
    icon: Wrench,
    title: 'Tool Suite',
    description:
      'PortLock, ClawView, and ClawNet Core deliver device control, threat visualization, and autonomous mitigation inside a unified console.',
  },
];

const AboutPage = () => {
  return (
    <div className="min-h-screen pt-28 pb-16 bg-cyber-black text-white overflow-hidden">
      {/* Hero */}
      <section className="relative">
        <div className="absolute inset-0 bg-gradient-to-b from-cyber-dark/70 via-cyber-black to-transparent" />
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
            className="space-y-6"
          >
            <span className="inline-flex items-center gap-2 px-4 py-1 rounded-full border border-cyber-blue/40 bg-cyber-blue/10 font-orbitron text-sm tracking-wider text-cyber-cyan uppercase">
              Built at PCTE • Deployed Worldwide
            </span>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-orbitron font-bold tracking-wide">
              The ClawNet Origin Story
            </h1>
            <p className="max-w-3xl mx-auto font-exo text-base sm:text-lg text-gray-400 leading-relaxed">
              What began as a perimeter defense assignment grew into a full-spectrum cyber intelligence platform.
              ClawNet is powered by the relentless curiosity of students, sharpened by the expertise of PCTE mentors,
              and hardened through missions with our partners across the globe.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Origin Blocks */}
      <section className="mt-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="cyber-card p-8 flex flex-col gap-4"
            >
              <div className="flex items-center gap-3">
                <Zap className="w-7 h-7 text-cyber-cyan" />
                <h2 className="font-orbitron text-2xl text-white">From Prototype to Platform</h2>
              </div>
              <p className="font-exo text-gray-300 leading-relaxed">
                The earliest ClawNet commits were written between lectures, stress-testing how fast a defender could detect and shut down lateral movement.
                What was meant to be a semester deliverable quickly earned its own Git repo, nightly scrums, and a cross-disciplinary crew of believers.
              </p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="cyber-card p-8 flex flex-col gap-4"
            >
              <div className="flex items-center gap-3">
                <Globe className="w-7 h-7 text-cyber-blue" />
                <h2 className="font-orbitron text-2xl text-white">Campus Crafted, Globally Deployed</h2>
              </div>
              <p className="font-exo text-gray-300 leading-relaxed">
                Faculty support transformed our runbooks into production-grade workflows. Today the same mindset powers deployments for partners across finance, education, and public infrastructure.
                The ClawNet grid still loops teachers into every major release for fearless feedback.
              </p>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Roots & Mentorship */}
      <section className="mt-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="cyber-card p-8 flex flex-col gap-6"
            >
              <div className="flex items-center gap-3">
                <BookOpen className="w-7 h-7 text-cyber-cyan" />
                <h2 className="font-orbitron text-2xl text-white">Roots at PCTE</h2>
              </div>
              <p className="font-exo text-gray-300 leading-relaxed">
                ClawNet was engineered inside the PCTE computer labs, where we rewired basic assignments into live-fire digital ranges.
                The team documented everything—from log pipelines to SOC rituals—so the platform could mature alongside the people running it.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-cyber-black/60 border border-cyber-blue/20 rounded-lg p-4 space-y-2">
                  <Cpu className="w-6 h-6 text-cyber-blue" />
                  <p className="font-orbitron text-sm uppercase tracking-wide text-cyber-cyan">Engineered Discipline</p>
                  <p className="font-exo text-xs text-gray-400">
                    Version-controlled lab work evolved into the infrastructure backbone shipping today.
                  </p>
                </div>
                <div className="bg-cyber-black/60 border border-cyber-blue/20 rounded-lg p-4 space-y-2">
                  <Globe className="w-6 h-6 text-cyber-cyan" />
                  <p className="font-orbitron text-sm uppercase tracking-wide text-cyber-cyan">Real-World Lens</p>
                  <p className="font-exo text-xs text-gray-400">
                    Early adopters across campus and partner firms offered the telemetry that still trains our models.
                  </p>
                </div>
                <div className="bg-cyber-black/60 border border-cyber-blue/20 rounded-lg p-4 space-y-2">
                  <Network className="w-6 h-6 text-cyber-blue" />
                  <p className="font-orbitron text-sm uppercase tracking-wide text-cyber-cyan">Collaborative Backbone</p>
                  <p className="font-exo text-xs text-gray-400">
                    Cross-disciplinary peers—from network ops to forensics—shaped the shared vocabulary ClawNet still uses.
                  </p>
                </div>
                <div className="bg-cyber-black/60 border border-cyber-blue/20 rounded-lg p-4 space-y-2">
                  <ShieldCheck className="w-6 h-6 text-cyber-cyan" />
                  <p className="font-orbitron text-sm uppercase tracking-wide text-cyber-cyan">Ethics First</p>
                  <p className="font-exo text-xs text-gray-400">
                    Faculty-led panels forced the platform to balance aggressive defense with responsible data stewardship.
                  </p>
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="cyber-card p-8 flex flex-col gap-6"
            >
              <div className="flex items-center gap-3">
                <Users className="w-7 h-7 text-cyber-blue" />
                <h2 className="font-orbitron text-2xl text-white">Mentor Council</h2>
              </div>
              <ul className="space-y-4">
                {storyHighlights.map((item, index) => (
                  <li key={index} className="relative pl-6 font-exo text-gray-300 leading-relaxed">
                    <span className="absolute left-0 top-2 w-2 h-2 rounded-full bg-cyber-cyan shadow-[0_0_10px_rgba(34,211,238,0.6)]" />
                    {item}
                  </li>
                ))}
              </ul>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-cyber-black/60 border border-cyber-blue/20 rounded-lg p-4 space-y-2">
                  <Shield className="w-6 h-6 text-cyber-blue" />
                  <p className="font-orbitron text-sm uppercase tracking-wide text-cyber-cyan">Governance Reviews</p>
                  <p className="font-exo text-xs text-gray-400">
                    Structured checkpoints ensure every release meets operational, legal, and ethical benchmarks.
                  </p>
                </div>
                <div className="bg-cyber-black/60 border border-cyber-blue/20 rounded-lg p-4 space-y-2">
                  <Zap className="w-6 h-6 text-cyber-blue" />
                  <p className="font-orbitron text-sm uppercase tracking-wide text-cyber-cyan">Rapid Experimentation</p>
                  <p className="font-exo text-xs text-gray-400">
                    Faculty-led sprints challenge us to prototype countermeasures before adversaries adapt.
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Community & Offerings */}
      <section className="mt-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="font-orbitron text-2xl md:text-3xl text-center text-white mb-10"
          >
            Community, Services & Tools
          </motion.h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {communityPillars.map((pillar, index) => (
              <motion.div
                key={pillar.title}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="cyber-card p-6 h-full flex flex-col gap-4 text-center md:text-left"
              >
                <div className="flex justify-center md:justify-start">
                  <pillar.icon className="w-8 h-8 text-cyber-cyan" />
                </div>
                <h3 className="font-orbitron text-lg text-white">{pillar.title}</h3>
                <p className="font-exo text-sm text-gray-300 leading-relaxed">{pillar.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Vision */}
      <section className="mt-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="cyber-card p-8 md:p-10 text-center space-y-4"
          >
            <div className="flex justify-center">
              <Shield className="w-10 h-10 text-cyber-cyan" />
            </div>
            <h2 className="font-orbitron text-3xl text-white">Our Mission</h2>
            <p className="font-exo text-lg text-gray-300 leading-relaxed">
              To redefine security through collective intelligence. We fuse automation, human judgment, and real-world attack
              telemetry so that organizations—large or small—can stay resilient in the face of relentless cyber threats.
            </p>
            <p className="font-orbitron text-sm uppercase tracking-[0.3em] text-cyber-blue">
              Intelligence • Resilience • Community
            </p>
          </motion.div>
        </div>
      </section>

      {/* Reviews */}
      <section className="mt-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="font-orbitron text-2xl md:text-3xl text-center text-white mb-10"
          >
            Voices From The Grid
          </motion.h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {reviews.map((review, index) => (
              <motion.div
                key={review.author}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                whileHover={{ y: -6, scale: 1.02 }}
                className="cyber-card p-6 h-full flex flex-col justify-between"
              >
                <p className="font-exo text-gray-300 leading-relaxed mb-4">{review.quote}</p>
                <div className="font-orbitron text-sm uppercase tracking-wider text-cyber-cyan">{review.author}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

export default AboutPage;

