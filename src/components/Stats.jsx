import React, { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Users, Shield, Zap, TrendingUp, Target, Lock } from 'lucide-react';

const Stats = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  const stats = [
    {
      icon: Users,
      value: '240+',
      label: 'Early Adopters',
      color: 'from-cyber-blue to-cyber-cyan',
      description: 'Building with us since launch',
    },
    {
      icon: Shield,
      value: '1,200+',
      label: 'Threats Detected',
      color: 'from-cyber-purple to-pink-500',
      description: 'In beta testing phase',
    },
    {
      icon: Zap,
      value: '99.5%',
      label: 'System Uptime',
      color: 'from-cyber-cyan to-blue-400',
      description: 'Growing infrastructure',
    },
    {
      icon: TrendingUp,
      value: '3.2x',
      label: 'Faster Detection',
      color: 'from-green-400 to-emerald-500',
      description: 'Vs. traditional methods',
    },
  ];

  const features = [
    {
      icon: Target,
      title: 'Real-Time Threat Detection',
      description: 'AI-powered analysis detects threats milliseconds after they appear.',
      delay: 0,
    },
    {
      icon: Lock,
      title: 'Zero-Trust Architecture',
      description: 'Every device, every connection is verified and encrypted.',
      delay: 0.2,
    },
  ];

  return (
    <section id="stats" ref={ref} className="relative py-20 md:py-32 overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-cyber-black via-cyber-dark to-cyber-black" />
        <motion.div
          className="absolute inset-0 opacity-30"
          animate={{
            backgroundPosition: ['0% 0%', '100% 100%'],
          }}
          transition={{
            duration: 30,
            repeat: Infinity,
            repeatType: 'reverse',
          }}
          style={{
            backgroundImage: 'radial-gradient(circle at 50% 50%, rgba(0, 224, 255, 0.15) 0%, transparent 70%)',
            backgroundSize: '200% 200%',
          }}
        />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Stats Grid */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] }}
          className="text-center mb-20"
        >
          <h2 className="section-title mb-4">Building the Future</h2>
          <p className="font-exo text-lg text-gray-400 max-w-2xl mx-auto">
            Growing fast with early adopters and beta testers
          </p>
        </motion.div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-24">
          {stats.map((stat, index) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 30, scale: 0.9 }}
              animate={isInView ? { opacity: 1, y: 0, scale: 1 } : {}}
              transition={{ 
                duration: 0.6, 
                delay: index * 0.1,
                ease: [0.4, 0, 0.2, 1]
              }}
              whileHover={{ 
                y: -8, 
                scale: 1.05,
                transition: { duration: 0.3 }
              }}
              className="relative group"
            >
              <div className="cyber-card p-6 h-full text-center relative overflow-hidden">
                {/* Animated gradient background */}
                <motion.div
                  className={`absolute inset-0 bg-gradient-to-br ${stat.color} opacity-0 group-hover:opacity-10 transition-opacity duration-500`}
                  animate={{
                    backgroundPosition: ['0% 0%', '100% 100%'],
                  }}
                  transition={{
                    duration: 3,
                    repeat: Infinity,
                    repeatType: 'reverse',
                  }}
                />
                
                <motion.div
                  className="relative z-10"
                  whileHover={{ scale: 1.1 }}
                  transition={{ duration: 0.3 }}
                >
                  <stat.icon className="w-10 h-10 mx-auto mb-4 text-cyber-blue" />
                </motion.div>
                
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={isInView ? { opacity: 1 } : {}}
                  transition={{ delay: index * 0.1 + 0.3 }}
                >
                  <motion.h3 
                    className={`font-orbitron text-3xl md:text-4xl font-bold mb-2 bg-gradient-to-r ${stat.color} bg-clip-text text-transparent`}
                  >
                    {stat.value}
                  </motion.h3>
                  <p className="font-orbitron text-sm font-semibold text-gray-300 mb-1">
                    {stat.label}
                  </p>
                  <p className="font-exo text-xs text-gray-500">
                    {stat.description}
                  </p>
                </motion.div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Features */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, x: index % 2 === 0 ? -50 : 50 }}
              animate={isInView ? { opacity: 1, x: 0 } : {}}
              transition={{ 
                duration: 0.7, 
                delay: 0.5 + feature.delay,
                ease: [0.4, 0, 0.2, 1]
              }}
              whileHover={{ y: -5 }}
              className="cyber-card p-8 group"
            >
              <motion.div
                className="inline-flex p-4 rounded-lg bg-cyber-blue/10 border border-cyber-blue/20 mb-6"
                whileHover={{ 
                  rotate: 360,
                  scale: 1.1,
                  boxShadow: '0 0 20px rgba(0, 224, 255, 0.4)'
                }}
                transition={{ duration: 0.6 }}
              >
                <feature.icon className="w-6 h-6 text-cyber-blue" />
              </motion.div>
              
              <h3 className="font-orbitron text-2xl font-bold text-white mb-4">
                {feature.title}
              </h3>
              
              <p className="font-exo text-gray-400 leading-relaxed">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Stats;

