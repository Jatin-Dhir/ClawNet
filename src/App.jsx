import React, { useState, useEffect } from 'react';
import { Routes, Route, Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from './contexts/AuthContext';

import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ParticleBackground from './components/ParticleBackground';
import Loader from './components/Loader';
import AuthModal from './components/auth/AuthModal';
import MatrixTransition from './components/MatrixTransition';
import ClawNetTerminal from './components/terminal/ClawNetTerminal';

import LandingPage from './pages/LandingPage';
import CommunityHubPage from './pages/CommunityHubPage';
import TeamPage from './pages/TeamPage';
import ToolDetailPage from './pages/ToolDetailPage';
import ResearchPage from './pages/ResearchPage';
import CyberOperationsPage from './pages/CyberOperationsPage';
import ServiceDetailPage from './pages/ServiceDetailPage';
import AdminDashboard from './pages/AdminDashboard';
import AboutPage from './pages/AboutPage';

const Layout = () => {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionCallback, setTransitionCallback] = useState(null);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const { session } = useAuth();
  const location = useLocation();

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setIsTerminalOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  useEffect(() => {
    if (session) {
      setIsAuthModalOpen(false);
    }
  }, [session]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  const triggerTransition = (callback) => {
    setTransitionCallback(() => callback);
    setIsTransitioning(true);
  };

  const handleTransitionComplete = () => {
    if (transitionCallback) {
      transitionCallback();
    }
    setIsTransitioning(false);
    setTransitionCallback(null);
  };


  return (
    <div className="min-h-screen bg-cyber-black text-white relative overflow-x-hidden">
      <ParticleBackground />
      <Navbar onSignInClick={() => triggerTransition(() => setIsAuthModalOpen(true))} />
      <main>
        <Outlet context={{ 
          onSignInClick: () => setIsAuthModalOpen(true),
          triggerTransition: triggerTransition,
        }} />
      </main>
      <Footer />
      <AnimatePresence>
        {isAuthModalOpen && <AuthModal onClose={() => setIsAuthModalOpen(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {isTransitioning && <MatrixTransition onComplete={handleTransitionComplete} />}
      </AnimatePresence>
      <ClawNetTerminal isOpen={isTerminalOpen} onClose={() => setIsTerminalOpen(false)} />
      
      {/* Floating Terminal Button */}
      {!isTerminalOpen && (
        <motion.button
          onClick={() => setIsTerminalOpen(true)}
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          className="fixed bottom-6 right-6 z-40 p-4 bg-gradient-to-r from-cyber-blue to-cyber-cyan rounded-full shadow-2xl hover:shadow-cyber-blue/50 transition-all group"
          style={{ boxShadow: '0 0 20px rgba(0, 224, 255, 0.5)' }}
          title="Open Terminal (CTRL+`)"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-cyber-darker"
          >
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
            <path d="M6 8l4 4-4 4" />
            <path d="M12 16h6" />
          </svg>
        </motion.button>
      )}
    </div>
  );
};

function App() {
  const [loading, setLoading] = useState(true);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    // Loader runs for ~2.2 seconds (boot sequence + animations)
    const loaderTimer = setTimeout(() => {
      setLoading(false);
      // Small delay before showing content for smooth transition
      setTimeout(() => {
        setShowContent(true);
      }, 150);
    }, 2200);

    return () => clearTimeout(loaderTimer);
  }, []);

  return (
    <>
      <AnimatePresence mode="wait">
        {loading && (
          <Loader key="loader" />
        )}
        {!loading && showContent && (
          <motion.div
            key="content"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
          >
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<LandingPage />} />
                <Route path="hub" element={<CommunityHubPage />} />
                <Route path="team" element={<TeamPage />} />
                <Route path="about" element={<AboutPage />} />
                <Route path="cyber-operations" element={<CyberOperationsPage />} />
                <Route path="services/:serviceId" element={<ServiceDetailPage />} />
                <Route path="admin" element={<AdminDashboard />} />
                <Route path="tools/:toolId" element={<ToolDetailPage />} />
                <Route path="research/:postId" element={<ResearchPage />} />
              </Route>
            </Routes>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default App;
