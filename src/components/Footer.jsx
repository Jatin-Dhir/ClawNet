import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { Shield, Github, Linkedin, MessageCircle, Send, Instagram } from 'lucide-react';

const Footer = () => {
  const navigate = useNavigate();

  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackForm, setFeedbackForm] = useState({
    name: '',
    email: '',
    message: '',
  });
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const links = [
    { name: 'About', href: '/about' },
    { name: 'Tools', href: '#tools' },
    { name: 'Intelligence', href: '#intelligence' },
    { name: 'Community', href: '#community' },
  ];

  const socials = [
    { icon: Github, href: 'https://github.com', label: 'GitHub' },
    { icon: Linkedin, href: 'https://linkedin.com', label: 'LinkedIn' },
    { icon: MessageCircle, href: 'https://discord.com', label: 'Discord' },
    { icon: Send, href: 'https://telegram.org', label: 'Telegram' },
    { icon: Instagram, href: 'https://instagram.com', label: 'Instagram' },
  ];

  const scrollToSection = (e, href) => {
    e.preventDefault();
    if (href.startsWith('/')) {
      navigate(href);
      return;
    }
    navigate('/');
    setTimeout(() => {
        document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
    }, 150);
  };

  const handleFeedbackChange = (e) => {
    const { name, value } = e.target;
    setFeedbackForm(prev => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleFeedbackSubmit = (e) => {
    e.preventDefault();
    setFeedbackSubmitted(true);
    setTimeout(() => {
      setFeedbackSubmitted(false);
      setIsFeedbackOpen(false);
      setFeedbackForm({ name: '', email: '', message: '' });
    }, 1800);
  };

  return (
    <footer id="contact" className="relative bg-cyber-darker border-t border-cyber-blue/20 pt-16 pb-8 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
          <div className="md:col-span-4">
            <Link to="/" className="flex items-center gap-3 mb-4">
              <Shield className="w-8 h-8 text-cyber-blue" strokeWidth={1.5} />
              <span className="font-orbitron text-2xl font-bold text-white tracking-wider">CLAWNET</span>
            </Link>
            <p className="font-exo text-gray-400 text-sm max-w-xs">
              Redefining digital protection through intelligence and automation.
            </p>
          </div>

          <div className="md:col-span-2">
            <h3 className="font-orbitron text-base font-semibold text-gray-300 mb-4 tracking-wider">
              Navigate
            </h3>
            <ul className="space-y-3">
              {links.map((link) => (
                <li key={link.name}>
                  <a
                    href={link.href}
                    onClick={(e) => scrollToSection(e, link.href)}
                    className="font-exo text-gray-400 hover:text-cyber-blue transition-colors text-sm cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-cyber-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-cyber-darker px-1"
                  >
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          
          <div className="md:col-span-3">
            <h3 className="font-orbitron text-base font-semibold text-gray-300 mb-4 tracking-wider">
              Contact Us
            </h3>
            <div className="space-y-3 font-exo text-sm">
                <p className="text-gray-400">Email: <a href="mailto:contact@projectclawnet.online" className="text-cyber-cyan hover:underline">contact@projectclawnet.online</a></p>
                <p className="text-gray-400">Status: <span className="text-green-400">All Systems Operational</span></p>
            </div>
          </div>

          <div className="md:col-span-3">
            <h3 className="font-orbitron text-base font-semibold text-gray-300 mb-4 tracking-wider">
              Follow The Mission
            </h3>
            <div className="flex gap-4 flex-wrap">
              {socials.map((social) => (
                <motion.a
                  key={social.label}
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  whileHover={{ scale: 1.1, y: -2 }}
                  whileTap={{ scale: 0.95 }}
                  className="w-10 h-10 rounded-lg bg-cyber-gray/50 border border-cyber-blue/20 hover:border-cyber-blue/60 flex items-center justify-center transition-all duration-300 group focus:outline-none focus-visible:ring-2 focus-visible:ring-cyber-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-cyber-darker"
                  aria-label={social.label}
                >
                  <social.icon className="w-5 h-5 text-gray-400 group-hover:text-cyber-blue transition-colors" />
                </motion.a>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-cyber-blue/10 text-center">
          <motion.button
            onClick={() => setIsFeedbackOpen(true)}
            whileHover={{ scale: 1.04, boxShadow: '0 0 18px rgba(34, 211, 238, 0.25)' }}
            whileTap={{ scale: 0.96 }}
            className="inline-flex items-center justify-center px-5 py-2 mb-4 font-orbitron text-sm tracking-wider rounded-md bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker shadow-lg shadow-cyber-blue/20 transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-cyber-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-cyber-darker"
          >
            Share Feedback
          </motion.button>
          <p className="font-exo text-gray-500 text-sm">
            © 2025 ClawNet Labs — Intelligence Unleashed.
          </p>
        </div>
      </div>

      <AnimatePresence>
        {isFeedbackOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
            onClick={() => !feedbackSubmitted && setIsFeedbackOpen(false)}
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="relative w-full max-w-lg bg-cyber-darker/95 border border-cyber-blue/30 rounded-lg p-6 md:p-8 shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-orbitron text-lg text-white tracking-wider">We Value Your Voice</h3>
                <button
                  type="button"
                  onClick={() => !feedbackSubmitted && setIsFeedbackOpen(false)}
                  className="text-gray-400 hover:text-white transition-colors text-sm font-exo"
                >
                  Close
                </button>
              </div>

              <p className="font-exo text-sm text-gray-400 mb-6">
                Tell us what you love, what we can improve, or what you want to see next on ClawNet.
              </p>

              <form onSubmit={handleFeedbackSubmit} className="space-y-4">
                <div>
                  <label htmlFor="feedback-name" className="block font-exo text-xs uppercase tracking-wider text-gray-400 mb-1">
                    Name
                  </label>
                  <input
                    id="feedback-name"
                    name="name"
                    value={feedbackForm.name}
                    onChange={handleFeedbackChange}
                    required
                    className="w-full bg-cyber-black/60 border border-cyber-blue/30 rounded-md px-3 py-2 text-sm text-white outline-none focus:border-cyber-cyan transition-colors"
                    placeholder="Your name"
                  />
                </div>
                <div>
                  <label htmlFor="feedback-email" className="block font-exo text-xs uppercase tracking-wider text-gray-400 mb-1">
                    Email
                  </label>
                  <input
                    id="feedback-email"
                    name="email"
                    type="email"
                    value={feedbackForm.email}
                    onChange={handleFeedbackChange}
                    required
                    className="w-full bg-cyber-black/60 border border-cyber-blue/30 rounded-md px-3 py-2 text-sm text-white outline-none focus:border-cyber-cyan transition-colors"
                    placeholder="you@clawnet.io"
                  />
                </div>
                <div>
                  <label htmlFor="feedback-message" className="block font-exo text-xs uppercase tracking-wider text-gray-400 mb-1">
                    Feedback
                  </label>
                  <textarea
                    id="feedback-message"
                    name="message"
                    value={feedbackForm.message}
                    onChange={handleFeedbackChange}
                    required
                    rows={4}
                    className="w-full bg-cyber-black/60 border border-cyber-blue/30 rounded-md px-3 py-2 text-sm text-white outline-none focus:border-cyber-cyan transition-colors resize-none"
                    placeholder="Share your thoughts..."
                  />
                </div>
                <motion.button
                  type="submit"
                  disabled={feedbackSubmitted}
                  whileHover={{ scale: feedbackSubmitted ? 1 : 1.02 }}
                  whileTap={{ scale: feedbackSubmitted ? 1 : 0.96 }}
                  className={`w-full py-2.5 font-orbitron text-sm tracking-widest rounded-md transition-colors ${
                    feedbackSubmitted
                      ? 'bg-cyber-blue/40 text-cyber-darker cursor-not-allowed'
                      : 'bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker shadow-lg shadow-cyber-blue/30'
                  }`}
                >
                  {feedbackSubmitted ? 'Feedback Sent. Thank You!' : 'Submit Feedback'}
                </motion.button>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </footer>
  );
};

export default Footer;
