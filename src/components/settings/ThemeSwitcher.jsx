import React from 'react';
import { motion } from 'framer-motion';
import { Settings, Palette, MousePointer } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

const ThemeSwitcher = () => {
  const [isOpen, setIsOpen] = React.useState(false);
  const { theme, setTheme, mouseTrailEnabled, setMouseTrailEnabled } = useTheme();

  const themes = [
    { id: 'neon-pulse', name: 'Neon Pulse', desc: 'Default purple/blue', gradient: 'from-purple-600 via-indigo-600 to-blue-600' },
    { id: 'light-mode', name: 'Light Mode', desc: 'Clean bright theme', gradient: 'from-blue-50 via-cyan-50 to-white' },
    { id: 'halloween', name: 'Halloween', desc: 'Spooky dark theme', gradient: 'from-orange-900 via-red-900 to-black' },
  ];

  return (
    <>
      <motion.button
        onClick={() => setIsOpen(true)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="fixed bottom-6 left-6 z-40 p-3 bg-cyber-gray/80 backdrop-blur-sm border border-cyber-blue/30 rounded-lg hover:border-cyber-blue/60 transition-colors"
        title="Settings"
      >
        <Settings className="text-cyber-blue" size={20} strokeWidth={2} />
      </motion.button>

      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9998] bg-cyber-black/90 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setIsOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="cyber-card p-8 max-w-2xl w-full border-2 border-cyber-blue/30 shadow-2xl"
          >
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-orbitron text-2xl text-white flex items-center gap-2">
                <Settings size={24} className="text-cyber-blue" />
                ClawNet OS Settings
              </h2>
              <motion.button
                onClick={() => setIsOpen(false)}
                whileHover={{ scale: 1.1, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-cyber-gray/50 rounded-lg"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </motion.button>
            </div>

            <div className="space-y-8">
              {/* Theme Selection */}
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <Palette size={18} className="text-cyber-blue" />
                  <h3 className="font-orbitron text-lg text-white">Theme Switcher</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {themes.map((t) => (
                    <motion.button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      whileHover={{ scale: 1.05, y: -5 }}
                      whileTap={{ scale: 0.95 }}
                      className={`p-4 rounded-lg border-2 transition-all ${
                        theme === t.id
                          ? 'border-cyber-blue bg-cyber-blue/20 shadow-lg shadow-cyber-blue/30'
                          : 'border-cyber-gray/50 bg-cyber-gray/20 hover:border-cyber-blue/50'
                      }`}
                    >
                      <div className={`w-full h-20 rounded mb-3 bg-gradient-to-br ${t.gradient}`} />
                      <h4 className="font-orbitron text-white mb-1">{t.name}</h4>
                      <p className="text-xs text-gray-400">{t.desc}</p>
                      {theme === t.id && (
                        <motion.div
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          className="mt-2 text-center text-cyber-blue text-sm font-bold flex items-center justify-center gap-1"
                        >
                          <span>●</span> Active
                        </motion.div>
                      )}
                    </motion.button>
                  ))}
                </div>
              </div>

              {/* Mouse Trail Toggle */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MousePointer size={18} className="text-cyber-blue" />
                    <div>
                      <h3 className="font-orbitron text-lg text-white">Mouse Trail Effect</h3>
                      <p className="text-sm text-gray-400">Smooth fluid line follows cursor</p>
                    </div>
                  </div>
                  <motion.button
                    onClick={() => setMouseTrailEnabled(!mouseTrailEnabled)}
                    whileTap={{ scale: 0.95 }}
                    className={`relative w-16 h-8 rounded-full transition-colors ${
                      mouseTrailEnabled ? 'bg-cyber-blue' : 'bg-gray-600'
                    }`}
                  >
                    <motion.div
                      animate={{ x: mouseTrailEnabled ? 32 : 4 }}
                      className="absolute top-1 left-1 w-6 h-6 bg-white rounded-full"
                    />
                  </motion.button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </>
  );
};

export default ThemeSwitcher;

