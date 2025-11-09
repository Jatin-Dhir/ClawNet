import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Shield, Menu, X, LogOut, User, LayoutDashboard, Settings, Lock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../supabaseClient';
import SystemShutdown from './transitions/SystemShutdown';

const Navbar = ({ onSignInClick }) => {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
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

  // Check if user is admin
  useEffect(() => {
    const checkAdmin = async () => {
      if (!session?.user) {
        setIsAdmin(false);
        return;
      }

      // Check database for is_admin flag
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('is_admin')
          .eq('id', session.user.id)
          .single();

        if (!error && data) {
          setIsAdmin(data.is_admin === true);
        } else {
          setIsAdmin(false);
        }
      } catch (error) {
        console.error('Error checking admin status:', error);
        setIsAdmin(false);
      }
    };
    checkAdmin();
  }, [session]);
  
  const handleSignOut = async () => {
    setMobileMenuOpen(false);
    setIsShuttingDown(true);
    setTimeout(async () => {
      await signOut();
      setIsShuttingDown(false);
      navigate('/');
    }, 3500);
  };

  const navItems = [
    { name: 'About', href: '/about' },
    { name: 'Team', href: '/team' },
    { name: 'Services', href: '/cyber-operations' },
    { name: 'Tools', href: '#tools' },
    { name: 'Intelligence', href: '#intelligence' },
    { name: 'Community', href: '#community' },
  ];

  const scrollToSection = (e, href) => {
    e.preventDefault();
    setMobileMenuOpen(false);

    if (href.startsWith('/')) {
      navigate(href);
      return;
    }
    
    if (location.pathname !== '/') {
      navigate('/');
      setTimeout(() => {
        document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
      }, 150);
    } else {
      document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const displayName = profile?.username || session?.user?.user_metadata?.full_name || session?.user?.email || 'User';

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
                  <span className="font-exo text-sm text-gray-300">Welcome,&nbsp;
                    <span className="font-bold text-cyber-cyan">{displayName}</span>
                  </span>
                  {isAdmin && (
                    <Link to="/admin" className="no-quantum-transform">
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyber-blue to-cyber-cyan rounded-md text-white text-sm font-bold no-quantum-transform"
                      >
                        <Lock size={16} />
                        Admin
                      </motion.button>
                    </Link>
                  )}
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
                className="md:hidden relative w-10 h-10 flex items-center justify-center text-gray-300 hover:text-cyber-blue transition-colors z-[10000] touch-manipulation"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setMobileMenuOpen(!mobileMenuOpen);
                }}
                aria-label="Toggle menu"
                whileTap={{ scale: 0.95 }}
                style={{ position: 'relative' }}
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
                      <X size={24} strokeWidth={2} />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="menu"
                      initial={{ rotate: 90, opacity: 0 }}
                      animate={{ rotate: 0, opacity: 1 }}
                      exit={{ rotate: -90, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <Menu size={24} strokeWidth={2} />
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
              transition={{ duration: 0.15 }}
              className="fixed inset-0 bg-cyber-black/90 backdrop-blur-md z-[9998] md:hidden"
              onClick={() => setMobileMenuOpen(false)}
              style={{ position: 'fixed' }}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed top-0 right-0 bottom-0 w-72 max-w-[85vw] bg-cyber-dark border-l border-cyber-blue/30 z-[9999] md:hidden flex flex-col shadow-2xl relative overflow-hidden"
              style={{ 
                position: 'fixed',
                backgroundColor: '#0f1117',
                backdropFilter: 'blur(20px)'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="relative flex items-center justify-between p-5 border-b border-cyber-blue/10">
                <div className="flex items-center gap-2.5">
                  <Shield className="w-5 h-5 text-cyber-blue" strokeWidth={1.5} />
                  <span className="font-orbitron text-lg font-bold text-white tracking-wider">CLAWNET</span>
                </div>
                <motion.button
                  onClick={() => setMobileMenuOpen(false)}
                  whileTap={{ scale: 0.9 }}
                  className="p-2 text-gray-400 hover:text-white transition-colors touch-manipulation"
                >
                  <X size={20} strokeWidth={2} />
                </motion.button>
              </div>
              
              {/* Menu Content */}
              <motion.ul 
                className="relative flex flex-col px-5 py-5 space-y-1 flex-grow overflow-y-auto scrollbar-hide"
                variants={{
                  hidden: { opacity: 0 },
                  visible: {
                    opacity: 1,
                    transition: {
                      staggerChildren: 0.04,
                    },
                  },
                }}
                initial="hidden"
                animate="visible"
                exit="hidden"
              >
                {session ? (
                  <>
                    {/* User Welcome Section */}
                    <motion.li 
                      variants={{ hidden: { opacity: 0, y: -10 }, visible: { opacity: 1, y: 0 } }} 
                      className="mb-5 pb-5 border-b border-cyber-blue/10"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-cyber-gray/30 border border-cyber-blue/20 flex items-center justify-center">
                          <User size={16} className="text-cyber-blue" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-exo text-xs text-gray-500 mb-0.5">Welcome back</p>
                          <p className="font-exo text-sm text-white truncate font-medium">{displayName}</p>
                        </div>
                      </div>
                    </motion.li>
                    
                    {/* Admin Link (if admin) */}
                    {isAdmin && (
                      <motion.li variants={{ hidden: { opacity: 0, y: -10 }, visible: { opacity: 1, y: 0 } }}>
                        <Link 
                          to="/admin" 
                          onClick={() => setMobileMenuOpen(false)} 
                          className="flex items-center gap-3 px-4 py-3 rounded-md text-cyber-cyan hover:text-white bg-gradient-to-r from-cyber-blue/10 to-cyber-cyan/10 hover:from-cyber-blue/20 hover:to-cyber-cyan/20 transition-colors touch-manipulation border-l-2 border-cyber-blue border-opacity-50"
                        >
                          <Lock size={18} className="text-cyber-cyan" />
                          <span className="font-exo text-sm font-medium font-bold">Admin Panel</span>
                        </Link>
                      </motion.li>
                    )}

                    {/* Hub Link */}
                    <motion.li variants={{ hidden: { opacity: 0, y: -10 }, visible: { opacity: 1, y: 0 } }}>
                      <Link 
                        to="/hub" 
                        onClick={() => setMobileMenuOpen(false)} 
                        className="flex items-center gap-3 px-4 py-3 rounded-md text-gray-300 hover:text-white hover:bg-cyber-gray/20 transition-colors touch-manipulation border-l-2 border-transparent hover:border-cyber-blue"
                      >
                        <LayoutDashboard size={18} className="text-cyber-blue/70" />
                        <span className="font-exo text-sm font-medium">Community Hub</span>
                      </Link>
                    </motion.li>
                    
                    {/* Spacer */}
                    <div className="flex-grow" />
                    
                    {/* Sign Out Button */}
                    <motion.li 
                      variants={{ hidden: { opacity: 0, y: -10 }, visible: { opacity: 1, y: 0 } }} 
                      className="pt-4 border-t border-cyber-blue/10"
                    >
                      <button 
                        onClick={handleSignOut} 
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-md bg-transparent hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/30 transition-all text-red-400/80 hover:text-red-400 font-exo text-sm touch-manipulation"
                      >
                        <LogOut size={16} />
                        <span>Sign Out</span>
                      </button>
                    </motion.li>
                  </>
                ) : (
                  <>
                    {/* Navigation Items */}
                    {navItems.map((item) => (
                      <motion.li 
                        key={item.name} 
                        variants={{ hidden: { opacity: 0, y: -10 }, visible: { opacity: 1, y: 0 } }}
                      >
                        <a 
                          href={item.href} 
                          onClick={(e) => { scrollToSection(e, item.href); setMobileMenuOpen(false); }} 
                          className="flex items-center px-4 py-3 rounded-md text-gray-400 hover:text-white hover:bg-cyber-gray/10 transition-all touch-manipulation border-l-2 border-transparent hover:border-cyber-blue/50"
                        >
                          <span className="font-exo text-sm font-medium">{item.name}</span>
                        </a>
                      </motion.li>
                    ))}
                    
                    {/* Spacer */}
                    <div className="flex-grow" />
                    
                    {/* Sign In Button */}
                    <motion.li 
                      variants={{ hidden: { opacity: 0, y: -10 }, visible: { opacity: 1, y: 0 } }} 
                      className="pt-4 border-t border-cyber-blue/10"
                    >
                      <button 
                        onClick={() => { onSignInClick(); setMobileMenuOpen(false); }} 
                        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-cyber-blue/10 hover:bg-cyber-blue/20 border border-cyber-blue/30 hover:border-cyber-blue/50 rounded-md text-cyber-blue hover:text-white font-exo text-sm font-medium transition-all touch-manipulation"
                      >
                        <User size={16} />
                        <span>Sign In</span>
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
