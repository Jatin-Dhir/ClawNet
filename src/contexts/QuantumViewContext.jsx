import React, { createContext, useContext, useState, useEffect } from 'react';

const QuantumViewContext = createContext({
  isQuantumView: false,
  toggleQuantumView: () => {},
  tiltX: 0,
  tiltY: 0,
});

export const QuantumViewProvider = ({ children }) => {
  const [isQuantumView, setIsQuantumView] = useState(() => {
    // Default to false - don't read from localStorage on init
    return false;
  });
  
  useEffect(() => {
    try {
      localStorage.setItem('clawnet-quantum-view', isQuantumView.toString());
    } catch (e) {
      console.error('Failed to save quantum view state:', e);
    }
    
    if (isQuantumView) {
      // Force animation restart by temporarily removing and re-adding the class
      const wasAlreadyActive = document.body.classList.contains('quantum-view-active');
      if (wasAlreadyActive) {
        document.documentElement.classList.remove('quantum-view-active');
        document.body.classList.remove('quantum-view-active');
        void document.body.offsetHeight;
      }
      
      document.documentElement.classList.add('quantum-view-active');
      document.body.classList.add('quantum-view-active');
      
      // Detect if device is mobile/touch device
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                      ('ontouchstart' in window) || 
                      (navigator.maxTouchPoints > 0);
      
      let rafId = null;
      let cleanupFn = null;
      
      // Track current cursor/gyro position (captured in closures)
      let currentCursorX = window.innerWidth / 2;
      let currentCursorY = window.innerHeight / 2;
      let currentTiltX = 0;
      let currentTiltY = 0;
      
      const apply3DTransforms = () => {
        try {
          const elements = document.querySelectorAll('.cyber-card, h1, h2, h3, h4, h5, h6, section > *, main > *, article, .card');
          
          elements.forEach((el) => {
            if (!(el instanceof HTMLElement)) return;
            
            // Skip fixed positioned elements
            const style = window.getComputedStyle(el);
            if (style.position === 'fixed') return;
            
            // Skip navigation and header/footer
            if (el.closest('nav, header, footer')) return;
            
            // Skip background elements
            if (el.closest('[class*="Particle"], canvas, .bg-cyber-black, .bg-cyber-dark')) return;
            if (el.id === 'particle-canvas' || el.classList.contains('particle-background')) return;
            
            // Skip elements marked to not transform
            if (el.closest('.no-quantum-transform') || el.classList.contains('no-quantum-transform')) return;
            
            // Skip if element IS a button, link, or input itself
            if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
            
            // Skip if element contains interactive children (let children handle their own events)
            if (el.querySelector('button, a, input, select, textarea, [role="button"]')) {
              // Still transform the container, but ensure children remain clickable
            }
            
            const rect = el.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            let rotateX = 0;
            let rotateY = 0;
            let translateZ = 0;
            
            if (isMobile) {
              // Gyroscope-based tilt - each element responds to device orientation
              rotateX = currentTiltY * 0.6;
              rotateY = -currentTiltX * 0.6;
              translateZ = (Math.abs(currentTiltX) + Math.abs(currentTiltY)) * 0.8;
            } else {
              // Mouse-based tilt - each element responds to cursor position
              const deltaX = (currentCursorX - centerX) / window.innerWidth;
              const deltaY = (currentCursorY - centerY) / window.innerHeight;
              const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
              
              // Calculate tilt based on distance from cursor (closer = more tilt)
              const maxTilt = 10; // Max rotation in degrees
              const influence = 1 - Math.min(distance * 1.2, 1);
              rotateX = -deltaY * maxTilt * influence;
              rotateY = deltaX * maxTilt * influence;
              translateZ = influence * 25; // Float effect up to 25px
            }
            
            // Apply transform with minimal translateZ to avoid breaking click events
            // Use transform3d for hardware acceleration but keep Z minimal
            const maxZ = 15; // Reduced max Z to prevent stacking issues
            const safeTranslateZ = Math.min(translateZ, maxZ);
            
            el.style.transform = `translate3d(0, 0, ${safeTranslateZ}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
            el.style.transformStyle = 'preserve-3d';
            el.style.pointerEvents = 'auto';
            el.style.willChange = 'transform';
            el.style.backfaceVisibility = 'hidden';
            // Ensure the element can receive clicks
            el.style.touchAction = 'auto';
          });
        } catch (error) {
          console.error('Error applying 3D transforms:', error);
        }
      };
      
      if (isMobile) {
        // Gyroscope/Device Orientation for mobile
        const handleDeviceOrientation = (e) => {
          const beta = e.beta || 0;
          const gamma = e.gamma || 0;
          
          const maxTilt = 25;
          currentTiltX = Math.max(-maxTilt, Math.min(maxTilt, gamma * 0.6));
          currentTiltY = Math.max(-maxTilt, Math.min(maxTilt, (beta - 45) * 0.5));
          
          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(apply3DTransforms);
        };
        
        if (typeof DeviceOrientationEvent !== 'undefined' && 
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          DeviceOrientationEvent.requestPermission()
            .then(response => {
              if (response === 'granted') {
                window.addEventListener('deviceorientation', handleDeviceOrientation);
              }
            })
            .catch(console.error);
        } else {
          window.addEventListener('deviceorientation', handleDeviceOrientation);
        }
        
        cleanupFn = () => {
          if (rafId) cancelAnimationFrame(rafId);
          window.removeEventListener('deviceorientation', handleDeviceOrientation);
        };
      } else {
        // Mouse movement for desktop
        const handleMouseMove = (e) => {
          currentCursorX = e.clientX;
          currentCursorY = e.clientY;
          
          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(apply3DTransforms);
        };
        
        window.addEventListener('mousemove', handleMouseMove);
        
        cleanupFn = () => {
          if (rafId) cancelAnimationFrame(rafId);
          window.removeEventListener('mousemove', handleMouseMove);
        };
        
        // Initial cursor position at center
        currentCursorX = window.innerWidth / 2;
        currentCursorY = window.innerHeight / 2;
      }
      
      // Initial apply after a small delay to ensure DOM is ready
      setTimeout(() => {
        requestAnimationFrame(apply3DTransforms);
      }, 100);
      
      return () => {
        if (cleanupFn) cleanupFn();
        // Reset all transforms and styles
        const elements = document.querySelectorAll('.cyber-card, h1, h2, h3, h4, h5, h6, section > *, main > *, article, .card, button, a');
        elements.forEach((el) => {
          if (el instanceof HTMLElement) {
            el.style.transform = '';
            el.style.pointerEvents = '';
            el.style.willChange = '';
          }
        });
      };
    } else {
      document.documentElement.classList.remove('quantum-view-active');
      document.body.classList.remove('quantum-view-active');
      // Reset all transforms and styles
      const elements = document.querySelectorAll('.cyber-card, h1, h2, h3, h4, h5, h6, section > *, main > *, article, .card, button, a');
      elements.forEach((el) => {
        if (el instanceof HTMLElement) {
          el.style.transform = '';
          el.style.pointerEvents = '';
          el.style.willChange = '';
        }
      });
    }
  }, [isQuantumView]);

  const toggleQuantumView = () => {
    setIsQuantumView((prev) => !prev);
  };

  return (
    <QuantumViewContext.Provider value={{ isQuantumView, toggleQuantumView, tiltX: 0, tiltY: 0 }}>
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

