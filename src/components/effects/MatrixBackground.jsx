import React, { useEffect, useRef } from 'react';

const MatrixBackground = () => {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const chars = '01アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
    const fontSize = 18;
    let columns = Math.floor(window.innerWidth / fontSize);
    let drops = Array.from({ length: columns }, () => ({
      y: Math.floor(Math.random() * -1000),
      speed: Math.random() * 0.4 + 0.2,
    }));

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      columns = Math.floor(window.innerWidth / fontSize);
      drops = Array.from({ length: columns }, () => ({
        y: Math.floor(Math.random() * -1000),
        speed: Math.random() * 0.4 + 0.2,
      }));
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const draw = () => {
      // Smooth fade effect
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Set font
      ctx.font = `${fontSize}px monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      for (let i = 0; i < drops.length; i++) {
        const drop = drops[i];
        const x = i * fontSize;
        const y = drop.y * fontSize;
        
        // Draw character if on screen
        if (y > -fontSize && y < canvas.height) {
          // Subtle opacity variation
          const opacity = 0.25 + Math.sin(y * 0.01) * 0.05;
          
          ctx.fillStyle = `rgba(0, 224, 255, ${opacity})`;
          ctx.shadowBlur = 0;
          
          // Random character
          const text = chars[Math.floor(Math.random() * chars.length)];
          ctx.fillText(text, x, y);
        }

        // Reset drop when it goes off screen
        if (y > canvas.height && Math.random() > 0.98) {
          drop.y = Math.random() * -300;
          drop.speed = Math.random() * 0.4 + 0.2;
        }

        // Move drop down
        drop.y += drop.speed;
      }
    };

    const animate = () => {
      draw();
      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <>
      {/* Matrix Canvas - Clean Animated */}
      <canvas
        ref={canvasRef}
        className="fixed inset-0 pointer-events-none z-0"
        style={{ 
          opacity: 0.5,
        }}
      />

      {/* Subtle grid overlay */}
      <div 
        className="fixed inset-0 pointer-events-none z-0 opacity-[0.02]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(0, 224, 255, 0.5) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 224, 255, 0.5) 1px, transparent 1px)
          `,
          backgroundSize: '100px 100px',
        }}
      />
    </>
  );
};

export default MatrixBackground;
