import React from 'react';
import { motion } from 'framer-motion';
import { Laptop, Usb, ShieldCheck, KeyRound } from 'lucide-react';

const BlinkingCursor = () => (
  <motion.div
    className="w-0.5 h-5 bg-cyber-cyan"
    animate={{ opacity: [0, 1, 0] }}
    transition={{ duration: 1, repeat: Infinity }}
  />
);

const PortlockDemo = () => {
  return (
    <div className="w-full h-full flex items-center justify-center relative overflow-hidden p-4">
      <div className="relative">
        <Laptop className="w-56 h-56 text-cyber-blue/30" />
        <motion.div
          className="absolute"
          style={{ top: '50%', left: '50%', x: '-50%', y: '-50%' }}
          animate={{
            opacity: [0, 0, 1, 1, 0, 0],
            scale: [0.8, 0.8, 1, 1, 0.8, 0.8]
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            times: [0, 0.3, 0.4, 0.7, 0.8, 1]
          }}
        >
          <div className="w-40 h-24 bg-cyber-black/80 backdrop-blur-sm rounded-lg border border-cyber-blue/50 flex flex-col items-center justify-center p-2">
            <ShieldCheck className="w-6 h-6 text-cyber-blue mb-2" />
            <p className="font-orbitron text-xs text-white mb-2">PortLock Auth</p>
            <div className="w-full h-8 bg-cyber-gray flex items-center justify-between px-2 rounded-sm">
              <div className="flex items-center gap-2">
                <KeyRound size={14} className="text-gray-500" />
                <span className="text-gray-400 font-mono text-sm">••••</span>
              </div>
              <BlinkingCursor />
            </div>
          </div>
        </motion.div>
        
        <motion.div
          className="absolute"
          style={{ top: '50%', left: '50%', x: '-50%', y: '-50%' }}
          animate={{
            opacity: [0, 0, 0, 0, 1, 1, 0],
            scale: [0.8, 0.8, 0.8, 0.8, 1, 1, 0.8]
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            times: [0, 0.75, 0.75, 0.8, 0.85, 0.95, 1]
          }}
        >
          <ShieldCheck className="w-16 h-16 text-green-400" style={{ filter: 'drop-shadow(0 0 10px #0f0)' }} />
        </motion.div>

      </div>

      <motion.div
        className="absolute"
        style={{ top: '50%', y: '-50%', left: -60 }}
        animate={{
          x: [0, 140, 140, 0],
          opacity: [1, 1, 0, 0]
        }}
        transition={{
          duration: 8,
          repeat: Infinity,
          times: [0, 0.3, 0.7, 1]
        }}
      >
        <Usb className="w-12 h-12 text-cyber-cyan" />
      </motion.div>

      <p className="absolute bottom-4 font-orbitron text-xs text-gray-500">Visualizing USB Authentication</p>
    </div>
  );
};

export default PortlockDemo;
