import React, { useRef, useState, useEffect } from 'react';
import { motion, useInView } from 'framer-motion';
import { Link } from 'react-router-dom';
import { 
  Shield, 
  Code, 
  Network, 
  Award, 
  GraduationCap, 
  Mail,
  CheckCircle2,
  ArrowLeft,
  ArrowRight
} from 'lucide-react';
import MatrixBackground from '../components/effects/MatrixBackground';

const TeamPage = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-50px" });
  const [hoveredIndex, setHoveredIndex] = useState(null);

  const teamMembers = [
    {
      name: 'Kafee Jassal',
      role: 'Cybersecurity Analyst',
      email: 'Team@projectclawnet.online',
      certifications: [
        'Certified Ethical Hacker (CEH)',
        'Cisco Certified Network Associate (CCNA)',
        'Google Cybersecurity Professional Certificate',
        'BCA (Bachelor of Computer Applications)',
      ],
      expertise: [
        'Network Security',
        'Penetration Testing',
        'Ethical Hacking',
        'Security Architecture',
      ],
      icon: Shield,
    },
    {
      name: 'Jatin Dhir',
      role: 'Cybersecurity Analyst',
      email: 'team@projectclawnet.online',
      certifications: [
        'Certified Ethical Hacker (CEH)',
        'Cisco Certified Network Associate (CCNA)',
        'Google Cybersecurity Professional Certificate',
        'BCA (Bachelor of Computer Applications)',
      ],
      expertise: [
        'Threat Intelligence',
        'Incident Response',
        'Vulnerability Assessment',
        'Security Operations',
      ],
      icon: Network,
    },
    {
      name: 'Diksha Arora',
      role: 'Cybersecurity Analyst',
      email: 'team@projectclawnet.online',
      certifications: [
        'Certified Ethical Hacker (CEH)',
        'Cisco Certified Network Associate (CCNA)',
        'Google Cybersecurity Professional Certificate',
        'BCA (Bachelor of Computer Applications)',
      ],
      expertise: [
        'Security Analysis',
        'Risk Assessment',
        'Compliance & Auditing',
        'Security Research',
      ],
      icon: Code,
    },
  ];

  return (
    <div ref={ref} className="min-h-screen bg-cyber-black text-white relative overflow-hidden">
      {/* Interactive Matrix Background - Subtle */}
      <MatrixBackground />

      {/* Content */}
      <div className="relative z-10">
        {/* Header Section */}
        <motion.header
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
          className="relative border-b border-white/10"
        >
          <div className="max-w-[1600px] mx-auto px-6 md:px-12 lg:px-20 xl:px-24 py-20 md:py-28">
            {/* Back Navigation */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2, duration: 0.6 }}
              className="mb-12"
            >
              <Link
                to="/"
                className="inline-flex items-center gap-3 group text-gray-500 hover:text-white transition-all duration-300"
              >
                <ArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
                <span className="font-exo text-sm uppercase tracking-[0.2em]">Back</span>
              </Link>
            </motion.div>

            {/* Massive Title */}
            <div className="space-y-6">
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.8 }}
              >
                <h1 className="font-orbitron text-6xl md:text-8xl lg:text-[10rem] font-black leading-[0.85] tracking-tighter">
                  <span className="text-white/20">OUR </span>
                  <br />
                  <span className="text-white">TEAM</span>
                </h1>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5, duration: 0.8 }}
                className="max-w-2xl pt-4"
              >
                <p className="font-exo text-base md:text-lg text-gray-400 leading-relaxed">
                  Meet the cybersecurity experts behind ProjectClawNet. Certified professionals dedicated to protecting your digital assets.
                </p>
              </motion.div>
            </div>
          </div>
        </motion.header>

        {/* Team Members Section */}
        <section className="relative">
          <div className="max-w-[1600px] mx-auto px-6 md:px-12 lg:px-20 xl:px-24 py-16 md:py-24">
            <div className="space-y-24 md:space-y-32">
              {teamMembers.map((member, index) => (
                <motion.div
                  key={member.name}
                  initial={{ opacity: 0, y: 60 }}
                  animate={isInView ? { opacity: 1, y: 0 } : {}}
                  transition={{ 
                    duration: 0.8, 
                    delay: index * 0.15,
                    ease: [0.4, 0, 0.2, 1]
                  }}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  className="group"
                >
                  {/* Member Card */}
                  <div className="border-b border-white/10 pb-20 md:pb-28 transition-all duration-500 group-hover:border-white/30">
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16 items-start">
                      {/* Left: Name & Role */}
                      <div className="lg:col-span-5 space-y-6">
                        <motion.div
                          animate={hoveredIndex === index ? { x: 15 } : { x: 0 }}
                          transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                        >
                          <h2 className="font-orbitron text-4xl md:text-6xl lg:text-7xl font-black leading-[0.9] mb-4 text-white">
                            {member.name.split(' ')[0]}
                            <br />
                            <span className="text-white/40">{member.name.split(' ')[1]}</span>
                          </h2>
                        </motion.div>
                        
                        <motion.p
                          animate={hoveredIndex === index ? { x: 15 } : { x: 0 }}
                          transition={{ duration: 0.5, delay: 0.05, ease: [0.4, 0, 0.2, 1] }}
                          className="font-exo text-xs md:text-sm text-cyber-blue uppercase tracking-[0.3em] mb-8"
                        >
                          {member.role}
                        </motion.p>

                        {/* Contact Link */}
                        <motion.a
                          href={`mailto:${member.email}`}
                          initial={{ opacity: 0 }}
                          animate={isInView ? { opacity: 1 } : {}}
                          transition={{ delay: index * 0.15 + 0.3 }}
                          whileHover={{ x: 5 }}
                          className="inline-flex items-center gap-3 text-gray-500 hover:text-white transition-colors group/contact"
                        >
                          <span className="font-exo text-sm uppercase tracking-[0.2em]">Contact</span>
                          <ArrowRight className="w-4 h-4 group-hover/contact:translate-x-1 transition-transform" />
                        </motion.a>
                      </div>

                      {/* Right: Details */}
                      <div className="lg:col-span-7 space-y-10">
                        {/* Certifications */}
                        <motion.div
                          initial={{ opacity: 0, x: 20 }}
                          animate={isInView ? { opacity: 1, x: 0 } : {}}
                          transition={{ delay: index * 0.15 + 0.2 }}
                        >
                          <div className="flex items-center gap-3 mb-6">
                            <Award className="w-5 h-5 text-cyber-blue" />
                            <h3 className="font-orbitron text-xs font-semibold text-white/60 uppercase tracking-[0.3em]">
                              Certifications
                            </h3>
                          </div>
                          <ul className="space-y-4">
                            {member.certifications.map((cert, idx) => (
                              <motion.li
                                key={idx}
                                initial={{ opacity: 0, x: 20 }}
                                animate={isInView ? { opacity: 1, x: 0 } : {}}
                                transition={{ delay: index * 0.15 + 0.3 + idx * 0.1 }}
                                className="flex items-start gap-4 group/cert"
                              >
                                <motion.div
                                  whileHover={{ scale: 1.2, rotate: 180 }}
                                  transition={{ duration: 0.3 }}
                                >
                                  <CheckCircle2 className="w-4 h-4 text-cyber-blue mt-0.5 flex-shrink-0 opacity-60 group-hover/cert:opacity-100 transition-opacity" />
                                </motion.div>
                                <span className="font-exo text-sm text-gray-400 leading-relaxed group-hover/cert:text-gray-300 transition-colors">
                                  {cert}
                                </span>
                              </motion.li>
                            ))}
                          </ul>
                        </motion.div>

                        {/* Expertise */}
                        <motion.div
                          initial={{ opacity: 0, x: 20 }}
                          animate={isInView ? { opacity: 1, x: 0 } : {}}
                          transition={{ delay: index * 0.15 + 0.4 }}
                        >
                          <div className="flex items-center gap-3 mb-6">
                            <GraduationCap className="w-5 h-5 text-cyber-blue" />
                            <h3 className="font-orbitron text-xs font-semibold text-white/60 uppercase tracking-[0.3em]">
                              Expertise
                            </h3>
                          </div>
                          <div className="flex flex-wrap gap-3">
                            {member.expertise.map((skill, idx) => (
                              <motion.span
                                key={idx}
                                initial={{ opacity: 0, y: 10 }}
                                animate={isInView ? { opacity: 1, y: 0 } : {}}
                                transition={{ delay: index * 0.15 + 0.5 + idx * 0.06 }}
                                whileHover={{ 
                                  scale: 1.05,
                                  backgroundColor: 'rgba(0, 224, 255, 0.1)',
                                  borderColor: 'rgba(0, 224, 255, 0.5)'
                                }}
                                className="px-4 py-2 border border-white/10 hover:border-white/30 text-xs font-exo text-gray-400 hover:text-white transition-all duration-300"
                              >
                                {skill}
                              </motion.span>
                            ))}
                          </div>
                        </motion.div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Trust Badge Section */}
        <motion.footer
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: 1, duration: 0.8 }}
          className="relative border-t border-white/10 mt-24 md:mt-32"
        >
          <div className="max-w-[1600px] mx-auto px-6 md:px-12 lg:px-20 xl:px-24 py-20 md:py-28">
            <div className="max-w-5xl">
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 1.2 }}
                className="font-orbitron text-4xl md:text-6xl font-black mb-8 text-white/90"
              >
                <span className="text-white/20">CERTIFIED </span>
                PROFESSIONALS
              </motion.h2>

              <motion.p
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 1.3 }}
                className="font-exo text-base md:text-lg text-gray-400 mb-16 leading-relaxed max-w-2xl"
              >
                Our team consists of certified cybersecurity professionals with industry-recognized credentials including CEH, CCNA, and Google Cybersecurity Certifications.
              </motion.p>

              {/* Badges Grid */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 1.4 }}
                className="grid grid-cols-1 md:grid-cols-3 gap-6"
              >
                {[
                  { label: 'Certified Ethical Hackers', icon: Shield },
                  { label: 'CCNA Certified', icon: Network },
                  { label: 'Google Certified', icon: Award },
                ].map((badge, idx) => (
                  <motion.div
                    key={badge.label}
                    initial={{ opacity: 0, y: 20 }}
                    animate={isInView ? { opacity: 1, y: 0 } : {}}
                    transition={{ delay: 1.5 + idx * 0.1 }}
                    whileHover={{ 
                      y: -5, 
                      borderColor: 'rgba(255, 255, 255, 0.3)',
                      transition: { duration: 0.3 }
                    }}
                    className="p-8 border border-white/10 hover:border-white/30 transition-all duration-500"
                  >
                    <badge.icon className="w-8 h-8 text-cyber-blue mb-4" />
                    <p className="font-exo text-sm text-gray-400 uppercase tracking-widest">
                      {badge.label}
                    </p>
                  </motion.div>
                ))}
              </motion.div>
            </div>
          </div>
        </motion.footer>
      </div>
    </div>
  );
};

export default TeamPage;
