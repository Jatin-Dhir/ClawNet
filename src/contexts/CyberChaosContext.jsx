import React, { createContext, useContext, useState, useEffect } from 'react';

const CyberChaosContext = createContext({
  isActive: false,
  setIsActive: () => {},
  glitchPhase: 0,
});

export const CyberChaosProvider = ({ children }) => {
  const [isActive, setIsActive] = useState(false);
  const [glitchPhase, setGlitchPhase] = useState(0);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        setIsActive(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  useEffect(() => {
    if (isActive) {
      const interval = setInterval(() => {
        setGlitchPhase(prev => (prev + 1) % 100);
      }, 100);
      return () => clearInterval(interval);
    }
  }, [isActive]);

  return (
    <CyberChaosContext.Provider value={{ isActive, setIsActive, glitchPhase }}>
      <div className={isActive ? 'cyber-chaos-mode' : ''}>
        {children}
      </div>
    </CyberChaosContext.Provider>
  );
};

export const useCyberChaos = () => {
  const context = useContext(CyberChaosContext);
  if (!context) {
    // Fallback if context is not available
    return { isActive: false, setIsActive: () => {}, glitchPhase: 0 };
  }
  return context;
};

