import React from 'react';
import { motion } from 'framer-motion';
import { HardDrive, AppWindow, Apple, Download, Clock } from 'lucide-react';

const PlatformIcon = ({ platform }) => {
  switch (platform) {
    case 'linux': return <HardDrive className="w-6 h-6" />;
    case 'windows': return <AppWindow className="w-6 h-6" />;
    case 'macos': return <Apple className="w-6 h-6" />;
    default: return null;
  }
};

const DownloadSection = ({ compatibility, toolName }) => {
  const platforms = ['linux', 'windows', 'macos'];

  return (
    <div className="mt-24 pt-12 border-t border-cyber-blue/20">
      <h2 className="section-title text-center mb-12">Download {toolName}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
        {platforms.map(platform => {
          const info = compatibility[platform];
          return (
            <div key={platform} className="cyber-card p-6 flex flex-col items-center text-center">
              <PlatformIcon platform={platform} />
              <h3 className="font-orbitron text-xl font-bold text-white mt-4 mb-2 capitalize">{platform}</h3>
              {info.available ? (
                <>
                  <p className="font-exo text-sm text-gray-400 mb-4">Version {info.version}</p>
                  <motion.button
                    whileHover={{ scale: 1.05, boxShadow: '0 0 20px rgba(0, 224, 255, 0.3)' }}
                    whileTap={{ scale: 0.95 }}
                    className="w-full mt-auto flex items-center justify-center gap-2 px-6 py-2 bg-cyber-blue/80 text-cyber-darker font-orbitron font-bold rounded-md transition-all duration-300 hover:bg-cyber-blue"
                  >
                    <Download size={18} />
                    Download
                  </motion.button>
                </>
              ) : info.comingSoon ? (
                <>
                  <p className="font-exo text-sm text-gray-400 mb-4">Not yet available</p>
                  <div className="w-full mt-auto flex items-center justify-center gap-2 px-6 py-2 bg-cyber-gray/50 text-cyber-cyan font-orbitron font-bold rounded-md cursor-not-allowed">
                    <Clock size={18} />
                    Coming Soon
                  </div>
                </>
              ) : (
                 <>
                  <p className="font-exo text-sm text-gray-400 mb-4">Not supported</p>
                  <div className="w-full mt-auto flex items-center justify-center gap-2 px-6 py-2 bg-cyber-gray/30 text-gray-600 font-orbitron font-bold rounded-md cursor-not-allowed">
                    Unavailable
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DownloadSection;
