import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

const SystemShutdown = ({ onComplete }) => {
  const [lines, setLines] = useState([]);
  const shutdownSequence = [
    '> Terminating user sessions...',
    '> Flushing system cache...',
    '> Closing network connections...',
    '> Saving system state...',
    '> Shutting down processes...',
    '> Unmounting filesystems...',
    '> Finalizing operations...',
    '',
    'ClawNet link terminated.',
  ];

  useEffect(() => {
    let currentLine = 0;
    const interval = setInterval(() => {
      if (currentLine < shutdownSequence.length) {
        setLines((prev) => [...prev, shutdownSequence[currentLine]]);
        currentLine++;
      } else {
        clearInterval(interval);
        setTimeout(() => {
          if (onComplete) onComplete();
        }, 2000);
      }
    }, 400);

    return () => clearInterval(interval);
  }, [onComplete]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] bg-cyber-black flex items-center justify-center"
    >
      <div className="font-mono text-cyber-blue max-w-2xl px-8">
        {lines.map((line, index) => (
          <motion.div
            key={index}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="mb-2"
            style={{ textShadow: '0 0 10px rgba(0, 224, 255, 0.5)' }}
          >
            {line || <br />}
          </motion.div>
        ))}
        {lines.length === shutdownSequence.length && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0] }}
            transition={{ duration: 1, repeat: Infinity }}
            className="mt-4 text-center text-cyber-cyan text-xl"
          >
            ▋
          </motion.div>
        )}
      </div>
      
      {/* Interface collapsing effect */}
      <motion.div
        initial={{ scale: 1, opacity: 1 }}
        animate={{ scale: 0.8, opacity: 0.5, y: 50 }}
        transition={{ duration: 2, delay: 1 }}
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(circle at center, transparent 0%, rgba(0, 0, 0, 0.8) 100%)',
        }}
      />
    </motion.div>
  );
};

export default SystemShutdown;

