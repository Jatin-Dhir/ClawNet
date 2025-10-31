import React from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { Shield, Github, Linkedin, MessageCircle, Send, Instagram } from 'lucide-react';

const Footer = () => {
  const navigate = useNavigate();

  const links = [
    { name: 'About', href: '#about' },
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
    navigate('/');
    setTimeout(() => {
        document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
    }, 150);
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
                    className="font-exo text-gray-400 hover:text-cyber-blue transition-colors text-sm cursor-pointer"
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
                <p className="text-gray-400">Email: <a href="mailto:intel@clawnet.dev" className="text-cyber-cyan hover:underline">intel@clawnet.dev</a></p>
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
                  className="w-10 h-10 rounded-lg bg-cyber-gray/50 border border-cyber-blue/20 hover:border-cyber-blue/60 flex items-center justify-center transition-all duration-300 group"
                  aria-label={social.label}
                >
                  <social.icon className="w-5 h-5 text-gray-400 group-hover:text-cyber-blue transition-colors" />
                </motion.a>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-cyber-blue/10 text-center">
          <p className="font-exo text-gray-500 text-sm">
            © 2025 ClawNet Labs — Intelligence Unleashed.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
