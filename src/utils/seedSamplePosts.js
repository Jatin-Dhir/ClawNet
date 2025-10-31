// Utility to seed sample posts (run once in browser console)
export const seedSamplePosts = async (supabase) => {
  // First, get or create a demo user profile
  const demoUserId = '00000000-0000-0000-0000-000000000000'; // Demo UUID
  
  const samplePosts = [
    {
      title: 'Portlock v2.0 - Advanced Network Scanner',
      content: 'Just released Portlock v2.0 with enhanced scanning capabilities and AI-powered threat detection. The new version includes real-time vulnerability assessment and automated patch recommendations.',
      category: 'tool',
      link: 'https://github.com/clawnet/portlock',
      tags: ['NetworkSecurity', 'Scanner', 'AI', 'Portlock'],
      code_snippet: 'const scanner = new PortlockScanner();\nscanner.scan("192.168.1.0/24");\nscanner.on("threat", (data) => {\n  console.log("Threat detected:", data);\n});',
    },
    {
      title: 'Neural Network Defense Patterns',
      content: 'Discussion on implementing neural network-based defense mechanisms for enterprise networks. Looking for insights on training data and model optimization.',
      category: 'research',
      link: null,
      tags: ['AI', 'NeuralNetworks', 'Defense', 'Research'],
      code_snippet: null,
    },
    {
      title: 'Quantum Encryption Implementation',
      content: 'Working on a quantum-resistant encryption protocol for secure communications. Early testing shows promising results against quantum attacks.',
      category: 'project',
      link: 'https://github.com/clawnet/quantum-encryption',
      tags: ['Quantum', 'Encryption', 'Security', 'Cryptography'],
      code_snippet: 'class QuantumEncryption {\n  encrypt(message, key) {\n    // Quantum-resistant algorithm\n    return this.process(message, key);\n  }\n}',
    },
    {
      title: 'ClawView Integration Best Practices',
      content: 'What are your experiences integrating ClawView into existing security infrastructures? Share your setup tips and common pitfalls to avoid.',
      category: 'discussion',
      link: null,
      tags: ['ClawView', 'Integration', 'BestPractices', 'Discussion'],
      code_snippet: null,
    },
    {
      title: 'Automated Threat Response System',
      content: 'Built an automated system that responds to threats in real-time using ClawNet Core. It can isolate compromised systems within seconds.',
      category: 'tool',
      link: null,
      tags: ['Automation', 'ThreatResponse', 'ClawNetCore', 'Tool'],
      code_snippet: 'const response = await clawNetCore.detectThreat();\nif (response.severity > 7) {\n  await isolateSystem(response.target);\n  await notifySecurityTeam(response);\n}',
    },
    {
      title: 'Zero-Day Detection Research',
      content: 'Research paper on using machine learning to detect zero-day exploits before they become widespread. Looking for collaborators.',
      category: 'research',
      link: 'https://arxiv.org/abs/2024.xxxxx',
      tags: ['ZeroDay', 'ML', 'Research', 'Detection'],
      code_snippet: null,
    },
    {
      title: 'Dark Web Monitoring Tool',
      content: 'New tool that monitors dark web forums for mentions of your organization. Helps identify potential threats before they materialize.',
      category: 'tool',
      link: null,
      tags: ['DarkWeb', 'Monitoring', 'ThreatIntelligence', 'Tool'],
      code_snippet: null,
    },
    {
      title: 'AI vs Traditional Security',
      content: 'Debate: Are AI-powered security tools making traditional security methods obsolete, or should they work together? What\'s your take?',
      category: 'discussion',
      link: null,
      tags: ['AI', 'Security', 'Discussion', 'Debate'],
      code_snippet: null,
    },
    {
      title: 'ClawNet API Wrapper for Python',
      content: 'Created a Python wrapper for the ClawNet API. Makes it easy to integrate ClawNet services into Python applications.',
      category: 'project',
      link: 'https://github.com/clawnet/python-sdk',
      tags: ['Python', 'API', 'SDK', 'Project'],
      code_snippet: 'from clawnet import ClawNetClient\n\nclient = ClawNetClient(api_key="your_key")\nthreats = client.scan_network("192.168.1.0/24")',
    },
    {
      title: 'Behavioral Analysis for Anomaly Detection',
      content: 'Implementing behavioral analysis to detect anomalies in user activities. This approach has reduced false positives by 80%.',
      category: 'research',
      link: null,
      tags: ['BehavioralAnalysis', 'AnomalyDetection', 'Research', 'ML'],
      code_snippet: null,
    },
  ];

  try {
    // Check if demo user exists, create if not
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', demoUserId)
      .single();

    if (!existingProfile) {
      // Create demo profile (this will require auth bypass in dev, or use a real user)
      console.log('Demo user profile needed. Please create a user first or modify user_id.');
      return;
    }

    // Insert sample posts
    const postsToInsert = samplePosts.map(post => ({
      ...post,
      user_id: demoUserId, // Replace with actual user ID
    }));

    const { data, error } = await supabase
      .from('posts')
      .insert(postsToInsert)
      .select();

    if (error) {
      console.error('Error seeding posts:', error);
      return;
    }

    console.log(`Successfully seeded ${data.length} sample posts!`);
    return data;
  } catch (error) {
    console.error('Error in seedSamplePosts:', error);
  }
};

