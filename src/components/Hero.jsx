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
    <section id="home" className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden text-center px-4 pt-24 pb-12">
      <div className="absolute inset-0 bg-gradient-to-b from-cyber-black/0 via-cyber-black to-cyber-black z-10" />

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
            <h1 className="font-orbitron font-black text-6xl sm:text-7xl md:text-8xl lg:text-9xl tracking-tighter">
              <motion.span 
                className="block text-gray-500 text-2xl sm:text-3xl md:text-4xl lg:text-5xl tracking-[0.3em] mb-2"
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
          className="font-exo text-base sm:text-lg md:text-xl text-gray-300 max-w-2xl mx-auto mt-8"
        >
          We build autonomous cyber defense systems that learn, adapt, and neutralize threats before they strike.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.9, ease: [0.4, 0, 0.2, 1] }}
          className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-10"
        >
          <motion.a
            href="#tools"
            whileHover={{ 
              scale: 1.05, 
              boxShadow: '0 0 30px rgba(0, 224, 255, 0.6)',
              transition: { duration: 0.3 }
            }}
            whileTap={{ scale: 0.97 }}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker font-orbitron font-bold rounded-md transition-all duration-300"
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
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3 text-gray-300 font-orbitron font-bold rounded-md border-2 border-gray-600 transition-all duration-300"
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
        className="relative z-20 w-full max-w-5xl mx-auto mt-16 sm:mt-24"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
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
