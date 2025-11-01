import React from 'react';
import { motion } from 'framer-motion';
import { useInView } from 'framer-motion';
import { useRef } from 'react';
import { 
  Shield, 
  Code, 
  Network, 
  Award, 
  GraduationCap, 
  Mail, 
  Linkedin,
  Github,
  CheckCircle2
} from 'lucide-react';

const Team = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  const teamMembers = [
    {
      name: 'Kafee Jassal',
      role: 'Cybersecurity Analyst',
      image: 'KJ', // Initials as placeholder
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
      image: 'JD',
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
      image: 'DA',
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
    <section id="team" ref={ref} className="relative py-20 md:py-32 overflow-hidden">
      {/* Subtle background grid */}
      <div 
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(0, 224, 255, 0.4) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 224, 255, 0.4) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-cyber-black via-cyber-dark to-cyber-black" />
      
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
          className="text-center mb-20"
        >
          <h2 className="section-title mb-6">Our Team</h2>
          <p className="font-exo text-lg md:text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
            Meet the cybersecurity experts behind ProjectClawNet. Certified professionals dedicated to protecting your digital assets.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 mb-16">
          {teamMembers.map((member, index) => (
            <motion.div
              key={member.name}
              initial={{ opacity: 0, y: 50 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ 
                duration: 0.6, 
                delay: index * 0.12,
                ease: [0.4, 0, 0.2, 1]
              }}
              whileHover={{ 
                scale: 1.03, 
                y: -8,
                transition: { duration: 0.3 }
              }}
              className="relative group"
            >
              {/* Card with enhanced styling */}
              <div className="cyber-card p-8 relative overflow-hidden h-full">
                {/* Subtle corner accents */}
                <div className="absolute top-0 left-0 w-16 h-16 border-t-2 border-l-2 border-cyber-blue/20 group-hover:border-cyber-blue/60 transition-colors duration-300" />
                <div className="absolute top-0 right-0 w-16 h-16 border-t-2 border-r-2 border-cyber-blue/20 group-hover:border-cyber-blue/60 transition-colors duration-300" />
                
                {/* Hover glow effect */}
                <motion.div
                  className="absolute inset-0 bg-gradient-to-br from-cyber-blue/5 via-transparent to-cyber-purple/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                  animate={{
                    opacity: [0, 0.05, 0],
                  }}
                  transition={{
                    duration: 4,
                    repeat: Infinity,
                    ease: "easeInOut"
                  }}
                />
              
                <div className="relative z-10">
                  {/* Avatar with enhanced design */}
                  <div className="flex justify-center mb-6">
                    <motion.div
                      className="relative"
                      whileHover={{ scale: 1.1, rotate: [0, -5, 5, 0] }}
                      transition={{ duration: 0.5 }}
                    >
                      <motion.div
                        className="w-28 h-28 rounded-full bg-gradient-to-br from-cyber-blue via-cyber-cyan to-cyber-purple p-[2px]"
                        animate={{
                          boxShadow: [
                            '0 0 20px rgba(0, 224, 255, 0.3)',
                            '0 0 30px rgba(0, 224, 255, 0.5)',
                            '0 0 20px rgba(0, 224, 255, 0.3)',
                          ],
                        }}
                        transition={{
                          duration: 3,
                          repeat: Infinity,
                          ease: "easeInOut"
                        }}
                      >
                        <div className="w-full h-full rounded-full bg-cyber-dark flex items-center justify-center relative">
                          {/* Inner glow */}
                          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-cyber-blue/20 to-transparent opacity-50" />
                          <span className="font-orbitron text-3xl font-bold text-white relative z-10">
                            {member.image}
                          </span>
                        </div>
                      </motion.div>
                      
                      {/* Icon badge */}
                      <motion.div
                        className="absolute -bottom-1 -right-1 bg-gradient-to-br from-cyber-blue to-cyber-cyan rounded-full p-2.5 border-3 border-cyber-black shadow-lg"
                        whileHover={{ scale: 1.15, rotate: 10 }}
                        animate={{
                          boxShadow: [
                            '0 0 10px rgba(0, 224, 255, 0.4)',
                            '0 0 20px rgba(0, 224, 255, 0.6)',
                            '0 0 10px rgba(0, 224, 255, 0.4)',
                          ],
                        }}
                        transition={{
                          duration: 2,
                          repeat: Infinity,
                          ease: "easeInOut"
                        }}
                      >
                        <member.icon className="w-5 h-5 text-white" strokeWidth={2} />
                      </motion.div>
                    </motion.div>
                  </div>

                  {/* Name & Role */}
                  <div className="text-center mb-6">
                    <motion.h3
                      className="font-orbitron text-2xl font-bold text-white mb-2"
                      initial={{ opacity: 0 }}
                      animate={isInView ? { opacity: 1 } : {}}
                      transition={{ delay: index * 0.12 + 0.3 }}
                    >
                      {member.name}
                    </motion.h3>
                    <motion.p
                      className="font-exo text-sm text-cyber-blue font-semibold tracking-wider uppercase"
                      initial={{ opacity: 0 }}
                      animate={isInView ? { opacity: 1 } : {}}
                      transition={{ delay: index * 0.12 + 0.4 }}
                    >
                      {member.role}
                    </motion.p>
                  </div>

                  {/* Certifications */}
                  <motion.div
                    className="mb-6"
                    initial={{ opacity: 0, y: 10 }}
                    animate={isInView ? { opacity: 1, y: 0 } : {}}
                    transition={{ delay: index * 0.12 + 0.5 }}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <Award className="w-5 h-5 text-cyber-cyan" />
                      <h4 className="font-orbitron text-xs font-semibold text-gray-300 uppercase tracking-wider">
                        Certifications
                      </h4>
                    </div>
                    <ul className="space-y-2">
                      {member.certifications.map((cert, idx) => (
                        <motion.li
                          key={idx}
                          initial={{ opacity: 0, x: -10 }}
                          animate={isInView ? { opacity: 1, x: 0 } : {}}
                          transition={{ delay: index * 0.12 + 0.6 + idx * 0.08 }}
                          className="flex items-start gap-2.5 group/cert"
                        >
                          <motion.div
                            whileHover={{ scale: 1.2, rotate: 180 }}
                            transition={{ duration: 0.3 }}
                          >
                            <CheckCircle2 className="w-4 h-4 text-cyber-blue mt-0.5 flex-shrink-0" />
                          </motion.div>
                          <span className="font-exo text-xs text-gray-400 group-hover/cert:text-gray-300 transition-colors leading-relaxed">
                            {cert}
                          </span>
                        </motion.li>
                      ))}
                    </ul>
                  </motion.div>

                  {/* Expertise */}
                  <motion.div
                    className="mb-6 pb-6 border-b border-cyber-blue/20"
                    initial={{ opacity: 0, y: 10 }}
                    animate={isInView ? { opacity: 1, y: 0 } : {}}
                    transition={{ delay: index * 0.12 + 0.7 }}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <GraduationCap className="w-5 h-5 text-cyber-cyan" />
                      <h4 className="font-orbitron text-xs font-semibold text-gray-300 uppercase tracking-wider">
                        Expertise
                      </h4>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {member.expertise.map((skill, idx) => (
                        <motion.span
                          key={idx}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={isInView ? { opacity: 1, scale: 1 } : {}}
                          transition={{ delay: index * 0.12 + 0.8 + idx * 0.06 }}
                          whileHover={{ 
                            scale: 1.05,
                            backgroundColor: 'rgba(0, 224, 255, 0.1)',
                            borderColor: '#00e0ff'
                          }}
                          className="px-3 py-1.5 bg-cyber-gray/40 border border-cyber-blue/30 rounded-md text-xs font-exo text-gray-400 hover:text-cyber-cyan transition-all cursor-default"
                        >
                          {skill}
                        </motion.span>
                      ))}
                    </div>
                  </motion.div>

                  {/* Contact */}
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={isInView ? { opacity: 1 } : {}}
                    transition={{ delay: index * 0.12 + 1 }}
                    className="flex items-center justify-center"
                  >
                    <motion.a
                      href={`mailto:${member.email}`}
                      whileHover={{ 
                        scale: 1.05,
                        boxShadow: '0 0 15px rgba(0, 224, 255, 0.4)'
                      }}
                      whileTap={{ scale: 0.95 }}
                      className="px-6 py-2.5 bg-gradient-to-r from-cyber-blue/20 to-cyber-cyan/20 border border-cyber-blue/40 rounded-lg font-orbitron text-sm font-semibold text-white hover:from-cyber-blue/30 hover:to-cyber-cyan/30 hover:border-cyber-blue/60 transition-all flex items-center gap-2 group/btn"
                    >
                      <Mail className="w-4 h-4 group-hover/btn:translate-x-1 transition-transform" />
                      Contact
                    </motion.a>
                  </motion.div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Trust Badge - Enhanced */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.7 }}
          className="relative"
        >
          <div className="cyber-card p-10 max-w-5xl mx-auto text-center relative overflow-hidden">
            {/* Subtle background pattern */}
            <div className="absolute inset-0 bg-gradient-to-br from-cyber-blue/5 via-transparent to-cyber-purple/5" />
            <motion.div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundImage: `radial-gradient(circle at 50% 50%, rgba(0, 224, 255, 0.1) 0%, transparent 70%)`,
              }}
              animate={{
                backgroundPosition: ['0% 0%', '100% 100%'],
              }}
              transition={{
                duration: 15,
                repeat: Infinity,
                repeatType: 'reverse',
              }}
            />
            
            <div className="relative z-10">
              <motion.div
                className="flex items-center justify-center gap-4 mb-6"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={isInView ? { opacity: 1, scale: 1 } : {}}
                transition={{ delay: 0.9 }}
              >
                <motion.div
                  animate={{ rotate: [0, 360] }}
                  transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                >
                  <Shield className="w-10 h-10 text-cyber-blue" strokeWidth={1.5} />
                </motion.div>
                <h3 className="font-orbitron text-2xl md:text-3xl font-bold bg-gradient-to-r from-cyber-blue via-cyber-cyan to-cyber-purple bg-clip-text text-transparent">
                  Certified Professionals
                </h3>
                <motion.div
                  animate={{ rotate: [360, 0] }}
                  transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                >
                  <Shield className="w-10 h-10 text-cyber-cyan" strokeWidth={1.5} />
                </motion.div>
              </motion.div>
              
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 1 }}
                className="font-exo text-gray-400 mb-8 text-base md:text-lg max-w-3xl mx-auto leading-relaxed"
              >
                Our team consists of certified cybersecurity professionals with industry-recognized credentials including CEH, CCNA, and Google Cybersecurity Certifications. Each member brings years of experience and proven expertise to every project.
              </motion.p>
              
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 1.1 }}
                className="grid grid-cols-1 md:grid-cols-3 gap-4"
              >
                {[
                  { label: 'Certified Ethical Hackers', icon: Shield },
                  { label: 'CCNA Certified', icon: Network },
                  { label: 'Google Certified', icon: Award },
                ].map((badge, idx) => (
                  <motion.div
                    key={badge.label}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={isInView ? { opacity: 1, scale: 1 } : {}}
                    transition={{ delay: 1.2 + idx * 0.1 }}
                    whileHover={{ 
                      scale: 1.05, 
                      y: -3,
                      transition: { duration: 0.3 }
                    }}
                    className="relative p-5 bg-cyber-gray/40 border border-cyber-blue/30 rounded-lg hover:border-cyber-blue/60 hover:bg-cyber-gray/50 transition-all group/badge"
                  >
                    <motion.div
                      className="absolute inset-0 bg-gradient-to-br from-cyber-blue/10 to-transparent opacity-0 group-hover/badge:opacity-100 transition-opacity rounded-lg"
                    />
                    <div className="relative z-10 flex flex-col items-center gap-3">
                      <motion.div
                        whileHover={{ rotate: 360 }}
                        transition={{ duration: 0.6 }}
                      >
                        <badge.icon className="w-8 h-8 text-cyber-cyan" strokeWidth={1.5} />
                      </motion.div>
                      <span className="font-orbitron text-sm font-semibold text-gray-300">
                        {badge.label}
                      </span>
                      <div className="flex gap-1 mt-1">
                        {[1, 2, 3].map((i) => (
                          <motion.div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full bg-cyber-blue"
                            animate={{
                              opacity: [0.4, 1, 0.4],
                            }}
                            transition={{
                              duration: 2,
                              repeat: Infinity,
                              delay: i * 0.3,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default Team;

