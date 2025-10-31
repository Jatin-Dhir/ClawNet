import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const MatrixTransition = ({ onComplete }) => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(onComplete, 600);
    }, 800);

    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="fixed inset-0 z-[100] bg-cyber-black"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Sliding panels effect */}
          <div className="absolute inset-0 flex">
            {[...Array(5)].map((_, i) => (
              <motion.div
                key={i}
                className="flex-1 bg-gradient-to-b from-cyber-blue/20 via-cyber-cyan/20 to-transparent"
                initial={{ x: i % 2 === 0 ? '-100%' : '100%', opacity: 0 }}
                animate={{ x: '0%', opacity: 1 }}
                exit={{ x: i % 2 === 0 ? '100%' : '-100%', opacity: 0 }}
                transition={{ 
                  duration: 0.6, 
                  delay: i * 0.1,
                  ease: [0.4, 0, 0.2, 1]
                }}
              />
            ))}
          </div>

          {/* Center text */}
          <div className="absolute inset-0 flex items-center justify-center">
            <motion.div
              initial={{ scale: 0.5, opacity: 0, y: 50 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.5, opacity: 0, y: -50 }}
              transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
              className="text-center"
            >
              <motion.h1
                className="font-orbitron text-5xl md:text-6xl font-bold text-cyber-blue mb-4"
                animate={{ 
                  textShadow: [
                    '0 0 20px rgba(0, 224, 255, 0.5)',
                    '0 0 40px rgba(0, 224, 255, 0.8)',
                    '0 0 20px rgba(0, 224, 255, 0.5)'
                  ]
                }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                THE GRID
              </motion.h1>
              
              <motion.div
                className="h-1 w-48 mx-auto bg-cyber-blue"
                initial={{ width: 0 }}
                animate={{ width: 192 }}
                transition={{ duration: 0.8, delay: 0.2 }}
              />
            </motion.div>
          </div>

          {/* Corner accents */}
          <motion.div
            className="absolute top-0 left-0 w-32 h-32 border-t-2 border-l-2 border-cyber-blue"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4 }}
          />
          <motion.div
            className="absolute top-0 right-0 w-32 h-32 border-t-2 border-r-2 border-cyber-blue"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4 }}
          />
          <motion.div
            className="absolute bottom-0 left-0 w-32 h-32 border-b-2 border-l-2 border-cyber-blue"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4 }}
          />
          <motion.div
            className="absolute bottom-0 right-0 w-32 h-32 border-b-2 border-r-2 border-cyber-blue"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4 }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default MatrixTransition;
