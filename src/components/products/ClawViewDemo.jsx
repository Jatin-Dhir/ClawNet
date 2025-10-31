import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Shield, Laptop } from 'lucide-react';

const ClawViewDemo = () => {
  const numParticles = 15;
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div 
      className="w-full h-full flex items-center justify-center relative overflow-hidden cursor-pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <motion.div
        animate={{ scale: isHovered ? [1, 1.1, 1] : [1, 1.05, 1] }}
        transition={{ duration: isHovered ? 1.5 : 3, repeat: Infinity }}
      >
        <Shield 
          className="w-24 h-24 text-cyber-blue" 
          style={{ filter: isHovered ? 'drop-shadow(0 0 15px #00e0ff)' : 'none', transition: 'filter 0.3s ease-in-out' }}
        />
        <Laptop className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 text-white" />
      </motion.div>

      {Array.from({ length: numParticles }).map((_, i) => {
        const isMalicious = Math.random() > 0.8;
        const angle = Math.random() * Math.PI * 2;
        const radius = 120;
        const startX = Math.cos(angle) * radius;
        const startY = Math.sin(angle) * radius;
        const duration = Math.random() * 2 + 2;
        const delay = Math.random() * 3;

        const endX = isMalicious ? startX * (isHovered ? 0.6 : 0.4) : 0;
        const endY = isMalicious ? startY * (isHovered ? 0.6 : 0.4) : 0;

        return (
          <motion.div
            key={i}
            className={`absolute w-1.5 h-1.5 rounded-full ${isMalicious ? 'bg-red-500' : 'bg-green-400'}`}
            style={{
              boxShadow: `0 0 5px ${isMalicious ? 'red' : 'green'}`,
            }}
            initial={{ x: startX, y: startY, opacity: 0 }}
            animate={{
              x: endX,
              y: endY,
              opacity: [0, 1, 1, 0],
            }}
            transition={{
              duration,
              delay,
              repeat: Infinity,
              ease: 'linear',
            }}
          />
        );
      })}
      <p className="absolute bottom-4 font-orbitron text-xs text-gray-500">Visualizing Threat Monitoring</p>
    </div>
  );
};

export default ClawViewDemo;
