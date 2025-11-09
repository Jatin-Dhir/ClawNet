import React, { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Lock, Cpu, Activity, ArrowRight } from 'lucide-react';

const Products = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  const products = [
    {
      slug: 'portlock',
      name: 'PortLock',
      icon: Lock,
      description: 'Advanced USB access control system. Encrypts your USB ports to protect from CyberThreats.',
      color: 'blue',
      gradient: 'from-cyber-blue to-cyan-400',
      glowColor: 'rgba(0, 224, 255, 0.4)',
    },
    {
      slug: 'clawnet-core',
      name: 'ClawNet Core',
      icon: Cpu,
      description: 'An offline, encrypted mesh networking system for secure, peer-to-peer communication without relying on the internet or centralized infrastructure.',
      color: 'purple',
      gradient: 'from-cyber-purple to-pink-500',
      glowColor: 'rgba(155, 48, 255, 0.4)',
    },
    {
      slug: 'clawview',
      name: 'ClawView',
      icon: Activity,
      description: 'A real-time network traffic visualizer and threat monitoring dashboard. See your network\'s pulse and spot anomalies instantly.',
      color: 'cyan',
      gradient: 'from-cyber-cyan to-blue-400',
      glowColor: 'rgba(0, 245, 255, 0.4)',
    },
  ];

  return (
    <section id="tools" ref={ref} className="relative py-20 md:py-32 overflow-hidden">
      <div className="absolute inset-0 bg-cyber-black" />
      
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
          className="text-center mb-12 sm:mb-16 px-2 sm:px-0"
        >
          <h2 className="section-title mb-6">The Tools</h2>
          <p className="font-exo text-base sm:text-lg md:text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
            Next-generation cybersecurity solutions built for the modern threat landscape
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
          {products.map((product, index) => (
            <Link to={`/tools/${product.slug}`} key={product.name} className="block h-full touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-cyber-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-cyber-black rounded-2xl">
              <motion.div
                initial={{ opacity: 0, y: 60, scale: 0.9 }}
                animate={isInView ? { opacity: 1, y: 0, scale: 1 } : {}}
                transition={{ 
                  duration: 0.7, 
                  delay: index * 0.15,
                  ease: [0.4, 0, 0.2, 1]
                }}
                whileHover={{ 
                  y: -12, 
                  scale: 1.03,
                  transition: { duration: 0.3 }
                }}
                whileTap={{ scale: 0.99 }}
                className="group relative h-full"
              >
                <div className="absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-lg blur-xl" 
                     style={{ background: `radial-gradient(circle, ${product.glowColor} 0%, transparent 70%)` }} 
                />
                
                <div className="relative cyber-card p-6 sm:p-8 h-full flex flex-col rounded-2xl">
                  <div className="mb-5 sm:mb-6">
                    <motion.div
                      className={`inline-flex p-3.5 sm:p-4 rounded-lg bg-gradient-to-br ${product.gradient} bg-opacity-10`}
                      whileHover={{ rotate: 360 }}
                      transition={{ duration: 0.6 }}
                    >
                      <product.icon className="w-7 h-7 sm:w-8 sm:h-8 text-white" strokeWidth={2} />
                    </motion.div>
                  </div>

                  <h3 className="font-orbitron text-xl sm:text-2xl font-bold text-white mb-3 sm:mb-4 leading-tight">
                    {product.name}
                  </h3>

                  <p className="font-exo text-sm sm:text-base text-gray-400 mb-6 flex-grow leading-relaxed">
                    {product.description}
                  </p>

                  <div
                    className={`mt-auto w-full py-3 px-5 sm:px-6 rounded-lg font-orbitron text-xs sm:text-sm font-semibold flex items-center justify-center gap-2 transition-all duration-300 bg-gradient-to-r ${product.gradient} bg-opacity-20 border group-hover:bg-opacity-30 text-white`}
                    style={{ 
                      borderColor: product.color === 'blue' ? '#00e0ff' : product.color === 'purple' ? '#9b30ff' : '#00f5ff',
                    }}
                  >
                    View Details
                    <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                  </div>

                  <motion.div
                    className="absolute top-0 left-0 w-full h-[3px] bg-gradient-to-r opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-t-lg"
                    style={{ background: `linear-gradient(to right, ${product.glowColor}, transparent)` }}
                  />
                </div>
              </motion.div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Products;
