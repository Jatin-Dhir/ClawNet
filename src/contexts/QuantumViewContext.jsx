import React, { createContext, useContext, useState, useEffect } from 'react';

const QuantumViewContext = createContext({
  isQuantumView: false,
  toggleQuantumView: () => {},
});

export const QuantumViewProvider = ({ children }) => {
  const [isQuantumView, setIsQuantumView] = useState(() => {
    return localStorage.getItem('clawnet-quantum-view') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('clawnet-quantum-view', isQuantumView.toString());
    if (isQuantumView) {
      document.body.classList.add('quantum-view-active');
    } else {
      document.body.classList.remove('quantum-view-active');
    }
  }, [isQuantumView]);

  const toggleQuantumView = () => {
    setIsQuantumView((prev) => !prev);
  };

  return (
    <QuantumViewContext.Provider value={{ isQuantumView, toggleQuantumView }}>
      {children}
    </QuantumViewContext.Provider>
  );
};

export const useQuantumView = () => {
  const context = useContext(QuantumViewContext);
  if (!context) {
    return { isQuantumView: false, toggleQuantumView: () => {} };
  }
  return context;
};

