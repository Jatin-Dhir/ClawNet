import React from 'react';
import { motion } from 'framer-motion';
import { useInView } from 'framer-motion';
import { useRef } from 'react';
import { Globe, Shield, Cpu, Zap } from 'lucide-react';

const About = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  const milestones = [
    {
      year: '2023',
      title: 'Foundation',
      description: 'ClawNet Labs established with a mission to revolutionize cybersecurity',
      icon: Shield,
    },
    {
      year: '2024',
      title: 'First Product',
      description: 'PortLock - Advanced USB device access control system',
      icon: Cpu,
    },
    {
      year: '2025',
      title: 'Launch',
      description: 'Introduced Clawnet to the world',
      icon: Zap,
    },
    {
      year: '2026',
      title: 'AI Integration',
      description: ' Using automated anaylsis in ClawView',
      icon: Globe,
    },
  ];

  return (
    <section id="about" ref={ref} className="relative py-20 md:py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-cyber-black via-cyber-dark to-cyber-black" />
      
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
          className="text-center mb-16"
        >
          <h2 className="section-title mb-6">Who We Are</h2>
          <p className="font-exo text-lg md:text-xl text-gray-400 max-w-3xl mx-auto">
            We are an autonomous network breach analyzer. Our advanced cybersecurity innovation lab simulates, detects, and learns from intrusion patterns through AI-driven threat intelligence.
          </p>
        </motion.div>

        <div className="relative">
          {/* Vertical line for desktop */}
          <div className="hidden md:block absolute left-1/2 transform -translate-x-1/2 h-full w-0.5 bg-gradient-to-b from-cyber-blue via-cyber-purple to-cyber-cyan" />
          {/* Vertical line for mobile */}
          <div className="md:hidden absolute left-4 h-full w-0.5 bg-gradient-to-b from-cyber-blue via-cyber-purple to-cyber-cyan" />

          {milestones.map((milestone, index) => (
            <motion.div
              key={milestone.year}
              initial={{ opacity: 0, x: index % 2 === 0 ? -60 : 60, scale: 0.9 }}
              animate={isInView ? { opacity: 1, x: 0, scale: 1 } : {}}
              transition={{ 
                duration: 0.7, 
                delay: index * 0.15,
                ease: [0.4, 0, 0.2, 1]
              }}
              className="relative flex items-center mb-12 md:mb-16 md:even:flex-row-reverse"
            >
              <div className="w-full md:w-5/12 pl-12 md:pl-0 md:odd:pr-8 md:even:pl-8">
                <motion.div
                  whileHover={{ 
                    scale: 1.03, 
                    y: -5,
                    transition: { duration: 0.3 }
                  }}
                  className="cyber-card p-6"
                >
                  <div className="flex items-center gap-4 mb-3">
                    <milestone.icon className="w-6 h-6 text-cyber-blue" />
                    <h3 className="font-orbitron text-3xl font-bold text-cyber-cyan">
                      {milestone.year}
                    </h3>
                  </div>
                  <h4 className="font-orbitron text-xl font-semibold text-white mb-2">
                    {milestone.title}
                  </h4>
                  <p className="font-exo text-gray-400">
                    {milestone.description}
                  </p>
                </motion.div>
              </div>

              {/* Timeline dot */}
              <div className="absolute left-4 md:left-1/2 transform -translate-x-1/2 w-4 h-4 bg-cyber-blue rounded-full border-4 border-cyber-black shadow-lg" />
            </motion.div>
          ))}
        </div>

        {/* Mission Card */}
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.6 }}
          className="text-center"
        >
          <div className="cyber-card p-8 max-w-4xl mx-auto">
            <div className="flex items-center justify-center gap-3 mb-4">
              <Shield className="w-8 h-8 text-cyber-blue" />
              <h3 className="font-orbitron text-2xl font-bold text-cyber-blue">
                Our Mission
              </h3>
            </div>
            <p className="font-exo text-xl text-gray-300 italic">
              "To redefine security through intelligence, automation, and innovation."
            </p>
          </div>
        </motion.div>

      </div>
    </section>
  );
};

export default About;
