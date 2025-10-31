import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '../../supabaseClient';
import { useAuth } from '../../contexts/AuthContext';

const GridActivityMap = () => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [nodes, setNodes] = useState([]);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [connections, setConnections] = useState([]);
  const { session } = useAuth();
  const animationFrameRef = useRef(null);
  const mousePosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    fetchActivityData();
    const subscription = supabase
      .channel('grid-activity')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, () => {
        fetchActivityData();
      })
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const fetchActivityData = async () => {
    const { data: posts } = await supabase.from('posts').select('id, title, category, user_id, created_at').limit(50);
    const { data: profiles } = await supabase.from('profiles').select('id, username').limit(30);

    const newNodes = [];
    if (posts) {
      posts.forEach((post, index) => {
        newNodes.push({
          id: `post-${post.id}`,
          type: 'post',
          label: post.title,
          category: post.category,
          x: Math.random() * 800 + 100,
          y: Math.random() * 600 + 100,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          pulsePhase: Math.random() * Math.PI * 2,
          lastActivity: new Date(post.created_at).getTime(),
        });
      });
    }
    if (profiles) {
      profiles.forEach((profile, index) => {
        newNodes.push({
          id: `user-${profile.id}`,
          type: 'user',
          label: profile.username,
          x: Math.random() * 800 + 100,
          y: Math.random() * 600 + 100,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          pulsePhase: Math.random() * Math.PI * 2,
          lastActivity: Date.now() - Math.random() * 60000,
        });
      });
    }

    setNodes(newNodes);
    generateConnections(newNodes);
  };

  const generateConnections = (nodeList) => {
    const newConnections = [];
    nodeList.forEach((node, i) => {
      if (i < nodeList.length - 1) {
        const nextNode = nodeList[i + 1];
        if (Math.random() > 0.7) {
          newConnections.push({
            from: node.id,
            to: nextNode.id,
            strength: Math.random(),
          });
        }
      }
    });
    setConnections(newConnections);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;

    const ctx = canvas.getContext('2d');
    let animationId;

    const resizeCanvas = () => {
      const container = containerRef.current;
      if (container) {
        canvas.width = container.offsetWidth;
        canvas.height = Math.max(600, container.offsetHeight || 600);
      }
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const draw = (timestamp) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Update node positions (simple physics)
      setNodes(prevNodes => 
        prevNodes.map(node => {
          let newX = node.x + node.vx;
          let newY = node.y + node.vy;

          if (newX < 50 || newX > canvas.width - 50) node.vx *= -1;
          if (newY < 50 || newY > canvas.height - 50) node.vy *= -1;

          newX = Math.max(50, Math.min(canvas.width - 50, newX));
          newY = Math.max(50, Math.min(canvas.height - 50, newY));

          return {
            ...node,
            x: newX,
            y: newY,
            pulsePhase: node.pulsePhase + 0.05,
          };
        })
      );

      // Draw connections
      connections.forEach(conn => {
        const fromNode = nodes.find(n => n.id === conn.from);
        const toNode = nodes.find(n => n.id === conn.to);
        if (fromNode && toNode) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(0, 224, 255, ${0.2 * conn.strength})`;
          ctx.lineWidth = 1;
          ctx.moveTo(fromNode.x, fromNode.y);
          ctx.lineTo(toNode.x, toNode.y);
          ctx.stroke();
        }
      });

      // Draw nodes
      nodes.forEach(node => {
        const isActive = Date.now() - node.lastActivity < 30000;
        const pulse = Math.sin(node.pulsePhase) * 0.3 + 1;
        const size = isActive ? 8 * pulse : 6;
        
        const colors = {
          post: node.category === 'tool' ? '#00e0ff' : node.category === 'research' ? '#00f5ff' : '#9b30ff',
          user: '#00ff88',
        };

        // Glow effect
        const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, size * 3);
        gradient.addColorStop(0, colors[node.type] || '#00e0ff');
        gradient.addColorStop(0.5, colors[node.type] + '80' || '#00e0ff80');
        gradient.addColorStop(1, colors[node.type] + '00' || '#00e0ff00');

        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Outer ring
        ctx.beginPath();
        ctx.arc(node.x, node.y, size * 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = colors[node.type] + '40';
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      animationId = requestAnimationFrame(draw);
    };

    draw();
    animationFrameRef.current = animationId;

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      cancelAnimationFrame(animationId);
    };
  }, [nodes, connections]);

  const handleCanvasMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    mousePosRef.current = { x, y };

    const clickedNode = nodes.find(node => {
      const distance = Math.sqrt(Math.pow(x - node.x, 2) + Math.pow(y - node.y, 2));
      return distance < 20;
    });

    setHoveredNode(clickedNode || null);
  };

  const getNodeColor = (node) => {
    if (node.type === 'user') return '#00ff88';
    const categoryColors = {
      tool: '#00e0ff',
      research: '#00f5ff',
      discussion: '#9b30ff',
      project: '#ff00ff',
    };
    return categoryColors[node.category] || '#00e0ff';
  };

  return (
    <div ref={containerRef} className="relative w-full h-[600px] bg-cyber-black rounded-lg border border-cyber-blue/20 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
        onMouseMove={handleCanvasMouseMove}
        onMouseLeave={() => setHoveredNode(null)}
      />
      
      <div className="absolute top-4 left-4 z-10">
        <h3 className="font-orbitron text-xl text-cyber-blue mb-2">Live Activity Map</h3>
        <div className="flex gap-4 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-cyber-blue"></div>
            <span className="text-gray-400">Posts</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500"></div>
            <span className="text-gray-400">Users</span>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {hoveredNode && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="absolute z-20 bg-cyber-dark/95 backdrop-blur-md border border-cyber-blue/50 rounded-lg p-4 shadow-2xl"
            style={{
              left: `${mousePosRef.current.x + 20}px`,
              top: `${mousePosRef.current.y + 20}px`,
              transform: 'translate(0, 0)',
            }}
          >
            <div className="flex items-center gap-2 mb-2">
              <div 
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: getNodeColor(hoveredNode) }}
              ></div>
              <span className="font-orbitron text-cyber-blue">{hoveredNode.type.toUpperCase()}</span>
            </div>
            <p className="font-exo text-white text-sm">{hoveredNode.label}</p>
            {hoveredNode.category && (
              <span className="text-xs text-gray-400 mt-1 block">Category: {hoveredNode.category}</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default GridActivityMap;

