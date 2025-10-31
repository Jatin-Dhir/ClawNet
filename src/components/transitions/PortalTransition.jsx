import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const PortalTransition = ({ onComplete }) => {
  const [isVisible, setIsVisible] = useState(true);
  const [scanComplete, setScanComplete] = useState(false);

  useEffect(() => {
    // Start scan animation
    const scanTimer = setTimeout(() => {
      setScanComplete(true);
    }, 600);

    // Complete transition
    const completeTimer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(() => {
        if (onComplete) onComplete();
      }, 300);
    }, 1000);

    return () => {
      clearTimeout(scanTimer);
      clearTimeout(completeTimer);
    };
  }, [onComplete]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="fixed inset-0 z-[9999] overflow-hidden bg-cyber-black"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Background grid pattern */}
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

          {/* Scanning line with glow effect */}
          <motion.div
            className="absolute left-0 right-0 h-1 z-50"
            initial={{ top: '0%' }}
            animate={{ top: scanComplete ? '100%' : '50%' }}
            transition={{
              duration: 0.6,
              ease: [0.4, 0, 0.2, 1],
            }}
          >
            {/* Main scan line */}
            <div className="relative h-full w-full">
              {/* Glow trail */}
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-cyber-blue to-transparent"
                animate={{
                  boxShadow: [
                    '0 0 20px rgba(0, 224, 255, 0.8), 0 0 40px rgba(0, 224, 255, 0.6)',
                    '0 0 30px rgba(0, 224, 255, 1), 0 0 60px rgba(0, 224, 255, 0.8)',
                    '0 0 20px rgba(0, 224, 255, 0.8), 0 0 40px rgba(0, 224, 255, 0.6)',
                  ],
                }}
                transition={{ duration: 0.5, repeat: Infinity }}
              />
              
              {/* Core bright line */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-cyber-cyan to-transparent" />
              
              {/* Secondary glow layers */}
              <div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-cyber-blue/50 to-transparent blur-sm"
                style={{ transform: 'scaleY(2)' }}
              />
            </div>

            {/* Scan indicators */}
            <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 border-2 border-cyber-blue bg-cyber-blue/20" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 border-2 border-cyber-blue bg-cyber-blue/20" />
          </motion.div>

          {/* Data particles trailing the scan */}
          <AnimatePresence>
            {!scanComplete && (
              <>
                {[...Array(30)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="absolute font-mono text-xs text-cyber-blue/60"
                    initial={{
                      x: Math.random() * window.innerWidth,
                      y: window.innerHeight * 0.5,
                      opacity: 0,
                    }}
                    animate={{
                      y: window.innerHeight * 0.5,
                      opacity: [0, 1, 0],
                    }}
                    transition={{
                      duration: 0.3,
                      delay: i * 0.02,
                      repeat: Infinity,
                      repeatDelay: 0.5,
                    }}
                  >
                    {Math.random().toString(2).substring(2, 8)}
                  </motion.div>
                ))}
              </>
            )}
          </AnimatePresence>

          {/* Page fade in after scan */}
          <motion.div
            className="absolute inset-0 bg-cyber-black"
            initial={{ opacity: 1 }}
            animate={{ opacity: scanComplete ? 0 : 1 }}
            transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default PortalTransition;
