import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal, X, Command } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const ClawNetTerminal = ({ isOpen, onClose }) => {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]);
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isGlitching, setIsGlitching] = useState(false);
  const inputRef = useRef(null);
  const outputContainerRef = useRef(null);
  const navigate = useNavigate();
  const typingIntervalsRef = useRef([]);

  const triggerGlitchEffect = () => {
    setIsGlitching(true);
    document.body.classList.add('glitch-effect');
    
    // Add audio feedback if available (optional, doesn't break if not available)
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.setValueAtTime(100, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(800, audioContext.currentTime + 0.1);
      oscillator.frequency.exponentialRampToValueAtTime(50, audioContext.currentTime + 0.3);
      
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
      // Audio not available or blocked, continue without it
    }
    
    setTimeout(() => {
      setIsGlitching(false);
      document.body.classList.remove('glitch-effect');
    }, 3000);
  };

  const commands = {
    connect: {
      portlock: () => {
        addOutput('Connecting to Portlock system...');
        const textLength = 'Connecting to Portlock system...'.length;
        const typingTime = textLength * 15 + 300;
        setTimeout(() => {
          addOutput('Connection established.', 'output', 0);
          setTimeout(() => navigate('/tools/portlock'), 500);
        }, typingTime);
      },
      clawview: () => {
        addOutput('Connecting to ClawView interface...');
        const textLength = 'Connecting to ClawView interface...'.length;
        const typingTime = textLength * 15 + 300;
        setTimeout(() => navigate('/tools/clawview'), typingTime);
      },
      clawnetcore: () => {
        addOutput('Connecting to ClawNet Core...');
        const textLength = 'Connecting to ClawNet Core...'.length;
        const typingTime = textLength * 15 + 300;
        setTimeout(() => navigate('/tools/clawnetcore'), typingTime);
      },
    },
    join: {
      the_grid: () => {
        addOutput('Accessing The Grid...');
        const textLength = 'Accessing The Grid...'.length;
        const typingTime = textLength * 15 + 300;
        setTimeout(() => {
          addOutput('Connected to The Grid.', 'output', 0);
          setTimeout(() => navigate('/hub'), 500);
        }, typingTime);
      },
    },
    show: {
      projects: () => {
        addOutput('Fetching active projects...');
        const textLength = 'Fetching active projects...'.length;
        const typingTime = textLength * 15 + 300;
        setTimeout(() => {
          addOutput('> Project Alpha - Neural Network Defense', 'output', 0);
          const delay1 = '> Project Alpha - Neural Network Defense'.length * 15 + 200;
          setTimeout(() => {
            addOutput('> Project Beta - Quantum Encryption', 'output', 0);
            const delay2 = '> Project Beta - Quantum Encryption'.length * 15 + 200;
            setTimeout(() => {
              addOutput('> Project Gamma - AI Threat Detection', 'output', 0);
            }, delay2);
          }, delay1);
        }, typingTime);
      },
      tools: () => {
        addOutput('Available ClawNet Tools:');
        const textLength = 'Available ClawNet Tools:'.length;
        const typingTime = textLength * 15 + 300;
        setTimeout(() => {
          addOutput('> Portlock - Network Security Scanner', 'output', 0);
          const delay1 = '> Portlock - Network Security Scanner'.length * 15 + 200;
          setTimeout(() => {
            addOutput('> ClawView - Threat Visualization', 'output', 0);
            const delay2 = '> ClawView - Threat Visualization'.length * 15 + 200;
            setTimeout(() => {
              addOutput('> ClawNet Core - AI Defense System', 'output', 0);
            }, delay2);
          }, delay1);
        }, typingTime);
      },
    },
    clawstats: () => {
      addOutput('=== ClawNet System Statistics ===');
      const initialDelay = '=== ClawNet System Statistics ==='.length * 15 + 200;
      setTimeout(() => {
        addOutput('Active Users: 240+', 'output', 0);
        const delay1 = 'Active Users: 240+'.length * 15 + 150;
        setTimeout(() => {
          addOutput('Threats Detected: 1,200+', 'output', 0);
          const delay2 = 'Threats Detected: 1,200+'.length * 15 + 150;
          setTimeout(() => {
            addOutput('System Uptime: 99.5%', 'output', 0);
            const delay3 = 'System Uptime: 99.5%'.length * 15 + 150;
            setTimeout(() => {
              addOutput('Detection Rate: 3.2x faster', 'output', 0);
            }, delay3);
          }, delay2);
        }, delay1);
      }, initialDelay);
    },
    scan: () => {
      addOutput('Initiating network scan...');
      const delays = [
        { text: 'Scanning ports 1-1024...', time: 400 },
        { text: 'Scanning ports 1025-2048...', time: 350 },
        { text: 'Analyzing network traffic...', time: 300 },
        { text: 'Scan complete. No threats detected.', time: 250 },
      ];
      let totalDelay = 500;
      delays.forEach((item) => {
        setTimeout(() => {
          addOutput(item.text, 'output', 0);
        }, totalDelay);
        totalDelay += item.time;
      });
    },
    ping: (args) => {
      const host = args && args.length > 0 ? args.join(' ') : 'grid.clawnet.io';
      addOutput(`Pinging ${host}...`);
      setTimeout(() => {
        addOutput(`PING ${host} (192.168.1.1): 56 data bytes`, 'output', 0);
        const times = [15, 18, 16, 17];
        times.forEach((time, i) => {
          setTimeout(() => {
            addOutput(`64 bytes from ${host}: icmp_seq=${i + 1} ttl=64 time=${time}ms`, 'output', 0);
          }, 500 + i * 300);
        });
        setTimeout(() => {
          addOutput(`--- ${host} ping statistics ---`, 'output', 0);
          setTimeout(() => {
            addOutput('4 packets transmitted, 4 received, 0% packet loss', 'output', 0);
          }, 200);
        }, 1700);
      }, 400);
    },
    whoami: () => {
      addOutput('Current user: clawnet@grid');
      setTimeout(() => {
        addOutput('User ID: guest-2024', 'output', 0);
        setTimeout(() => {
          addOutput('Permission level: standard', 'output', 0);
        }, 200);
      }, 300);
    },
    date: () => {
      const now = new Date();
      addOutput(now.toLocaleString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      }));
    },
    ls: () => {
      addOutput('Available directories:');
      const dirs = ['tools/', 'projects/', 'docs/', 'community/'];
      dirs.forEach((dir, i) => {
        setTimeout(() => {
          addOutput(`  ${dir}`, 'output', 0);
        }, 300 + i * 150);
      });
    },
    echo: (args) => {
      if (args && args.length > 0) {
        addOutput(args.join(' '));
      } else {
        addOutput('Usage: echo [text]', 'error');
      }
    },
    version: () => {
      addOutput('ClawNet Terminal v2.0.1');
      setTimeout(() => {
        addOutput('Build: 2024.12.15', 'output', 0);
        setTimeout(() => {
          addOutput('Platform: Web', 'output', 0);
        }, 200);
      }, 300);
    },
    sudo: (args) => {
      if (args && args.length > 0 && args[0] === 'kill' && args[1] === 'all') {
        addOutput('⚠ WARNING: Executing system kill command...', 'error');
        setTimeout(() => {
          addOutput('ERROR: Unauthorized access detected', 'error', 0);
          setTimeout(() => {
            addOutput('ERROR: Critical system failure', 'error', 0);
            setTimeout(() => {
              addOutput('ERROR: Initiating emergency shutdown...', 'error', 0);
              setTimeout(() => {
                addOutput('', 'output', 0);
                setTimeout(() => {
                  addOutput('███ SYSTEM SHUTDOWN SEQUENCE INITIATED ███', 'error', 0);
                  setTimeout(() => {
                    addOutput('Terminating all processes...', 'error', 0);
                    setTimeout(() => {
                      addOutput('Unmounting filesystems...', 'error', 0);
                      setTimeout(() => {
                        addOutput('Stopping services...', 'error', 0);
                        setTimeout(() => {
                          addOutput('System halted.', 'error', 0);
                          setTimeout(() => {
                            triggerGlitchEffect();
                            setTimeout(() => {
                              addOutput('', 'output', 0);
                              setTimeout(() => {
                                addOutput('███ REBOOT SEQUENCE INITIATED ███', 'output', 0);
                                setTimeout(() => {
                                  addOutput('Initializing hardware...', 'output', 0);
                                  setTimeout(() => {
                                    addOutput('Loading system modules...', 'output', 0);
                                    setTimeout(() => {
                                      addOutput('Starting services...', 'output', 0);
                                      setTimeout(() => {
                                        addOutput('System restored.', 'output', 0);
                                        setTimeout(() => {
                                          addOutput('You weren\'t supposed to do that.', 'error', 0);
                                        }, 300);
                                      }, 400);
                                    }, 400);
                                  }, 400);
                                }, 500);
                              }, 500);
                            }, 2000);
                          }, 500);
                        }, 400);
                      }, 400);
                    }, 400);
                  }, 500);
                }, 500);
              }, 500);
            }, 400);
          }, 400);
        }, 500);
      } else {
        addOutput('Usage: sudo kill all', 'error');
      }
    },
    help: () => {
      const helpHeader = [
        '╭──────────────────────────╮',
        '│    CLAWNET COMMAND MAP   │',
        '╰──────────────────────────╯',
      ];
      const helpSections = [
        {
          title: 'Navigation & Access',
          commands: [
            { syntax: 'connect <destination>', description: 'Open a secure link to `portlock`, `clawview`, or `clawnetcore`.' },
            { syntax: 'join the_grid', description: 'Jump directly into the Community Grid hub.' },
          ],
        },
        {
          title: 'Intelligence Feed',
          commands: [
            { syntax: 'show projects', description: 'List current R&D initiatives inside ClawNet Labs.' },
            { syntax: 'show tools', description: 'Discover defensive suites available for rapid deployment.' },
            { syntax: 'clawstats', description: 'View live operational metrics from the network core.' },
          ],
        },
        {
          title: 'Diagnostics & Utilities',
          commands: [
            { syntax: 'scan', description: 'Simulate a multi-stage perimeter scan with live status output.' },
            { syntax: 'ping [host]', description: 'Probe connectivity to any host (defaults to grid.clawnet.io).' },
            { syntax: 'whoami', description: 'Reveal the active session identity and permission tier.' },
            { syntax: 'date', description: 'Print the current grid-synced timestamp.' },
            { syntax: 'ls', description: 'Expose core directories inside the virtual workspace.' },
            { syntax: 'echo [text]', description: 'Print a custom message back to the console stream.' },
            { syntax: 'version', description: 'Display terminal build information.' },
          ],
        },
        {
          title: 'Critical Operations',
          commands: [
            { syntax: 'sudo kill all', description: 'Trigger the emergency kill chain (restricted).' },
            { syntax: 'clear', description: 'Wipe the current session output.' },
            { syntax: 'help', description: 'Show this enhanced guide.' },
          ],
        },
      ];

      let accumulatedDelay = 0;

      helpHeader.forEach(line => {
        setTimeout(() => addOutput(line, 'output', 0), accumulatedDelay);
        accumulatedDelay += line.length * 10 + 120;
      });

      helpSections.forEach(section => {
        setTimeout(() => addOutput(`\n${section.title}`, 'output', 0), accumulatedDelay);
        accumulatedDelay += section.title.length * 10 + 120;

        section.commands.forEach(cmd => {
          const formattedLine = `  ${cmd.syntax.padEnd(22)} → ${cmd.description}`;
          setTimeout(() => addOutput(formattedLine, 'output', 0), accumulatedDelay);
          accumulatedDelay += formattedLine.length * 10 + 100;
        });
      });

      const footerLines = [
        '',
        'Tip: Use ↑ and ↓ to cycle through previous commands.',
        'Need a visual interface? Type `connect clawview` to launch the threat map.',
      ];

      footerLines.forEach(line => {
        setTimeout(() => addOutput(line, 'output', 0), accumulatedDelay);
        accumulatedDelay += Math.max(line.length, 10) * 10 + 120;
      });
    },
    clear: () => {
      setHistory([]);
    },
  };

  const addOutput = (text, type = 'output', delay = 0) => {
    setTimeout(() => {
      const timestamp = Date.now();
      const newItem = { text, type, timestamp, displayedText: '', isTyping: true };
      setHistory(prev => [...prev, newItem]);
      
      // Typewriter effect
      let index = 0;
      const typeInterval = setInterval(() => {
        setHistory(prev => {
          const updated = [...prev];
          const itemIndex = updated.findIndex(item => item.timestamp === timestamp);
          if (itemIndex !== -1) {
            if (index < text.length) {
              updated[itemIndex] = {
                ...updated[itemIndex],
                displayedText: text.slice(0, index + 1),
                isTyping: true,
              };
              index++;
            } else {
              updated[itemIndex] = {
                ...updated[itemIndex],
                displayedText: text,
                isTyping: false,
              };
              clearInterval(typeInterval);
              typingIntervalsRef.current = typingIntervalsRef.current.filter(id => id !== typeInterval);
            }
          }
          return updated;
        });
      }, 15); // Typing speed
      typingIntervalsRef.current.push(typeInterval);
    }, delay);
  };
  
  useEffect(() => {
    return () => {
      typingIntervalsRef.current.forEach(interval => clearInterval(interval));
      typingIntervalsRef.current = [];
    };
  }, []);

  const executeCommand = (cmd) => {
    const parts = cmd.trim().split(' ');
    const mainCmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (commands[mainCmd]) {
      if (typeof commands[mainCmd] === 'function') {
        // Commands that take arguments
        if (mainCmd === 'ping' || mainCmd === 'echo' || mainCmd === 'sudo') {
          commands[mainCmd](args);
        } else {
          commands[mainCmd]();
        }
      } else if (parts.length > 1) {
        const subCmd = parts.slice(1).join(' ').toLowerCase();
        const subCommand = commands[mainCmd][subCmd];
        if (subCommand) {
          subCommand();
        } else {
          addOutput(`Command not found: ${cmd}`, 'error');
        }
      } else {
        addOutput(`Usage: ${mainCmd} [option]`, 'error');
      }
    } else {
      addOutput(`Command not found: ${cmd}. Type 'help' for available commands.`, 'error');
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    addOutput(`> ${input}`, 'command');
    setCommandHistory(prev => [...prev, input]);
    setHistoryIndex(-1);
    executeCommand(input);
    setInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex === -1 
          ? commandHistory.length - 1 
          : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setInput(commandHistory[newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex >= 0) {
        const newIndex = historyIndex < commandHistory.length - 1 
          ? historyIndex + 1 
          : -1;
        setHistoryIndex(newIndex);
        setInput(newIndex === -1 ? '' : commandHistory[newIndex]);
      }
    }
  };

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (outputContainerRef.current) {
      outputContainerRef.current.scrollTo({
        top: outputContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [history]);

  useEffect(() => {
    if (isOpen) {
      addOutput('ClawNet Command Console v2.0 initialized.');
      addOutput('Type "help" for available commands.');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {isGlitching && (
        <>
          <div className="fixed inset-0 z-[10000] pointer-events-none overflow-hidden">
            {/* Pulsing red overlay with smoother transitions */}
            <motion.div
              animate={{
                opacity: [0, 0.4, 0.3, 0.5, 0.2, 0],
                scale: [1, 1.05, 1, 1.08, 1, 1],
                rotate: [0, 1, -1, 1.5, -1.5, 0],
              }}
              transition={{ duration: 0.5, repeat: 6, ease: "easeInOut" }}
              className="absolute inset-0 bg-gradient-to-br from-red-600/30 via-purple-600/20 to-red-600/30"
            />
            
            {/* Horizontal scan lines */}
            <motion.div
              className="absolute inset-0"
              animate={{
                backgroundPosition: ['0 0', '0 100%'],
              }}
              transition={{
                duration: 0.3,
                repeat: Infinity,
                ease: 'linear',
              }}
              style={{
                background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(239, 68, 68, 0.1) 2px, rgba(239, 68, 68, 0.1) 4px)',
              }}
            />
            
            {/* Enhanced binary rain effect */}
            <div className="absolute inset-0 font-mono text-xs text-red-400/80 overflow-hidden">
              {[...Array(150)].map((_, i) => {
                const randomX = Math.random() * window.innerWidth;
                const randomDelay = Math.random() * 2;
                const randomSpeed = 1.5 + Math.random() * 1.5;
                return (
                  <motion.div
                    key={i}
                    initial={{ y: -100, x: randomX, opacity: 0 }}
                    animate={{ 
                      y: window.innerHeight + 100,
                      opacity: [0, 0.8, 0.8, 0]
                    }}
                    transition={{ 
                      duration: randomSpeed, 
                      repeat: Infinity, 
                      delay: randomDelay,
                      ease: 'linear'
                    }}
                    style={{
                      textShadow: '0 0 8px rgba(239, 68, 68, 0.8)',
                    }}
                  >
                    {Math.random().toString(2).substring(2, 20)}
                  </motion.div>
                );
              })}
            </div>
            
            {/* Glitch distortion overlay */}
            <motion.div
              className="absolute inset-0 mix-blend-screen"
              animate={{
                opacity: [0, 0.3, 0, 0.4, 0],
                x: [0, -3, 3, -2, 2, 0],
              }}
              transition={{ duration: 0.4, repeat: 7, ease: "easeInOut" }}
              style={{
                background: 'radial-gradient(circle at 50% 50%, transparent 0%, rgba(239, 68, 68, 0.15) 100%)',
              }}
            />
            
            {/* Secret message with better animation */}
            <motion.div
              initial={{ opacity: 0, scale: 0.5, y: 50 }}
              animate={{ 
                opacity: [0, 1, 1, 1, 0],
                scale: [0.5, 1.05, 1, 1, 0.8],
                y: [50, 0, -10, 0, 30],
                rotate: [0, 2, -2, 0]
              }}
              transition={{ duration: 3, delay: 0.8, ease: [0.4, 0, 0.2, 1] }}
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
            >
              <motion.div 
                className="cyber-card p-8 border-2 border-red-500/60 bg-black/80 backdrop-blur-sm"
                animate={{
                  boxShadow: [
                    '0 0 20px rgba(239, 68, 68, 0.3)',
                    '0 0 40px rgba(239, 68, 68, 0.6)',
                    '0 0 20px rgba(239, 68, 68, 0.3)',
                  ],
                }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                <motion.p 
                  className="font-orbitron text-2xl text-red-400 text-center"
                  animate={{
                    textShadow: [
                      '0 0 10px rgba(239, 68, 68, 0.8)',
                      '0 0 20px rgba(239, 68, 68, 1)',
                      '0 0 10px rgba(239, 68, 68, 0.8)',
                    ],
                  }}
                  transition={{ duration: 0.8, repeat: Infinity }}
                >
                  You weren't supposed to do that.
                </motion.p>
              </motion.div>
            </motion.div>
          </div>
          <motion.div
            className="fixed inset-0 z-[10001] pointer-events-none interface-melt"
            style={{
              background: 'linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.9))',
            }}
          />
        </>
      )}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: isGlitching ? [1, 0.5, 1] : 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className={`fixed inset-0 z-50 flex items-center justify-center p-0 md:p-4 bg-cyber-black/80 backdrop-blur-sm ${isGlitching ? 'glitch-effect' : ''}`}
        onClick={(e) => {
          if (e.target === e.currentTarget && window.innerWidth >= 768) onClose();
        }}
      >
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full h-full md:h-auto md:w-full md:max-w-3xl rounded-none md:rounded-lg bg-cyber-dark/98 backdrop-blur-md overflow-hidden"
        style={{ 
          border: '1px solid rgba(0, 224, 255, 0.2)',
          boxShadow: `
            0 0 0 1px rgba(0, 224, 255, 0.1),
            0 8px 32px rgba(0, 0, 0, 0.6),
            inset 0 1px 0 rgba(0, 224, 255, 0.05)
          `
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Subtle grid background */}
        <div 
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(0, 224, 255, 0.3) 1px, transparent 1px),
              linear-gradient(90deg, rgba(0, 224, 255, 0.3) 1px, transparent 1px)
            `,
            backgroundSize: '24px 24px',
          }}
        />

        {/* Header */}
        <div className="relative flex items-center justify-between bg-gradient-to-r from-cyber-black/90 to-cyber-dark/80 px-6 py-3.5 border-b border-cyber-blue/30">
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded bg-cyber-blue/10">
              <Terminal className="text-cyber-blue" size={18} />
            </div>
            <div>
              <span className="font-orbitron text-base font-semibold text-cyber-blue">ClawNet Terminal</span>
              <div className="text-xs text-gray-400 font-mono">v2.0.1</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white hover:bg-red-500/10 transition-all p-2 md:p-1.5 rounded touch-manipulation"
            aria-label="Close terminal"
          >
            <X size={18} className="md:w-4 md:h-4" />
          </button>
        </div>

        {/* Terminal Content */}
        <div className="relative h-[calc(100vh-120px)] md:h-[450px] overflow-hidden bg-cyber-black/20">
          <div
            ref={outputContainerRef}
            className="h-full overflow-y-auto p-4 md:p-6 font-mono text-xs md:text-sm space-y-2"
          >
            <AnimatePresence mode="popLayout">
              {history.map((item, index) => (
                <motion.div
                  key={`${item.timestamp}-${index}`}
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className={`
                    ${item.type === 'error' 
                      ? 'text-red-400' 
                      : item.type === 'command' 
                      ? 'text-cyber-cyan' 
                      : 'text-white'
                    }
                    break-words leading-relaxed
                  `}
                >
                  {item.type === 'command' && (
                    <span className="text-cyber-blue font-bold mr-2">$</span>
                  )}
                  {item.type === 'error' && (
                    <span className="text-red-400 font-bold mr-2">✗</span>
                  )}
                  <span className="whitespace-pre-wrap break-words">{item.displayedText || item.text}</span>
                  {item.isTyping && (
                    <motion.span
                      animate={{ opacity: [1, 0, 1] }}
                      transition={{ duration: 0.6, repeat: Infinity }}
                      className="inline-block w-[2px] h-4 bg-current ml-1 align-middle"
                      style={{ marginLeft: '2px' }}
                    />
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        {/* Input Section */}
        <form onSubmit={handleSubmit} className="relative border-t border-cyber-blue/20 bg-cyber-black/50 p-3 md:p-4">
          <div className="flex items-center gap-2">
            <span className="text-cyber-blue font-mono text-xs md:text-sm font-medium flex-shrink-0">
              clawnet@grid&gt;
            </span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent text-white outline-none font-mono text-xs md:text-sm placeholder-gray-600 min-w-0"
              placeholder="Enter command..."
              autoComplete="off"
              autoFocus
              inputMode="text"
            />
            <motion.span
              animate={{ opacity: [1, 0, 1] }}
              transition={{ duration: 1, repeat: Infinity }}
              className="w-[2px] h-4 bg-cyber-blue"
            />
          </div>
        </form>
      </motion.div>
      </motion.div>
    </>
  );
};

export default ClawNetTerminal;

