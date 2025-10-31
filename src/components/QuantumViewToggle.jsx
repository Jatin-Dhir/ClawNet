import React from 'react';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { useQuantumView } from '../contexts/QuantumViewContext';

const QuantumViewToggle = () => {
  const { isQuantumView, toggleQuantumView } = useQuantumView();
  const [isHovered, setIsHovered] = React.useState(false);

  // Hide button when inactive unless hovered
  const shouldShow = isQuantumView || isHovered;

  return (
    <motion.button
      onClick={(e) => {
        e.stopPropagation();
        toggleQuantumView();
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      animate={{
        opacity: shouldShow ? 1 : 0.3,
        scale: shouldShow ? 1 : 0.9,
      }}
      transition={{ duration: 0.3 }}
      style={{ cursor: 'pointer' }}
      className={`fixed top-20 md:top-24 right-4 md:right-6 z-50 p-2.5 md:p-3 rounded-lg border transition-all touch-manipulation min-w-[44px] min-h-[44px] flex items-center justify-center no-quantum-transform ${
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
          className={`${isQuantumView ? 'text-purple-400' : 'text-cyber-blue'} w-[18px] h-[18px] md:w-5 md:h-5`}
          size={18}
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

