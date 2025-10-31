import React from 'react';
import { motion } from 'framer-motion';
import { Award, Zap, Brain, Rocket } from 'lucide-react';

const rankConfig = {
  bronze: {
    name: 'Bronze Circuit',
    color: '#cd7f32',
    icon: Award,
    glow: 'rgba(205, 127, 50, 0.5)',
    description: 'Entry-level contributor',
  },
  silver: {
    name: 'Silver Core',
    color: '#c0c0c0',
    icon: Zap,
    glow: 'rgba(192, 192, 192, 0.5)',
    description: 'Active member',
  },
  titanium: {
    name: 'Titanium Mind',
    color: '#878681',
    icon: Brain,
    glow: 'rgba(135, 134, 129, 0.5)',
    description: 'Advanced contributor',
  },
  quantum: {
    name: 'Quantum Node',
    color: '#00e0ff',
    icon: Rocket,
    glow: 'rgba(0, 224, 255, 0.5)',
    description: 'Elite innovator',
  },
};

const ClawRankBadge = ({ rank, size = 'medium', showTooltip = true }) => {
  const config = rankConfig[rank] || rankConfig.bronze;
  const Icon = config.icon;

  const sizes = {
    small: 'w-8 h-8',
    medium: 'w-12 h-12',
    large: 'w-16 h-16',
  };

  return (
    <motion.div
      className="relative inline-block"
      whileHover={{ scale: 1.1 }}
      animate={{
        boxShadow: [
          `0 0 10px ${config.glow}`,
          `0 0 20px ${config.glow}`,
          `0 0 10px ${config.glow}`,
        ],
      }}
      transition={{ duration: 2, repeat: Infinity }}
    >
      <div
        className={`${sizes[size]} rounded-full flex items-center justify-center border-2 relative overflow-hidden`}
        style={{
          borderColor: config.color,
          backgroundColor: `${config.color}20`,
        }}
      >
        <Icon size={size === 'small' ? 16 : size === 'medium' ? 24 : 32} style={{ color: config.color }} />
        
        {/* Pulse animation */}
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: config.color }}
          animate={{ opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      </div>

      {showTooltip && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileHover={{ opacity: 1, y: 0 }}
          className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-cyber-dark border border-cyber-blue/50 rounded-md text-xs whitespace-nowrap z-10"
        >
          <div className="font-orbitron text-white mb-1">{config.name}</div>
          <div className="text-gray-400">{config.description}</div>
        </motion.div>
      )}
    </motion.div>
  );
};

export default ClawRankBadge;

