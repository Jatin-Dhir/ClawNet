import React, { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

const TeamPreview = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  const teamMembers = [
    { name: 'Kafee Jassal', initials: 'KJ' },
    { name: 'Jatin Dhir', initials: 'JD' },
    { name: 'Diksha Arora', initials: 'DA' },
  ];

  return (
    <section id="team" ref={ref} className="relative py-20 md:py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-cyber-black via-cyber-dark to-cyber-black" />
      
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
          className="text-center mb-16"
        >
          <h2 className="section-title mb-6">Our Team</h2>
          <p className="font-exo text-lg md:text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
            Meet the cybersecurity experts behind ProjectClawNet.
          </p>
        </motion.div>

        {/* Professional team names */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: 0.3, duration: 0.6 }}
          className="mb-12"
        >
          <div className="max-w-5xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-12">
              {teamMembers.map((member, index) => (
                <motion.div
                  key={member.name}
                  initial={{ opacity: 0, y: 20 }}
                  animate={isInView ? { opacity: 1, y: 0 } : {}}
                  transition={{ delay: 0.4 + index * 0.1, duration: 0.6 }}
                  whileHover={{ y: -3 }}
                  className="group text-center"
                >
                  <Link to="/team" className="block">
                    <h3 className="font-orbitron text-xl md:text-2xl font-bold text-white mb-2 group-hover:text-cyber-cyan transition-colors duration-300">
                      {member.name}
                    </h3>
                    <p className="font-exo text-xs md:text-sm text-gray-500 uppercase tracking-wider mb-4">
                      Cybersecurity Analyst
                    </p>
                    <div className="w-12 h-px bg-gradient-to-r from-transparent via-cyber-blue/50 to-transparent mx-auto opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  </Link>
                </motion.div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* View Full Team Link - Minimalist */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ delay: 0.9 }}
          className="text-center mt-16"
        >
          <Link
            to="/team"
            className="inline-flex items-center gap-4 group text-gray-500 hover:text-white transition-colors"
          >
            <span className="font-exo text-sm uppercase tracking-[0.2em]">
              View Full Team
            </span>
            <ArrowRight className="w-5 h-5 group-hover:translate-x-2 transition-transform duration-300" />
          </Link>
        </motion.div>
      </div>
    </section>
  );
};

export default TeamPreview;

