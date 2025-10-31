import React from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, FileText, Share2, Download } from 'lucide-react';

const researchData = {
    'qrc-decentralized': {
      category: 'CRYPTOGRAPHY',
      title: 'Quantum-Resistant Cryptography for Decentralized Networks',
      author: 'Dr. Evelyn Reed',
      date: 'October 26, 2025',
      abstract: 'This paper presents a comprehensive analysis of lattice-based cryptographic algorithms, specifically focusing on Crystals-Kyber and Crystals-Dilithium, as viable candidates for securing decentralized, peer-to-peer mesh networks against threats posed by quantum computers. We evaluate performance metrics, key sizes, and implementation complexities within resource-constrained environments typical of IoT nodes in a mesh network.',
      content: [
        { type: 'h3', text: '1. Introduction' },
        { type: 'p', text: 'The advent of quantum computing poses a significant threat to classical cryptographic systems. Asymmetric algorithms like RSA and ECC, which underpin much of modern digital security, will be rendered insecure. This research addresses the urgent need for quantum-resistant solutions, particularly in the context of decentralized systems like ClawNet Core, which cannot rely on centralized certificate authorities for updates.' },
        { type: 'h3', text: '2. Lattice-Based Cryptography' },
        { type: 'p', text: 'Lattice-based cryptography is a leading family of post-quantum cryptographic (PQC) candidates. Its security is based on the presumed difficulty of solving certain mathematical problems on lattices, such as the Shortest Vector Problem (SVP) and Learning With Errors (LWE). We focus on the NIST PQC standardization finalists, Crystals-Kyber for key encapsulation and Crystals-Dilithium for digital signatures.' },
        { type: 'h3', text: '3. Performance Analysis' },
        { type: 'p', text: 'Our analysis was conducted on a simulated network of 64 nodes with varying processing capabilities. We measured key generation time, encapsulation/decapsulation speed, and signature verification overhead. Results indicate that while key sizes are larger than their classical counterparts, the computational overhead is acceptable for most modern embedded systems, with an average handshake latency increase of 18% compared to ECC.' },
        { type: 'h3', text: '4. Conclusion' },
        { type: 'p', text: 'Lattice-based cryptography presents a robust and performant solution for securing decentralized networks in the quantum era. We recommend the adoption of a hybrid scheme (classic ECC + Crystals-Kyber) during the transition period to ensure backward compatibility while providing forward secrecy against future quantum adversaries. Further research is needed to optimize implementations for ultra-low-power devices.' },
      ]
    },
    'behavioral-biometrics': {
      category: 'AUTHENTICATION',
      title: 'Behavioral Biometrics in Continuous Authentication',
      author: 'Dr. Kenji Tanaka',
      date: 'November 15, 2025',
      abstract: 'This paper explores the efficacy of using behavioral biometrics—specifically keystroke dynamics, mouse movement patterns, and touchscreen gestures—as a mechanism for continuous and passive user authentication. We propose a model based on a recurrent neural network (RNN) that creates a dynamic trust score, capable of detecting session hijacking in real-time without interrupting the user.',
      content: [
        { type: 'h3', text: '1. The Problem with Static Authentication' },
        { type: 'p', text: 'Traditional authentication is a one-time event. Once a user is authenticated, the system implicitly trusts all subsequent actions within that session. This creates a significant vulnerability to session hijacking, credential theft, and insider threats. Continuous authentication aims to solve this by repeatedly verifying the user\'s identity throughout the session.' },
        { type: 'h3', text: '2. Data Collection and Feature Extraction' },
        { type: 'p', text: 'Our model collects data passively in the background. For keystroke dynamics, we capture timing information such as dwell time (key press duration) and flight time (time between key presses). For mouse movements, we analyze velocity, acceleration, curvature, and idle time. These features are normalized and fed into our RNN model.' },
        { type:- 'h3', text: '3. The RNN Trust Score Model' },
        { type: 'p', text: 'We utilize a Long Short-Term Memory (LSTM) network, a type of RNN, to learn the temporal patterns of a user\'s behavior. The model outputs a "trust score" between 0 and 1 every 30 seconds. If the score drops below a predefined threshold (e.g., 0.6) for a sustained period, the system can trigger a secondary authentication challenge, such as a password prompt or a push notification.' },
        { type: 'h3', text: '4. Results and Future Work' },
        { type: 'p', text: 'In a controlled study with 50 participants, our model achieved a 96% accuracy rate in detecting anomalous behavior within 90 seconds of a "hijack" event, with a false positive rate of only 2%. Future work will focus on reducing the model\'s footprint to enable deployment on mobile devices and integrating it with endpoint detection and response (EDR) systems like ClawView.' },
      ]
    },
    'adversarial-ml': {
      category: 'MACHINE LEARNING',
      title: 'Adversarial ML: Poisoning Attacks on Threat Detection Models',
      author: 'Jasmine Kaur',
      date: 'December 5, 2025',
      abstract: 'As machine learning becomes integral to cybersecurity, the models themselves become targets. This research investigates the vulnerability of AI-based network threat detection systems to data poisoning attacks. We demonstrate how a sophisticated attacker can subtly manipulate the training data to create backdoors, causing the model to misclassify specific types of malicious traffic as benign.',
      content: [
        { type: 'h3', text: '1. The New Attack Surface' },
        { type: 'p', text: 'AI-driven security tools, like those in ClawView, are trained on vast datasets of network traffic. Data poisoning is a type of causative attack where the adversary injects malicious samples into this training data. The goal is to corrupt the learned model in a way that benefits the attacker during the operational phase.' },
        { type: 'h3', text: '2. Attack Methodology: Backdoor Injection' },
        { type: 'p', text: 'We simulated an attack on a convolutional neural network (CNN) trained to classify network packets. The attacker\'s goal was to make the model ignore a specific command-and-control (C2) signature. By injecting a small number (less than 0.5%) of carefully crafted malicious packets labeled as benign into the training set, we were able to create a "backdoor." The model learned to associate a specific, innocuous trigger (e.g., a particular packet size or timing pattern) with benign traffic, effectively ignoring the real malicious payload when that trigger was present.' },
        { type: 'h3', text: '3. Defensive Strategies' },
        { type: 'p', text: 'We explored several defensive techniques. Data sanitization, which attempts to filter out anomalous training samples, proved partially effective but could be bypassed by more subtle attacks. A more promising approach is differential privacy, which adds statistical noise to the training process, making it harder for the model to overfit on specific poisoned examples. We also found that ensemble methods, using multiple models trained on different subsets of data, significantly increased the difficulty of a successful poisoning attack.' },
        { type: 'h3', text: '4. Conclusion' },
        { type: 'p', text: 'Data poisoning represents a serious threat to the next generation of AI-powered security systems. A defense-in-depth approach, combining data sanitization, robust training methodologies like differential privacy, and continuous model monitoring, is essential to mitigate this risk. Security vendors must assume their training pipelines are hostile environments.' },
      ]
    },
  };

const ResearchPage = () => {
  const { postId } = useParams();
  const post = researchData[postId];

  if (!post) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen pt-32 pb-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <Link to="/#intelligence" className="flex items-center gap-2 text-cyber-cyan hover:text-white mb-8 group">
            <ArrowLeft size={18} className="group-hover:-translate-x-1 transition-transform" />
            <span className="font-exo">Back to Intelligence Feed</span>
          </Link>

          <div className="mb-8">
            <span className="font-orbitron text-sm font-bold text-cyber-blue">{post.category}</span>
            <h1 className="section-title mt-2 mb-4">{post.title}</h1>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-400 font-exo">
              <span>By: <span className="font-semibold text-gray-300">{post.author}</span></span>
              <span>Published: <span className="font-semibold text-gray-300">{post.date}</span></span>
            </div>
          </div>
          
          <div className="cyber-card p-6 md:p-8">
            <div className="mb-8 border-l-4 border-cyber-blue pl-4">
              <h2 className="font-orbitron text-xl font-bold text-white mb-2">Abstract</h2>
              <p className="font-exo text-gray-300 italic">{post.abstract}</p>
            </div>

            <article className="prose prose-invert prose-p:text-gray-300 prose-h3:text-cyber-cyan prose-h3:font-orbitron">
              {post.content.map((item, index) => {
                if (item.type === 'h3') return <h3 key={index}>{item.text}</h3>;
                if (item.type === 'p') return <p key={index}>{item.text}</p>;
                return null;
              })}
            </article>

            <div className="mt-12 pt-6 border-t border-cyber-blue/20 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <motion.button whileHover={{scale: 1.1}} whileTap={{scale: 0.9}} className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors">
                  <Share2 size={18} />
                  <span className="text-sm font-exo">Share</span>
                </motion.button>
              </div>
              <motion.button 
                onClick={() => {
                  // Generate PDF-like content
                  let pdfContent = `\n\n`;
                  pdfContent += `═══════════════════════════════════════════════════════════\n`;
                  pdfContent += `${post.title.toUpperCase()}\n`;
                  pdfContent += `═══════════════════════════════════════════════════════════\n\n`;
                  pdfContent += `Category: ${post.category}\n`;
                  pdfContent += `Author: ${post.author}\n`;
                  pdfContent += `Date: ${post.date}\n\n`;
                  pdfContent += `───────────────────────────────────────────────────────────────\n`;
                  pdfContent += `ABSTRACT\n`;
                  pdfContent += `───────────────────────────────────────────────────────────────\n\n`;
                  pdfContent += `${post.abstract}\n\n\n`;
                  pdfContent += `───────────────────────────────────────────────────────────────\n`;
                  pdfContent += `CONTENT\n`;
                  pdfContent += `───────────────────────────────────────────────────────────────\n\n`;
                  post.content.forEach(item => {
                    if (item.type === 'h3') {
                      pdfContent += `\n${item.text}\n`;
                      pdfContent += `${'-'.repeat(60)}\n\n`;
                    } else if (item.type === 'p') {
                      pdfContent += `${item.text}\n\n`;
                    }
                  });
                  pdfContent += `\n\n═══════════════════════════════════════════════════════════\n`;
                  pdfContent += `© ClawNet Security - Research Intelligence Division\n`;
                  pdfContent += `This is a sample document. Actual PDF will be available soon.\n`;
                  pdfContent += `═══════════════════════════════════════════════════════════\n`;

                  const blob = new Blob([pdfContent], { type: 'text/plain' });
                  const url = window.URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = `${post.title.replace(/\s+/g, '-').toLowerCase()}-research.txt`;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  window.URL.revokeObjectURL(url);
                }}
                whileHover={{scale: 1.05}} 
                whileTap={{scale: 0.95}} 
                className="flex items-center gap-2 px-4 py-2 bg-cyber-blue/80 text-cyber-darker font-orbitron font-bold rounded-md text-sm hover:bg-cyber-blue transition-colors"
              >
                <Download size={16} />
                Download PDF
              </motion.button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default ResearchPage;
