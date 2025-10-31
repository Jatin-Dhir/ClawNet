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
                  <Link to="/hub">
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      className="flex items-center gap-2 px-4 py-2 bg-cyber-blue/10 border border-cyber-blue rounded-md text-cyber-blue text-sm font-bold"
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

              <button
                className="md:hidden text-gray-300 hover:text-cyber-blue transition-colors z-50"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-label="Toggle menu"
              >
                {mobileMenuOpen ? <X size={28} /> : <Menu size={28} />}
              </button>
            </div>
          </div>
        </div>
      </motion.nav>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 bg-cyber-black/90 backdrop-blur-xl z-40 md:hidden flex flex-col items-center justify-center"
          >
            <motion.ul 
              className="flex flex-col items-center space-y-10 text-center"
              variants={{
                hidden: { opacity: 0 },
                visible: {
                  opacity: 1,
                  transition: {
                    staggerChildren: 0.1,
                  },
                },
              }}
              initial="hidden"
              animate="visible"
              exit="hidden"
            >
              {session ? (
                <>
                  <motion.li variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }} className="font-exo text-lg text-gray-300">Welcome, <span className="font-bold text-cyber-cyan">{profile?.username || 'User'}</span></motion.li>
                  <motion.li variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}><Link to="/hub" onClick={() => setMobileMenuOpen(false)} className="font-orbitron text-3xl text-gray-200 hover:text-cyber-blue transition-colors">Community Hub</Link></motion.li>
                  <motion.li variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}><button onClick={handleSignOut} className="font-orbitron text-3xl text-red-500/80 hover:text-red-500 transition-colors">Sign Out</button></motion.li>
                </>
              ) : (
                <>
                  {navItems.map((item) => (
                    <motion.li key={item.name} variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}>
                      <a href={item.href} onClick={(e) => scrollToSection(e, item.href)} className="font-orbitron text-3xl text-gray-200 hover:text-cyber-blue transition-colors">
                        {item.name}
                      </a>
                    </motion.li>
                  ))}
                   <motion.li variants={{ hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } }}>
                     <button onClick={() => { onSignInClick(); setMobileMenuOpen(false); }} className="px-8 py-3 border-2 border-cyber-blue rounded-md text-cyber-blue font-orbitron font-bold text-xl">
                      Sign In
                     </button>
                   </motion.li>
                </>
              )}
            </motion.ul>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default Navbar;
