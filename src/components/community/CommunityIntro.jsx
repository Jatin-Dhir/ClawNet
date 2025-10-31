import React, { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ArrowRight } from 'lucide-react';
import CommunityParticles from './CommunityParticles';

const CommunityIntro = ({ onSignInClick, triggerTransition }) => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const { session } = useAuth();
  const navigate = useNavigate();

  const handleClick = () => {
    if (session) {
      triggerTransition(() => navigate('/hub'));
    } else {
      triggerTransition(onSignInClick);
    }
  };

  return (
    <section id="community" ref={ref} className="relative py-20 md:py-32 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 60, scale: 0.95 }}
          animate={isInView ? { opacity: 1, y: 0, scale: 1 } : {}}
          transition={{ 
            duration: 0.8,
            ease: [0.4, 0, 0.2, 1]
          }}
          className="relative cyber-card p-8 md:p-12 text-center overflow-hidden cursor-pointer group"
          onClick={handleClick}
          whileHover={{
            y: -8,
            scale: 1.02,
            boxShadow: '0 0 50px rgba(0, 224, 255, 0.4), inset 0 0 40px rgba(0, 224, 255, 0.15)',
            borderColor: 'rgba(0, 224, 255, 0.8)',
            transition: { duration: 0.3 }
          }}
        >
          <div className="absolute -inset-px bg-cyber-grid opacity-10 group-hover:opacity-20 transition-opacity duration-300" style={{ backgroundSize: '30px 30px' }} />
          <CommunityParticles />
          <div className="relative z-10">
            <h2 className="section-title mb-6">Join The ClawNet Community</h2>
            <p className="font-exo text-lg md:text-xl text-gray-400 max-w-3xl mx-auto mb-8">
              A global hub for cybersecurity innovators. Share your tools. Exchange ideas. Redefine the future of defense — together.
            </p>
            <div className="inline-flex items-center gap-3 font-orbitron font-bold text-lg text-cyber-cyan group-hover:text-white transition-colors">
              <span>{session ? 'Enter the Hub' : 'Authenticate and Engage'}</span>
              <ArrowRight className="group-hover:translate-x-2 transition-transform" />
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default CommunityIntro;
