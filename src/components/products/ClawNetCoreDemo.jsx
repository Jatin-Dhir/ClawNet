import React from 'react';
import { motion } from 'framer-motion';

const ClawNetCoreDemo = () => {
  const numNodes = 8;
  const radius = 80;

  const nodes = Array.from({ length: numNodes }).map((_, i) => {
    const angle = (i / numNodes) * 2 * Math.PI;
    return {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    };
  });

  return (
    <div className="w-full h-full flex items-center justify-center relative overflow-hidden">
      <motion.svg viewBox="-120 -120 240 240" className="w-full h-full">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g style={{ filter: 'url(#glow)' }}>
          {nodes.map((node, i) => (
            <motion.g key={i}>
              {nodes.map((otherNode, j) => {
                if (i >= j) return null;
                return (
                  <motion.line
                    key={`${i}-${j}`}
                    x1={node.x}
                    y1={node.y}
                    x2={otherNode.x}
                    y2={otherNode.y}
                    stroke="rgba(0, 224, 255, 0.2)"
                    strokeWidth="1"
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{
                      duration: 1,
                      repeat: Infinity,
                      repeatType: 'mirror',
                      delay: Math.random() * 2,
                    }}
                  />
                );
              })}
            </motion.g>
          ))}
          {nodes.map((node, i) => (
            <motion.circle
              key={i}
              cx={node.x}
              cy={node.y}
              r="5"
              fill="#00e0ff"
              animate={{
                scale: [1, 1.5, 1],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                delay: i * 0.2,
              }}
            />
          ))}
        </g>
      </motion.svg>
      <p className="absolute bottom-4 font-orbitron text-xs text-gray-500">Visualizing Mesh Network</p>
    </div>
  );
};

export default ClawNetCoreDemo;
