import React, { useEffect, useRef } from 'react';

const MouseTrail = ({ enabled = true }) => {
  const canvasRef = useRef(null);
  const trailRef = useRef([]);
  const animationFrameRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      trailRef.current = [];
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let lastX = 0;
    let lastY = 0;

    const updateCanvasSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    updateCanvasSize();
    window.addEventListener('resize', updateCanvasSize);

    const handleMouseMove = (e) => {
      const currentTime = Date.now();
      trailRef.current.push({
        x: e.clientX,
        y: e.clientY,
        time: currentTime,
      });

      // Keep only last 20 points
      if (trailRef.current.length > 20) {
        trailRef.current.shift();
      }

      lastX = e.clientX;
      lastY = e.clientY;
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const now = Date.now();
      const trail = trailRef.current.filter(point => now - point.time < 500);

      if (trail.length < 2) return;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 1; i < trail.length; i++) {
        const point = trail[i];
        const prevPoint = trail[i - 1];
        const age = now - point.time;
        const opacity = Math.max(0, 1 - age / 500);
        const width = 2 + (opacity * 2);

        // Get theme color from CSS variable
        const primaryColor = getComputedStyle(document.documentElement)
          .getPropertyValue('--theme-primary') || '#00e0ff';
        
        // Convert hex to rgb
        const hex = primaryColor.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);

        const gradient = ctx.createLinearGradient(
          prevPoint.x, prevPoint.y,
          point.x, point.y
        );
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${opacity * 0.8})`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${opacity * 0.3})`);
        
        ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.5)`;

        ctx.strokeStyle = gradient;
        ctx.lineWidth = width;
        ctx.shadowBlur = 10;

        ctx.beginPath();
        ctx.moveTo(prevPoint.x, prevPoint.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }

      ctx.shadowBlur = 0;
    };

    const animate = () => {
      draw();
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animate();

    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', updateCanvasSize);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-[9999]"
      style={{ mixBlendMode: 'screen' }}
    />
  );
};

export default MouseTrail;
