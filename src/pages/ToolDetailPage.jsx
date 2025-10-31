import React from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Lock, Cpu, Activity, ArrowLeft, Terminal, Code, HelpCircle } from 'lucide-react';

import PortlockDemo from '../components/products/PortlockDemo';
import ClawNetCoreDemo from '../components/products/ClawNetCoreDemo';
import ClawViewDemo from '../components/products/ClawViewDemo';
import DownloadSection from '../components/products/DownloadSection';

const toolsData = {
  portlock: {
    name: 'PortLock',
    icon: Lock,
    tagline: 'Advanced Endpoint & USB Access Control System',
    description: 'PortLock is an enterprise-grade endpoint security solution that provides granular control over USB ports and peripheral devices. It protects critical systems from data leakage, malware injection, and unauthorized access by enforcing real-time authentication and smart lockdown mechanisms.',
    idea: 'In an era of sophisticated physical and digital threats, the USB port remains a primary vector for attacks. PortLock was conceived to transform this vulnerability into a hardened defense layer, giving security teams absolute control over every endpoint without hindering authorized user productivity.',
    howItWorks: 'PortLock operates as a lightweight kernel-level agent that intercepts all device communication. Using a policy-based engine, it can allow, block, or require multi-factor authentication for any device. All events are logged for full auditability, providing complete visibility into endpoint activity.',
    setup: [
      'Download and run the installer with administrative permissions.',
      'On first launch, set a master password for the control console.',
      'Access the console to configure policies for new devices.',
      'Check logs to monitor all connected device activity and edit your password.',
    ],
    demo: <PortlockDemo />,
    compatibility: {
      linux: { available: true, version: 'v1.2.3' },
      windows: { available: false, comingSoon: true },
      macos: { available: false, comingSoon: false },
    },
  },
  'clawnet-core': {
    name: 'ClawNet Core',
    icon: Cpu,
    tagline: 'Decentralized & Encrypted Off-Grid Communication',
    description: 'ClawNet Core is an offline, encrypted mesh networking and communication system designed to operate entirely off the grid. It enables secure, peer-to-peer communication between connected nodes without relying on the internet or centralized infrastructure, creating resilient and private networks.',
    idea: 'Centralized communication networks are fragile and susceptible to surveillance. ClawNet Core was created to provide a truly sovereign communication solution for journalists, activists, and organizations operating in high-risk environments where privacy and uptime are non-negotiable.',
    howItWorks: 'The Core establishes a self-healing mesh network using various radio technologies (like LoRa) or existing local networks. Every message is end-to-end encrypted with post-quantum cryptographic standards. Nodes automatically route data through the most efficient path, ensuring the network remains operational even if some nodes go offline.',
    setup: [
      'Designate a primary device to act as the initial host for the mesh network.',
      'Run the ClawNet Core script on the host to initialize the network.',
      'Nearby nodes can now connect to the host\'s Wi-Fi access point.',
      'Enable "Relay Mode" on connected nodes to extend the mesh network\'s range.',
    ],
    demo: <ClawNetCoreDemo />,
    compatibility: {
      linux: { available: true, version: 'v0.8.1' },
      windows: { available: false, comingSoon: true },
      macos: { available: false, comingSoon: false },
    },
  },
  clawview: {
    name: 'ClawView',
    icon: Activity,
    tagline: 'AI-Driven Real-Time Threat Visualization',
    description: 'ClawView is a real-time network traffic visualizer and threat monitoring dashboard. It uses predictive analytics and machine learning to identify, classify, and visualize threats as they happen, transforming raw log data into actionable intelligence.',
    idea: 'Security analysts are often overwhelmed by a flood of data. ClawView was designed to cut through the noise, providing an intuitive, "at-a-glance" holographic view of network health and highlighting malicious patterns that would otherwise go unnoticed until it\'s too late.',
    howItWorks: 'ClawView ingests data from various sources (firewalls, IDS, logs) and feeds it into its AI-driven correlation engine. It maps network traffic geographically and logically, using color, motion, and intensity to represent threat levels. Anomalies are flagged instantly, allowing for rapid investigation and response.',
    setup: [
      'Install the ClawView dashboard application on your primary monitoring station.',
      'Connect your data sources (firewalls, IDS, logs) via the setup wizard.',
      'The SOC dashboard is ready to use instantly, providing immediate insights.',
      'Future updates will automatically integrate new AI-driven analysis modules.',
    ],
    demo: <ClawViewDemo />,
    compatibility: {
      linux: { available: true, version: 'v2.1.0' },
      windows: { available: true, version: 'v2.1.0' },
      macos: { available: false, comingSoon: false },
    },
  },
};

const Section = ({ title, icon: Icon, children }) => (
  <div className="mb-12">
    <div className="flex items-center gap-3 mb-4">
      <Icon className="w-6 h-6 text-cyber-blue" />
      <h2 className="font-orbitron text-2xl font-bold text-white">{title}</h2>
    </div>
    <div className="font-exo text-gray-300 leading-relaxed space-y-4 pl-9">
      {children}
    </div>
  </div>
);

const ToolDetailPage = () => {
  const { toolId } = useParams();
  const tool = toolsData[toolId];

  if (!tool) {
    return <Navigate to="/" replace />;
  }

  const { name, icon: Icon, tagline, description, idea, howItWorks, setup, demo, compatibility } = tool;

  return (
    <div className="pt-32 pb-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <Link to="/" className="flex items-center gap-2 text-cyber-cyan hover:text-white mb-8 group">
            <ArrowLeft size={18} className="group-hover:-translate-x-1 transition-transform" />
            <span className="font-exo">Back to Home</span>
          </Link>
          
          <div className="flex items-center gap-4 mb-4">
            <Icon className="w-12 h-12 text-cyber-blue" />
            <h1 className="section-title">{name}</h1>
          </div>
          <p className="font-exo text-xl text-gray-400 mb-12">{tagline}</p>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-12">
            <div className="lg:col-span-3">
              <Section title="Description" icon={HelpCircle}>
                <p>{description}</p>
              </Section>
              <Section title="The Idea" icon={Terminal}>
                <p>{idea}</p>
              </Section>
              <Section title="How It Works" icon={Code}>
                <p>{howItWorks}</p>
                <div className="cyber-card p-4 mt-4 border-l-4 border-cyber-blue">
                  <h4 className="font-orbitron text-lg font-semibold text-white mb-3">Step-by-Step Setup</h4>
                  <ol className="list-decimal list-inside space-y-2 text-gray-400">
                    {setup.map((step, index) => <li key={index}>{step}</li>)}
                  </ol>
                </div>
              </Section>
            </div>
            <div className="lg:col-span-2">
              <div className="sticky top-28">
                <div className="cyber-card aspect-square flex items-center justify-center p-4">
                  {demo}
                </div>
              </div>
            </div>
          </div>

          <DownloadSection compatibility={compatibility} toolName={name} />

        </motion.div>
      </div>
    </div>
  );
};

export default ToolDetailPage;
