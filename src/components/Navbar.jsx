import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Shield, Menu, X, LogOut, User, LayoutDashboard } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import SystemShutdown from './transitions/SystemShutdown';
import toast from 'react-hot-toast';

const Navbar = ({ onSignInClick }) => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const { session, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);
  
  const handleSignOut = async () => {
    setIsShuttingDown(true);
    setTimeout(async () => {
      await signOut();
      setIsShuttingDown(false);
      navigate('/');
    }, 3500);
  };

  const navItems = [
    { name: 'About', href: '#about' },
    { name: 'Tools', href: '#tools' },
    { name: 'Intelligence', href: '#intelligence' },
    { name: 'Community', href: '#community' },
  ];

  const scrollToSection = (e, href) => {
    e.preventDefault();
    setMobileMenuOpen(false);
    if (location.pathname !== '/') {
      navigate('/');
      setTimeout(() => {
        document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
      }, 150);
    } else {
      document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <>
      <AnimatePresence>
        {isShuttingDown && (
          <SystemShutdown key="shutdown" onComplete={() => {}} />
        )}
      </AnimatePresence>
      <motion.nav
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          scrolled || mobileMenuOpen ? 'bg-cyber-black/80 backdrop-blur-lg border-b border-cyber-blue/20' : 'bg-transparent'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-20">
            <Link to="/" className="flex items-center space-x-3 cursor-pointer">
              <motion.div whileHover={{ scale: 1.05, rotate: 5 }}>
                <Shield className="w-8 h-8 text-cyber-blue" strokeWidth={1.5} />
              </motion.div>
              <span className="font-orbitron text-2xl font-bold text-white tracking-wider">CLAWNET</span>
            </Link>

            <div className="hidden md:flex items-center space-x-8">
              {navItems.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  onClick={(e) => scrollToSection(e, item.href)}
                  className="font-exo text-sm font-medium text-gray-300 hover:text-cyber-blue transition-colors relative group"
                >
                  {item.name}
                  <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-cyber-blue group-hover:w-full transition-all duration-300" />
                </a>
              ))}
            </div>

            <div className="flex items-center gap-4">
              {session ? (
                <div className="hidden md:flex items-center gap-4">
                  <span className="font-exo text-sm text-gray-300">Welcome, <span className="font-bold text-cyber-cyan">{profile?.username || 'User'}</span></span>
                  <Link to="/hub" className="no-quantum-transform">
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex items-center gap-2 px-4 py-2 bg-cyber-blue/10 border border-cyber-blue rounded-md text-cyber-blue text-sm font-bold no-quantum-transform"
                    >
                      <LayoutDashboard size={16} />
                      Hub
                    </motion.button>
                  </Link>
                  <motion.button
                    onClick={handleSignOut}
                    whileHover={{ scale: 1.05, backgroundColor: 'rgba(255,0,0,0.2)' }}
                    whileTap={{ scale: 0.95 }}
                    className="p-2 rounded-md border border-red-500/50 text-red-500/80 hover:text-red-500"
                  >
                    <LogOut size={18} />
                  </motion.button>
                </div>
              ) : (
                <motion.button
                  onClick={onSignInClick}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="hidden md:flex items-center gap-2 px-4 py-2 border-2 border-cyber-blue rounded-md text-cyber-blue font-orbitron font-bold text-sm"
                >
                  <User size={16} />
                  Sign In
                </motion.button>
              )}

              <motion.button
                className="md:hidden relative w-10 h-10 flex items-center justify-center text-gray-300 hover:text-cyber-blue transition-colors z-50 touch-manipulation"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-label="Toggle menu"
                whileTap={{ scale: 0.9 }}
              >
                <AnimatePresence mode="wait">
                  {mobileMenuOpen ? (
                    <motion.div
                      key="close"
                      initial={{ rotate: -90, opacity: 0 }}
                      animate={{ rotate: 0, opacity: 1 }}
                      exit={{ rotate: 90, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <X size={24} strokeWidth={2.5} />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="menu"
                      initial={{ rotate: 90, opacity: 0 }}
                      animate={{ rotate: 0, opacity: 1 }}
                      exit={{ rotate: -90, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <Menu size={24} strokeWidth={2.5} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.button>
            </div>
          </div>
        </div>
      </motion.nav>

      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 bg-cyber-black/95 backdrop-blur-xl z-40 md:hidden"
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 bottom-0 w-80 max-w-[85vw] bg-cyber-dark/98 backdrop-blur-xl border-l border-cyber-blue/20 z-50 md:hidden flex flex-col shadow-2xl"
            >
              <div className="flex items-center justify-between p-6 border-b border-cyber-blue/20">
                <span className="font-orbitron text-lg text-cyber-blue">Menu</span>
                <button
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-2 text-gray-400 hover:text-white hover:bg-cyber-gray/30 rounded transition-colors touch-manipulation"
                >
                  <X size={20} />
                </button>
              </div>
              <motion.ul 
                className="flex flex-col px-6 py-8 space-y-6 flex-grow overflow-y-auto"
                variants={{
                  hidden: { opacity: 0 },
                  visible: {
                    opacity: 1,
                    transition: {
                      staggerChildren: 0.05,
                    },
                  },
                }}
                initial="hidden"
                animate="visible"
                exit="hidden"
              >
                {session ? (
                  <>
                    <motion.li variants={{ hidden: { opacity: 0, x: 20 }, visible: { opacity: 1, x: 0 } }} className="pb-4 border-b border-cyber-blue/10">
                      <p className="font-exo text-sm text-gray-400 mb-1">Welcome back</p>
                      <p className="font-orbitron text-lg text-cyber-cyan">{profile?.username || 'User'}</p>
                    </motion.li>
                    <motion.li variants={{ hidden: { opacity: 0, x: 20 }, visible: { opacity: 1, x: 0 } }}>
                      <Link 
                        to="/hub" 
                        onClick={() => setMobileMenuOpen(false)} 
                        className="flex items-center gap-3 px-4 py-3 rounded-lg bg-cyber-gray/30 hover:bg-cyber-blue/10 border border-cyber-blue/20 hover:border-cyber-blue/40 transition-all touch-manipulation"
                      >
                        <LayoutDashboard size={20} className="text-cyber-blue" />
                        <span className="font-orbitron text-base text-white">Community Hub</span>
                      </Link>
                    </motion.li>
                    <motion.li variants={{ hidden: { opacity: 0, x: 20 }, visible: { opacity: 1, x: 0 } }} className="mt-auto pt-6">
                      <button 
                        onClick={handleSignOut} 
                        className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 hover:border-red-500/50 transition-all text-red-400 font-orbitron text-sm touch-manipulation"
                      >
                        <LogOut size={18} />
                        Sign Out
                      </button>
                    </motion.li>
                  </>
                ) : (
                  <>
                    {navItems.map((item) => (
                      <motion.li 
                        key={item.name} 
                        variants={{ hidden: { opacity: 0, x: 20 }, visible: { opacity: 1, x: 0 } }}
                      >
                        <a 
                          href={item.href} 
                          onClick={(e) => { scrollToSection(e, item.href); }} 
                          className="block px-4 py-3 rounded-lg text-gray-300 hover:text-cyber-blue hover:bg-cyber-gray/30 font-orbitron text-base transition-all touch-manipulation"
                        >
                          {item.name}
                        </a>
                      </motion.li>
                    ))}
                    <motion.li 
                      variants={{ hidden: { opacity: 0, x: 20 }, visible: { opacity: 1, x: 0 } }} 
                      className="mt-auto pt-6"
                    >
                      <button 
                        onClick={() => { onSignInClick(); setMobileMenuOpen(false); }} 
                        className="w-full flex items-center justify-center gap-2 px-6 py-3 border-2 border-cyber-blue rounded-lg text-cyber-blue font-orbitron font-bold text-base hover:bg-cyber-blue/10 transition-all touch-manipulation"
                      >
                        <User size={18} />
                        Sign In
                      </button>
                    </motion.li>
                  </>
                )}
              </motion.ul>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
};

export default Navbar;
