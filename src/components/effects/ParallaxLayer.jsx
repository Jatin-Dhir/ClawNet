import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

const ParallaxLayer = ({ children, intensity = 0.02, className = '' }) => {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const ref = useRef(null);

  useEffect(() => {
    const handleMouseMove = (e) => {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const deltaX = (e.clientX - centerX) * intensity;
      const deltaY = (e.clientY - centerY) * intensity;
      setOffset({ x: deltaX, y: deltaY });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [intensity]);

  return (
    <motion.div
      ref={ref}
      animate={{ x: offset.x, y: offset.y }}
      transition={{ type: 'spring', stiffness: 100, damping: 30 }}
      className={className}
    >
      {children}
    </motion.div>
  );
};

export default ParallaxLayer;

