import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Cpu, Zap, Globe } from 'lucide-react';

const BootText = ({ text, delay, showCursor = false }) => {
  const [displayedText, setDisplayedText] = useState('');
  const [showCursorState, setShowCursorState] = useState(true);

  useEffect(() => {
    if (text) {
      let index = 0;
      const timer = setTimeout(() => {
        const interval = setInterval(() => {
          if (index < text.length) {
            setDisplayedText(text.slice(0, index + 1));
            index++;
          } else {
            clearInterval(interval);
          }
        }, 10);
        return () => clearInterval(interval);
      }, delay * 1000);

      return () => clearTimeout(timer);
    }
  }, [text, delay]);

  useEffect(() => {
    if (showCursor) {
      const cursorInterval = setInterval(() => {
        setShowCursorState((prev) => !prev);
      }, 530);
      return () => clearInterval(cursorInterval);
    }
  }, [showCursor]);

  return (
    <motion.div
      className="flex items-start gap-3"
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay, ease: [0.25, 0.1, 0.25, 1] }}
    >
      <span className="text-cyber-blue/40 font-mono text-xs mt-0.5">▶</span>
      <div className="flex-1">
        <span className="font-mono text-xs sm:text-sm text-cyber-blue leading-relaxed">
          {displayedText}
        </span>
        {showCursor && showCursorState && (
          <motion.span 
            className="inline-block w-[2px] h-4 bg-cyber-blue ml-1 align-middle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, repeat: Infinity, repeatType: "reverse" }}
          />
        )}
      </div>
    </motion.div>
  );
};

const ProgressBar = ({ progress, delay, label }) => {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setWidth(progress);
    }, delay * 1000);
    return () => clearTimeout(timer);
  }, [progress, delay]);

  return (
    <div className="ml-6 mt-1.5 mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-cyber-blue/60 font-mono">{label || 'LOADING'}</span>
        <span className="text-xs text-cyber-blue/60 font-mono">{progress}%</span>
      </div>
      <div className="w-full h-1.5 bg-cyber-black/50 border border-cyber-blue/20 rounded-full overflow-hidden relative">
        <motion.div
          className="h-full bg-gradient-to-r from-cyber-blue via-cyber-cyan to-cyber-blue"
          initial={{ width: 0 }}
          animate={{ width: `${width}%` }}
          transition={{ duration: 0.6, delay: delay, ease: [0.4, 0, 0.2, 1] }}
        >
          <motion.div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent"
            animate={{ x: ['-100%', '100%'] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
          />
        </motion.div>
      </div>
    </div>
  );
};

const Scanlines = () => (
  <motion.div 
    className="absolute inset-0 pointer-events-none"
    animate={{ y: [0, 2, 0] }}
    transition={{ duration: 0.1, repeat: Infinity }}
    style={{
      background: 'repeating-linear-gradient(0deg, rgba(0, 224, 255, 0.03), rgba(0, 224, 255, 0.03) 1px, transparent 1px, transparent 2px)'
    }} 
  />
);

const Loader = () => {
  const bootSequence = [
    { 
      text: 'CLAWNET BIOS v3.14.159 INITIALIZED', 
      delay: 0.1,
      progress: null,
      icon: Shield
    },
    { 
      text: 'PERFORMING MEMORY CHECK...', 
      delay: 0.2,
      progress: 15,
      label: 'MEMORY'
    },
    { 
      text: 'MEMORY TEST: 16384 MB OK', 
      delay: 0.35,
      progress: null 
    },
    { 
      text: 'DETECTING HARDWARE COMPONENTS...', 
      delay: 0.45,
      progress: 30,
      label: 'HARDWARE',
      icon: Cpu
    },
    { 
      text: 'CPU: QUANTUM PROCESSOR DETECTED', 
      delay: 0.6,
      progress: null 
    },
    { 
      text: 'GPU: NEURAL ACCELERATOR ACTIVE', 
      delay: 0.7,
      progress: null 
    },
    { 
      text: 'LOADING KERNEL MODULES...', 
      delay: 0.8,
      progress: 55,
      label: 'KERNEL',
      icon: Zap
    },
    { 
      text: 'INITIALIZING NEURAL INTERFACE...', 
      delay: 0.95,
      progress: 70,
      label: 'NEURAL'
    },
    { 
      text: 'ESTABLISHING QUANTUM ENTANGLEMENT...', 
      delay: 1.1,
      progress: 85,
      label: 'QUANTUM',
      icon: Globe
    },
    { 
      text: 'DECRYPTING SECURITY PROTOCOLS...', 
      delay: 1.25,
      progress: 95,
      label: 'SECURITY'
    },
    { 
      text: 'SYSTEM READY', 
      delay: 1.4,
      progress: 100,
      label: 'COMPLETE',
      showCursor: true 
    },
  ];

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-cyber-black overflow-hidden"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
    >
      {/* Animated grid background */}
      <div 
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage: `
            linear-gradient(rgba(0, 224, 255, 0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 224, 255, 0.1) 1px, transparent 1px)
          `,
          backgroundSize: '50px 50px',
        }}
      />
      <motion.div
        className="absolute inset-0 opacity-5"
        animate={{
          backgroundPosition: ['0 0', '50px 50px'],
        }}
        transition={{
          duration: 20,
          repeat: Infinity,
          ease: 'linear',
        }}
        style={{
          backgroundImage: `
            linear-gradient(rgba(0, 224, 255, 0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 224, 255, 0.05) 1px, transparent 1px)
          `,
          backgroundSize: '50px 50px',
        }}
      />
      
      {/* Scanline effect */}
      <Scanlines />
      
      {/* Ambient glow effects */}
      <motion.div
        className="absolute inset-0 bg-gradient-to-b from-transparent via-cyber-blue/5 to-transparent pointer-events-none"
        animate={{ opacity: [0.1, 0.03, 0.1] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Main container */}
      <motion.div
        className="relative w-full max-w-3xl mx-4 font-mono"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2 }}
      >
        {/* Professional header */}
        <motion.div
          className="flex items-center justify-between mb-8 pb-4 border-b border-cyber-blue/20"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="flex items-center gap-4">
            <div>
              <h1 className="font-orbitron text-xl font-bold text-cyber-blue tracking-wider">
                CLAWNET SYSTEM
              </h1>
              <p className="text-xs text-cyber-blue/60 font-mono mt-0.5">BOOT SEQUENCE v3.14.159</p>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-cyber-blue/80 font-mono">{new Date().toLocaleDateString()}</div>
            <div className="text-xs text-cyber-blue/60 font-mono">{new Date().toLocaleTimeString()}</div>
          </div>
        </motion.div>

        {/* Boot sequence */}
        <div className="space-y-1 min-h-[400px]">
          {bootSequence.map((item, index) => (
            <div key={index}>
              <BootText 
                text={item.text} 
                delay={item.delay}
                showCursor={item.showCursor && index === bootSequence.length - 1}
              />
              {item.progress !== null && (
                <ProgressBar 
                  progress={item.progress} 
                  delay={item.delay + 0.15}
                  label={item.label}
                />
              )}
            </div>
          ))}
        </div>

        {/* Footer with system info */}
        <motion.div
          className="mt-8 pt-4 border-t border-cyber-blue/20"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.6, ease: 'easeOut' }}
        >
          <div className="flex justify-between items-center flex-wrap gap-4 text-xs">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-cyber-blue/80 font-mono">SYSTEM STATUS: OPERATIONAL</span>
              </div>
            </div>
            <div className="flex items-center gap-4 text-cyber-blue/60 font-mono">
              <span>UPTIME: 00:00:00</span>
              <span>•</span>
              <span>LOAD: 0.12</span>
            </div>
          </div>
        </motion.div>
      </motion.div>

      {/* Subtle glitch effect overlay */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        animate={{
          clipPath: [
            'inset(0% 0% 0% 0%)',
            'inset(5% 2% 95% 2%)',
            'inset(0% 0% 0% 0%)',
          ],
        }}
        transition={{
          duration: 0.08,
          repeat: Infinity,
          repeatDelay: 5,
          times: [0, 0.5, 1],
          ease: 'easeInOut',
        }}
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(0, 224, 255, 0.05), transparent)',
        }}
      />
    </motion.div>
  );
};

export default Loader;
