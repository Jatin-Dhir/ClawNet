import React, { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

const Blog = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  const researchPosts = [
    {
      id: 'qrc-decentralized',
      category: 'CRYPTOGRAPHY',
      title: 'Quantum-Resistant Cryptography for Decentralized Networks',
      excerpt: 'An analysis of lattice-based cryptographic algorithms and their application in securing next-generation mesh networks against quantum threats.',
    },
    {
      id: 'behavioral-biometrics',
      category: 'AUTHENTICATION',
      title: 'Behavioral Biometrics in Continuous Authentication',
      excerpt: 'This paper explores the use of keystroke dynamics and mouse movement patterns as a method for continuous, passive user verification.',
    },
    {
      id: 'adversarial-ml',
      category: 'MACHINE LEARNING',
      title: 'Adversarial ML: Poisoning Attacks on Threat Detection Models',
      excerpt: 'A study on the vulnerabilities of AI-based threat detection systems to data poisoning attacks and potential defensive strategies.',
    },
  ];

  return (
    <section id="intelligence" ref={ref} className="relative py-20 md:py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-cyber-black via-cyber-dark to-cyber-black" />
      
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
          className="text-center mb-16"
        >
          <h2 className="section-title mb-6">Latest Intelligence</h2>
          <p className="font-exo text-lg md:text-xl text-gray-400 max-w-3xl mx-auto">
            Our research from the frontlines of cyber warfare.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {researchPosts.map((post, index) => (
            <motion.div
              key={post.id}
              initial={{ opacity: 0, y: 60, scale: 0.95 }}
              animate={isInView ? { opacity: 1, y: 0, scale: 1 } : {}}
              transition={{ 
                duration: 0.7, 
                delay: index * 0.15,
                ease: [0.4, 0, 0.2, 1]
              }}
              className="h-full"
            >
              <Link to={`/research/${post.id}`} className="h-full block">
                <motion.div
                  whileHover={{ 
                    y: -12, 
                    scale: 1.03,
                    transition: { duration: 0.3 }
                  }}
                  className="cyber-card flex flex-col group h-full p-6"
                >
                  <span className="font-orbitron text-xs font-bold text-cyber-blue mb-2">{post.category}</span>
                  <h3 className="font-orbitron text-xl font-bold text-white mb-3 flex-grow">{post.title}</h3>
                  <p className="font-exo text-gray-400 mb-4 text-sm">{post.excerpt}</p>
                  <div className="font-exo text-sm font-semibold text-cyber-cyan hover:text-white mt-auto flex items-center gap-2">
                    Read Research
                    <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform duration-300" />
                  </div>
                </motion.div>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Blog;
