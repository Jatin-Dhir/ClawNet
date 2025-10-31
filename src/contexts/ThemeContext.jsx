import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext({
  theme: 'neon-pulse',
  setTheme: () => {},
  mouseTrailEnabled: true,
  setMouseTrailEnabled: () => {},
});

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('clawnet-theme') || 'neon-pulse';
  });
  const [mouseTrailEnabled, setMouseTrailEnabled] = useState(() => {
    const saved = localStorage.getItem('clawnet-mouse-trail');
    return saved === null ? true : saved === 'true';
  });

  useEffect(() => {
    localStorage.setItem('clawnet-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    
    // Apply theme classes to body for immediate effect
    document.body.className = document.body.className.replace(/theme-\w+/g, '');
    document.body.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('clawnet-mouse-trail', mouseTrailEnabled.toString());
  }, [mouseTrailEnabled]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, mouseTrailEnabled, setMouseTrailEnabled }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    return { theme: 'neon-pulse', setTheme: () => {}, mouseTrailEnabled: true, setMouseTrailEnabled: () => {} };
  }
  return context;
};

