import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Database, Loader } from 'lucide-react';
import { supabase } from '../../supabaseClient';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';

const SeedPostsButton = () => {
  const [loading, setLoading] = useState(false);
  const { session } = useAuth();

  const seedPosts = async () => {
    if (!session?.user) {
      toast.error('Please sign in first to seed posts.');
      return;
    }

    setLoading(true);
    
    const userId = session.user.id;

    const samplePosts = [
      {
        title: 'Portlock v2.0 - Advanced Network Scanner',
        content: 'Just released Portlock v2.0 with enhanced scanning capabilities and AI-powered threat detection. The new version includes real-time vulnerability assessment and automated patch recommendations.',
        category: 'tool',
        link: 'https://github.com/clawnet/portlock',
        tags: ['NetworkSecurity', 'Scanner', 'AI'],
        code_snippet: 'const scanner = new PortlockScanner();\nscanner.scan("192.168.1.0/24");\nscanner.on("threat", (data) => {\n  console.log("Threat:", data);\n});',
        user_id: userId,
      },
      {
        title: 'Neural Network Defense Patterns',
        content: 'Discussion on implementing neural network-based defense mechanisms for enterprise networks. Looking for insights on training data and model optimization.',
        category: 'research',
        tags: ['AI', 'NeuralNetworks', 'Defense'],
        user_id: userId,
      },
      {
        title: 'Quantum Encryption Implementation',
        content: 'Working on a quantum-resistant encryption protocol for secure communications. Early testing shows promising results against quantum attacks.',
        category: 'project',
        link: 'https://github.com/clawnet/quantum-encryption',
        tags: ['Quantum', 'Encryption', 'Security'],
        code_snippet: 'class QuantumEncryption {\n  encrypt(message, key) {\n    return this.process(message, key);\n  }\n}',
        user_id: userId,
      },
      {
        title: 'ClawView Integration Best Practices',
        content: 'What are your experiences integrating ClawView into existing security infrastructures? Share your setup tips and common pitfalls.',
        category: 'discussion',
        tags: ['ClawView', 'Integration', 'BestPractices'],
        user_id: userId,
      },
      {
        title: 'Automated Threat Response System',
        content: 'Built an automated system that responds to threats in real-time using ClawNet Core. It can isolate compromised systems within seconds.',
        category: 'tool',
        tags: ['Automation', 'ThreatResponse', 'ClawNetCore'],
        code_snippet: 'const response = await clawNetCore.detectThreat();\nif (response.severity > 7) {\n  await isolateSystem(response.target);\n}',
        user_id: userId,
      },
      {
        title: 'Zero-Day Detection Research',
        content: 'Research paper on using machine learning to detect zero-day exploits before they become widespread. Looking for collaborators.',
        category: 'research',
        link: 'https://arxiv.org/abs/2024.xxxxx',
        tags: ['ZeroDay', 'ML', 'Research'],
        user_id: userId,
      },
      {
        title: 'Dark Web Monitoring Tool',
        content: 'New tool that monitors dark web forums for mentions of your organization. Helps identify potential threats before they materialize.',
        category: 'tool',
        tags: ['DarkWeb', 'Monitoring', 'ThreatIntelligence'],
        user_id: userId,
      },
      {
        title: 'AI vs Traditional Security',
        content: 'Debate: Are AI-powered security tools making traditional methods obsolete, or should they work together? What\'s your take?',
        category: 'discussion',
        tags: ['AI', 'Security', 'Discussion'],
        user_id: userId,
      },
      {
        title: 'ClawNet API Wrapper for Python',
        content: 'Created a Python wrapper for the ClawNet API. Makes it easy to integrate ClawNet services into Python applications.',
        category: 'project',
        link: 'https://github.com/clawnet/python-sdk',
        tags: ['Python', 'API', 'SDK'],
        code_snippet: 'from clawnet import ClawNetClient\nclient = ClawNetClient(api_key="key")\nthreats = client.scan_network("192.168.1.0/24")',
        user_id: userId,
      },
      {
        title: 'Behavioral Analysis for Anomaly Detection',
        content: 'Implementing behavioral analysis to detect anomalies in user activities. This approach has reduced false positives by 80%.',
        category: 'research',
        tags: ['BehavioralAnalysis', 'AnomalyDetection', 'Research'],
        user_id: userId,
      },
    ];

    const { data, error } = await supabase
      .from('posts')
      .insert(samplePosts)
      .select();

    setLoading(false);

    if (error) {
      toast.error(`Error: ${error.message}`);
      return;
    }

    toast.success(`Successfully added ${data.length} sample posts!`);
    window.location.reload();
  };

  if (!session?.user) {
    return null; // Don't show button if not logged in
  }

  return (
    <motion.button
      onClick={seedPosts}
      disabled={loading}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      className="fixed bottom-20 right-6 z-40 px-4 py-2 bg-cyber-gray border border-cyber-blue/50 rounded-lg text-cyber-blue text-sm font-mono hover:bg-cyber-gray/80 transition-colors disabled:opacity-50"
      title="Add 10 sample posts to The Grid"
    >
      {loading ? (
        <Loader className="animate-spin inline mr-2" size={16} />
      ) : (
        <Database className="inline mr-2" size={16} />
      )}
      {loading ? 'Seeding...' : 'Seed Posts'}
    </motion.button>
  );
};

export default SeedPostsButton;

