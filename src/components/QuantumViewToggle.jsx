import React from 'react';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { useQuantumView } from '../contexts/QuantumViewContext';

const QuantumViewToggle = () => {
  const { isQuantumView, toggleQuantumView } = useQuantumView();

  return (
    <motion.button
      onClick={toggleQuantumView}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      className={`fixed top-24 right-6 z-40 p-3 rounded-lg border transition-all ${
        isQuantumView
          ? 'bg-gradient-to-br from-purple-500/20 to-cyan-500/20 border-purple-400/50 shadow-lg shadow-purple-500/30'
          : 'bg-cyber-gray/80 backdrop-blur-sm border-cyber-blue/30 hover:border-cyber-blue/60'
      }`}
      title={isQuantumView ? 'Exit Quantum View' : 'Enter Quantum View'}
    >
      <motion.div
        animate={{
          rotate: isQuantumView ? 360 : 0,
          scale: isQuantumView ? [1, 1.2, 1] : 1,
        }}
        transition={{
          rotate: { duration: 0.5 },
          scale: { duration: 0.3, repeat: isQuantumView ? Infinity : 0, repeatDelay: 1 },
        }}
      >
        <Sparkles
          className={isQuantumView ? 'text-purple-400' : 'text-cyber-blue'}
          size={20}
          strokeWidth={2}
        />
      </motion.div>
      
      {isQuantumView && (
        <motion.div
          initial={{ opacity: 0, scale: 0 }}
          animate={{
            opacity: 1,
            scale: 1,
            boxShadow: [
              '0 0 0 0 rgba(196, 132, 252, 0.7)',
              '0 0 0 10px rgba(196, 132, 252, 0)',
            ],
          }}
          exit={{ opacity: 0, scale: 0 }}
          className="absolute -top-1 -right-1 w-3 h-3 bg-purple-400 rounded-full"
          transition={{
            opacity: { duration: 0.3 },
            scale: { duration: 0.3 },
            boxShadow: {
              duration: 2,
              repeat: Infinity,
              ease: 'easeOut',
            },
          }}
        />
      )}
    </motion.button>
  );
};

export default QuantumViewToggle;

