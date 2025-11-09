import React, { useRef } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { motion, useInView } from 'framer-motion';
import { 
  Shield, 
  Code, 
  Network, 
  Cloud,
  AlertTriangle,
  Settings,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Mail,
  Clock,
  BarChart3,
  Target,
  Zap,
  Lock,
  Eye,
  FileCheck
} from 'lucide-react';

const servicesData = {
  'vapt': {
    id: 1,
    title: 'Vulnerability Assessment & Penetration Testing',
    shortTitle: 'VAPT',
    description: 'We simulate real-world attacks to uncover vulnerabilities before threat actors do.',
    icon: Shield,
    gradient: 'from-blue-500 via-cyan-500 to-blue-600',
    category: 'Assessment',
    badge: 'Popular',
    overview: 'Our comprehensive VAPT services combine automated scanning with manual penetration testing techniques to identify security weaknesses across your infrastructure, applications, and network systems.',
    benefits: [
      'Identify vulnerabilities before attackers',
      'Meet compliance requirements',
      'Reduce data breach risks',
      'Get detailed remediation guidance'
    ],
    methodology: [
      { phase: 'Reconnaissance', desc: 'Gathering information about target systems and networks' },
      { phase: 'Vulnerability Scanning', desc: 'Automated scanning using industry-leading tools' },
      { phase: 'Manual Testing', desc: 'Expert penetration testers assess real-world impact' },
      { phase: 'Reporting & Remediation', desc: 'Prioritized findings and actionable steps' }
    ],
    deliverables: [
      'Executive summary',
      'Technical assessment report',
      'Penetration testing findings',
      'Detailed remediation recommendations'
    ],
    timeline: '2-4 weeks',
    pricing: 'Starting at $5,000'
  },
  'web-application-security': {
    id: 2,
    title: 'Web Application Security',
    shortTitle: 'Web Security',
    description: 'Protecting your front-end and backend with in-depth source analysis and config hardening.',
    icon: Code,
    gradient: 'from-purple-500 via-pink-500 to-purple-600',
    category: 'Development',
    overview: 'Comprehensive security assessment of your web applications, APIs, and infrastructure to identify and remediate vulnerabilities before exploitation.',
    benefits: [
      'Protect sensitive user data',
      'Prevent OWASP Top 10 vulnerabilities',
      'Secure API endpoints',
      'Maintain customer trust'
    ],
    methodology: [
      { phase: 'Architecture Review', desc: 'Analysis of security controls and architecture' },
      { phase: 'Code Analysis', desc: 'Static and dynamic analysis to identify flaws' },
      { phase: 'API Testing', desc: 'Comprehensive testing of REST and GraphQL APIs' },
      { phase: 'Remediation Guidance', desc: 'Detailed recommendations with code examples' }
    ],
    deliverables: [
      'Security assessment report',
      'Source code review findings',
      'API security analysis',
      'Configuration hardening guide'
    ],
    timeline: '3-5 weeks',
    pricing: 'Starting at $4,500'
  },
  'network-security': {
    id: 3,
    title: 'Network Security Assessment',
    shortTitle: 'Network Security',
    description: 'Full-scale internal and external scans to detect misconfigurations, weak firewalls, and rogue devices.',
    icon: Network,
    gradient: 'from-cyan-500 via-blue-500 to-cyan-600',
    category: 'Infrastructure',
    overview: 'Evaluation of your network infrastructure to identify vulnerabilities, misconfigurations, and potential attack vectors.',
    benefits: [
      'Identify network weak points',
      'Detect unauthorized devices',
      'Validate firewall rules',
      'Ensure compliance'
    ],
    methodology: [
      { phase: 'Network Discovery', desc: 'Mapping topology and connected devices' },
      { phase: 'Vulnerability Assessment', desc: 'Scanning for known vulnerabilities' },
      { phase: 'Configuration Review', desc: 'Analyzing firewall rules and policies' },
      { phase: 'Reporting', desc: 'Prioritized remediation steps' }
    ],
    deliverables: [
      'Network topology map',
      'Vulnerability assessment report',
      'Firewall rule analysis',
      'Security configuration guide'
    ],
    timeline: '2-3 weeks',
    pricing: 'Starting at $6,000'
  },
  'cloud-security': {
    id: 4,
    title: 'Cloud Security Review',
    shortTitle: 'Cloud Security',
    description: 'Audit AWS, Azure, and GCP setups to ensure compliance and zero data exposure.',
    icon: Cloud,
    gradient: 'from-blue-600 via-indigo-500 to-purple-600',
    category: 'Cloud',
    overview: 'Security assessment of your cloud infrastructure across AWS, Azure, and GCP to ensure secure configurations and compliance.',
    benefits: [
      'Identify misconfigured resources',
      'Ensure proper IAM policies',
      'Validate encryption',
      'Achieve compliance certifications'
    ],
    methodology: [
      { phase: 'Architecture Review', desc: 'Analysis of cloud infrastructure' },
      { phase: 'IAM Audit', desc: 'Review of access management policies' },
      { phase: 'Configuration Review', desc: 'Evaluation of security groups and encryption' },
      { phase: 'Compliance Assessment', desc: 'Validation against frameworks' }
    ],
    deliverables: [
      'Cloud security report',
      'IAM recommendations',
      'Configuration guide',
      'Compliance gap analysis'
    ],
    timeline: '3-4 weeks',
    pricing: 'Starting at $7,500'
  },
  'incident-response': {
    id: 5,
    title: 'Incident Response & Forensics',
    shortTitle: 'Incident Response',
    description: 'Contain, analyze, and recover from breaches with ClawNet\'s rapid-response team.',
    icon: AlertTriangle,
    gradient: 'from-red-500 via-orange-500 to-red-600',
    category: 'Response',
    badge: 'Emergency',
    overview: 'Rapid incident response and digital forensics services to contain, investigate, and recover from security breaches.',
    benefits: [
      'Rapid incident containment',
      'Minimize business impact',
      'Comprehensive forensics',
      'Compliance with breach notification'
    ],
    methodology: [
      { phase: 'Immediate Response', desc: '24/7 team activation' },
      { phase: 'Threat Containment', desc: 'Isolating affected systems' },
      { phase: 'Forensic Analysis', desc: 'Deep-dive investigation' },
      { phase: 'Recovery & Review', desc: 'System restoration and lessons learned' }
    ],
    deliverables: [
      'Incident response report',
      'Forensic findings',
      'Impact assessment',
      'Remediation recommendations'
    ],
    timeline: 'Immediate - 2 weeks',
    pricing: 'Starting at $10,000'
  },
  'custom-solutions': {
    id: 6,
    title: 'Custom Security Solutions',
    shortTitle: 'Custom Solutions',
    description: 'Tailor-made security frameworks, monitoring systems, or AI-powered SOC dashboards.',
    icon: Settings,
    gradient: 'from-purple-500 via-pink-500 to-blue-500',
    category: 'Solutions',
    overview: 'Bespoke security solutions tailored to your organization\'s unique requirements.',
    benefits: [
      'Custom-tailored solutions',
      'Integration with existing systems',
      'Scalable architecture',
      'Optimized processes'
    ],
    methodology: [
      { phase: 'Requirements Analysis', desc: 'Understanding your needs' },
      { phase: 'Solution Design', desc: 'Architecting custom frameworks' },
      { phase: 'Development', desc: 'Building and integration' },
      { phase: 'Deployment & Training', desc: 'Launch and team training' }
    ],
    deliverables: [
      'Security framework',
      'SIEM integration',
      'Threat detection system',
      'Training materials'
    ],
    timeline: '4-12 weeks',
    pricing: 'Custom Quote'
  }
};

const ServiceDetailPage = () => {
  const { serviceId } = useParams();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  
  const service = servicesData[serviceId];

  if (!service) {
    return <Navigate to="/cyber-operations" replace />;
  }

  const Icon = service.icon;

  return (
    <div ref={ref} className="min-h-screen bg-cyber-black text-white relative overflow-hidden">
      <div className="relative z-10 pt-32 pb-20">
        <div className="max-w-6xl mx-auto px-6 md:px-12 lg:px-20">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="mb-20"
          >
            <Link
              to="/cyber-operations"
              className="inline-flex items-center gap-2 mb-6 sm:mb-8 rounded-full px-3 py-2 bg-cyber-black/70 border border-white/10 text-gray-400 hover:text-white hover:border-cyber-blue/60 transition-all duration-300 touch-manipulation"
              aria-label="Back to services"
            >
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
              <span className="font-exo text-xs sm:text-sm uppercase tracking-wider">Back</span>
            </Link>

            <div className="flex flex-col md:flex-row md:items-start gap-5 md:gap-6 mb-8">
              <div className={`p-4 sm:p-5 bg-gradient-to-br ${service.gradient} rounded-xl flex-shrink-0 w-fit`}>
                <Icon className="w-10 h-10 sm:w-12 sm:h-12 text-white" />
              </div>
              <div className="flex-1">
                {service.badge && (
                  <span className="inline-block px-3 py-1 text-xs font-exo font-bold uppercase tracking-wider bg-gradient-to-r from-cyber-blue to-cyber-cyan text-white rounded-full mb-4">
                    {service.badge}
                  </span>
                )}
                <div className="text-xs font-exo text-cyber-blue uppercase tracking-[0.3em] mb-3">
                  {service.category}
                </div>
                <h1 className="font-orbitron text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black leading-tight mb-4">
                  {service.title}
                </h1>
                <p className="font-exo text-base sm:text-lg md:text-xl text-gray-400 leading-relaxed max-w-3xl">
                  {service.description}
                </p>
              </div>
            </div>

            {/* Quick Info */}
            <div className="flex flex-col sm:flex-row flex-wrap gap-4 sm:gap-6 items-start sm:items-center">
              <div className="flex items-center gap-3">
                <Clock className="w-5 h-5 text-cyber-blue" />
                <span className="font-exo text-gray-300 text-sm sm:text-base"><strong>Timeline:</strong> {service.timeline}</span>
              </div>
              <div className="flex items-center gap-3">
                <BarChart3 className="w-5 h-5 text-cyber-cyan" />
                <span className="font-exo text-gray-300 text-sm sm:text-base"><strong>Pricing:</strong> {service.pricing}</span>
              </div>
            </div>
          </motion.div>

          {/* Overview */}
          <motion.section
            initial={{ opacity: 0, y: 30 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="mb-20"
          >
            <h2 className="font-orbitron text-3xl font-bold mb-6 flex items-center gap-3">
              <Eye className="w-8 h-8 text-cyber-blue" />
              Overview
            </h2>
            <p className="font-exo text-lg text-gray-300 leading-relaxed max-w-4xl">
              {service.overview}
            </p>
          </motion.section>

          {/* Benefits & Deliverables Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 mb-20">
            {/* Benefits */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.6, delay: 0.3 }}
            >
              <h2 className="font-orbitron text-3xl font-bold mb-6 flex items-center gap-3">
                <Target className="w-8 h-8 text-cyber-blue" />
                Benefits
              </h2>
              <div className="space-y-4">
                {service.benefits.map((benefit, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, x: -20 }}
                    animate={isInView ? { opacity: 1, x: 0 } : {}}
                    transition={{ delay: 0.4 + index * 0.1 }}
                    className="flex items-start gap-3"
                  >
                    <CheckCircle2 className="w-6 h-6 text-cyber-blue flex-shrink-0 mt-0.5" />
                    <span className="font-exo text-lg text-gray-300">{benefit}</span>
                  </motion.div>
                ))}
              </div>
            </motion.div>

            {/* Deliverables */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.6, delay: 0.4 }}
            >
              <h2 className="font-orbitron text-3xl font-bold mb-6 flex items-center gap-3">
                <FileCheck className="w-8 h-8 text-cyber-blue" />
                Deliverables
              </h2>
              <div className="space-y-4">
                {service.deliverables.map((deliverable, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, x: -20 }}
                    animate={isInView ? { opacity: 1, x: 0 } : {}}
                    transition={{ delay: 0.5 + index * 0.1 }}
                    className="flex items-start gap-3"
                  >
                    <FileCheck className="w-6 h-6 text-cyber-cyan flex-shrink-0 mt-0.5" />
                    <span className="font-exo text-lg text-gray-300">{deliverable}</span>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </div>

          {/* Methodology */}
          <motion.section
            initial={{ opacity: 0, y: 30 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, delay: 0.5 }}
            className="mb-20"
          >
            <h2 className="font-orbitron text-3xl font-bold mb-8 flex items-center gap-3">
              <Zap className="w-8 h-8 text-cyber-blue" />
              Our Methodology
            </h2>
            <div className="space-y-4">
              {service.methodology.map((phase, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, x: -20 }}
                  animate={isInView ? { opacity: 1, x: 0 } : {}}
                  transition={{ delay: 0.6 + index * 0.1 }}
                  className="flex flex-col sm:flex-row gap-4 sm:gap-6 p-5 sm:p-6 bg-white/5 border border-white/10 rounded-xl hover:border-cyber-blue/50 transition-all"
                >
                  <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-cyber-blue to-cyber-cyan flex items-center justify-center font-orbitron font-bold text-white text-lg">
                    {index + 1}
                  </div>
                  <div className="flex-1">
                    <h3 className="font-orbitron text-lg sm:text-xl font-bold text-white mb-2">{phase.phase}</h3>
                    <p className="font-exo text-sm sm:text-base text-gray-400 leading-relaxed">{phase.desc}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.section>

          {/* CTA */}
          <motion.section
            initial={{ opacity: 0, y: 30 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, delay: 0.7 }}
            className="text-center"
          >
            <div className="p-8 sm:p-10 md:p-12 bg-gradient-to-br from-white/5 to-white/0 border border-white/10 rounded-2xl">
              <h2 className="font-orbitron text-2xl sm:text-3xl md:text-4xl font-bold mb-4">
                Ready to Get Started?
              </h2>
              <p className="font-exo text-base sm:text-lg text-gray-400 mb-8 max-w-2xl mx-auto">
                Contact our team to discuss your security needs
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <motion.a
                  href="mailto:Team@projectclawnet.online"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="inline-flex items-center justify-center gap-3 px-8 py-4 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-white font-orbitron font-bold text-sm uppercase tracking-wider rounded-xl hover:shadow-lg hover:shadow-cyber-blue/50 transition-all"
                >
                  <Mail className="w-5 h-5" />
                  Schedule Consultation
                </motion.a>
                <motion.a
                  href="/cyber-operations"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="inline-flex items-center justify-center gap-3 px-8 py-4 border-2 border-cyber-blue/50 text-cyber-blue font-orbitron font-bold text-sm uppercase tracking-wider rounded-xl hover:bg-cyber-blue/10 transition-all"
                >
                  <ArrowLeft className="w-5 h-5" />
                  View All Services
                </motion.a>
              </div>
            </div>
          </motion.section>
        </div>
      </div>
    </div>
  );
};

export default ServiceDetailPage;
