import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, BrainCircuit, Crosshair, Ghost, Cog, UserPlus } from 'lucide-react';

const Hero = ({ onJoinClick }) => {
  const coreValues = [
    { name: 'INNOVATION', icon: BrainCircuit },
    { name: 'PRECISION', icon: Crosshair },
    { name: 'STEALTH', icon: Ghost },
    { name: 'AUTOMATION', icon: Cog },
  ];

  return (
    <section id="home" className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden text-center px-4 pt-24 pb-16 sm:pt-28 sm:pb-20">
      <div className="absolute inset-0 bg-gradient-to-b from-cyber-black/0 via-cyber-black to-cyber-black z-10" />
      <div className="absolute inset-0 z-10 pointer-events-none">
        <svg
          viewBox="0 0 600 600"
          className="absolute left-1/2 top-1/2 hidden translate-x-[-50%] translate-y-[-50%] sm:block w-[520px] opacity-30"
        >
          <defs>
            <radialGradient id="heroGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(34,211,238,0.55)" />
              <stop offset="100%" stopColor="rgba(34,211,238,0)" />
            </radialGradient>
          </defs>
          <circle cx="300" cy="300" r="260" fill="url(#heroGlow)" />
          {[80, 140, 200, 260].map((radius) => (
            <circle key={radius} cx="300" cy="300" r={radius} stroke="rgba(148, 163, 184, 0.1)" strokeWidth="1" fill="none" />
          ))}
          {[...Array(6)].map((_, idx) => {
            const angle = (Math.PI * 2 * idx) / 6;
            const x = 300 + Math.cos(angle) * 260;
            const y = 300 + Math.sin(angle) * 260;
            return <line key={idx} x1="300" y1="300" x2={x} y2={y} stroke="rgba(148, 163, 184, 0.08)" strokeWidth="1" />;
          })}
        </svg>
        <div className="absolute inset-0 sm:hidden">
          <div className="absolute inset-x-10 top-1/4 h-40 rounded-full bg-cyber-blue/20 blur-3xl opacity-50" />
        </div>
      </div>

      <div className="relative z-20 flex flex-col items-center justify-center flex-grow">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.4, 0, 0.2, 1] }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <h1 className="font-orbitron font-black text-5xl sm:text-7xl md:text-8xl lg:text-9xl leading-[0.95] sm:leading-tight tracking-tight sm:tracking-tighter">
              <motion.span 
                className="block text-gray-500 text-xl sm:text-3xl md:text-4xl lg:text-5xl tracking-[0.18em] sm:tracking-[0.3em] mb-2 sm:mb-3"
                initial={{ opacity: 0, x: -30 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.8, delay: 0.3 }}
              >
                REDEFINE
              </motion.span>
              <motion.span 
                className="bg-gradient-to-r from-cyber-blue via-cyber-cyan to-white bg-clip-text text-transparent"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8, delay: 0.5 }}
              >
                SECURITY
              </motion.span>
            </h1>
          </motion.div>
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.7, ease: [0.4, 0, 0.2, 1] }}
          className="font-exo text-base sm:text-lg md:text-xl text-gray-300 max-w-2xl mx-auto mt-6 sm:mt-8 px-2 sm:px-0 leading-relaxed"
        >
          We build autonomous cyber defense systems that learn, adapt, and neutralize threats before they strike.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.9, ease: [0.4, 0, 0.2, 1] }}
          className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 mt-8 sm:mt-10 w-full px-2 sm:px-0"
        >
          <motion.a
            href="#tools"
            whileHover={{ 
              scale: 1.05, 
              boxShadow: '0 0 30px rgba(0, 224, 255, 0.6)',
              transition: { duration: 0.3 }
            }}
            whileTap={{ scale: 0.97 }}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-7 sm:px-8 py-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker font-orbitron font-bold rounded-md transition-all duration-300 shadow-lg shadow-cyber-blue/20 focus:outline-none focus:ring-2 focus:ring-cyber-cyan focus:ring-offset-2 focus:ring-offset-cyber-black"
            onClick={(e) => {
              e.preventDefault();
              document.querySelector('#tools')?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            Explore The Tech
            <motion.div
              animate={{ x: [0, 5, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            >
              <ArrowRight size={20} />
            </motion.div>
          </motion.a>

          <motion.button
            onClick={onJoinClick}
            whileHover={{ 
              scale: 1.05, 
              color: '#FFFFFF', 
              borderColor: '#FFFFFF',
              boxShadow: '0 0 20px rgba(255, 255, 255, 0.3)',
              transition: { duration: 0.3 }
            }}
            whileTap={{ scale: 0.97 }}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-7 sm:px-8 py-3 text-gray-300 font-orbitron font-bold rounded-md border-2 border-gray-600 transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-white/30 focus:ring-offset-2 focus:ring-offset-cyber-black"
          >
            <UserPlus size={20} />
            Join Community
          </motion.button>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 1.1, ease: [0.4, 0, 0.2, 1] }}
        className="relative z-20 w-full max-w-5xl mx-auto mt-12 sm:mt-20 px-4 sm:px-0"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 sm:gap-8">
          {coreValues.map((value, index) => (
            <motion.div 
              key={value.name} 
              className="flex flex-col items-center gap-3"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 1.2 + index * 0.1, ease: [0.4, 0, 0.2, 1] }}
              whileHover={{ 
                y: -5,
                scale: 1.1,
                transition: { duration: 0.3 }
              }}
            >
              <motion.div
                whileHover={{ 
                  rotate: 360,
                  scale: 1.2,
                  transition: { duration: 0.5 }
                }}
              >
                <value.icon className="w-8 h-8 text-cyber-blue" strokeWidth={1.5} />
              </motion.div>
              <p className="font-orbitron text-sm font-semibold text-gray-400 tracking-widest">{value.name}</p>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </section>
  );
};

export default Hero;
