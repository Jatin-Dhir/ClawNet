import React, { useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { Link } from 'react-router-dom';
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
  Zap,
  Search,
  FileSearch,
  Mail,
  TrendingUp,
  MessageSquare,
  Calendar,
  Clock,
  Users
} from 'lucide-react';

const CyberOperationsPage = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const [hoveredCard, setHoveredCard] = useState(null);

  const services = [
    {
      id: 1,
      serviceId: 'vapt',
      title: 'Vulnerability Assessment & Penetration Testing',
      shortTitle: 'VAPT',
      description: 'We simulate real-world attacks to uncover vulnerabilities before threat actors do.',
      icon: Shield,
      gradient: 'from-blue-500 via-cyan-500 to-blue-600',
      glow: 'rgba(59, 130, 246, 0.15)',
      features: [
        'Automated vulnerability scanning',
        'Manual penetration testing',
        'Social engineering assessments',
        'Comprehensive reporting & remediation guidance'
      ],
      category: 'Assessment',
      badge: 'Popular'
    },
    {
      id: 2,
      serviceId: 'web-application-security',
      title: 'Web Application Security',
      shortTitle: 'Web Security',
      description: 'Protecting your front-end and backend with in-depth source analysis and config hardening.',
      icon: Code,
      gradient: 'from-purple-500 via-pink-500 to-purple-600',
      glow: 'rgba(168, 85, 247, 0.15)',
      features: [
        'Source code security review',
        'API security assessment',
        'Configuration hardening',
        'OWASP Top 10 compliance'
      ],
      category: 'Development'
    },
    {
      id: 3,
      serviceId: 'network-security',
      title: 'Network Security Assessment',
      shortTitle: 'Network Security',
      description: 'Full-scale internal and external scans to detect misconfigurations, weak firewalls, and rogue devices.',
      icon: Network,
      gradient: 'from-cyan-500 via-blue-500 to-cyan-600',
      glow: 'rgba(6, 182, 212, 0.15)',
      features: [
        'Network topology mapping',
        'Firewall rule analysis',
        'Wireless security audit',
        'Intrusion detection system review'
      ],
      category: 'Infrastructure'
    },
    {
      id: 4,
      serviceId: 'cloud-security',
      title: 'Cloud Security Review',
      shortTitle: 'Cloud Security',
      description: 'Audit AWS, Azure, and GCP setups to ensure compliance and zero data exposure.',
      icon: Cloud,
      gradient: 'from-blue-600 via-indigo-500 to-purple-600',
      glow: 'rgba(99, 102, 241, 0.15)',
      features: [
        'Multi-cloud security assessment',
        'IAM policy review',
        'Data encryption verification',
        'Compliance auditing (SOC 2, ISO 27001)'
      ],
      category: 'Cloud'
    },
    {
      id: 5,
      serviceId: 'incident-response',
      title: 'Incident Response & Forensics',
      shortTitle: 'Incident Response',
      description: 'Contain, analyze, and recover from breaches with ClawNet\'s rapid-response team.',
      icon: AlertTriangle,
      gradient: 'from-red-500 via-orange-500 to-red-600',
      glow: 'rgba(239, 68, 68, 0.15)',
      features: [
        '24/7 incident response',
        'Digital forensics analysis',
        'Threat containment & eradication',
        'Post-incident reporting'
      ],
      category: 'Response',
      badge: 'Emergency'
    },
    {
      id: 6,
      serviceId: 'custom-solutions',
      title: 'Custom Security Solutions',
      shortTitle: 'Custom Solutions',
      description: 'Tailor-made security frameworks, monitoring systems, or AI-powered SOC dashboards.',
      icon: Settings,
      gradient: 'from-purple-500 via-pink-500 to-blue-500',
      glow: 'rgba(168, 85, 247, 0.15)',
      features: [
        'Security framework design',
        'SIEM integration & tuning',
        'AI-powered threat detection',
        'Custom security tooling'
      ],
      category: 'Solutions'
    },
  ];

  const stats = [
    { label: 'Security Assessments', value: '500+', icon: FileSearch, color: 'text-cyber-blue' },
    { label: 'Vulnerabilities Found', value: '10K+', icon: Search, color: 'text-cyber-cyan' },
    { label: 'Incidents Responded', value: '200+', icon: AlertTriangle, color: 'text-orange-500' },
    { label: 'Client Satisfaction', value: '98%', icon: CheckCircle2, color: 'text-green-400' },
  ];

  return (
    <div ref={ref} className="min-h-screen bg-cyber-black text-white relative overflow-hidden">
      {/* Animated Background Grid */}
      <div className="fixed inset-0 opacity-20">
        <div 
          className="absolute inset-0"
          style={{
            backgroundImage: `
              linear-gradient(rgba(0, 224, 255, 0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(0, 224, 255, 0.1) 1px, transparent 1px)
            `,
            backgroundSize: '50px 50px',
            animation: 'grid-move 20s linear infinite'
          }}
        />
      </div>

      {/* Content */}
      <div className="relative z-10">
        {/* Hero Section */}
        <section className="relative min-h-[60vh] flex items-center justify-center border-b border-white/10">
          <div className="absolute inset-0 bg-gradient-to-b from-cyber-blue/5 via-transparent to-transparent" />

          <div className="max-w-7xl mx-auto px-6 md:px-12 lg:px-20 py-32 text-center relative z-10">
            {/* Back Navigation */}
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6 }}
              className="absolute top-8 left-6 md:left-12"
            >
              <Link
                to="/"
                className="inline-flex items-center gap-2 rounded-full px-3 py-2 bg-cyber-black/70 border border-white/10 text-gray-400 hover:text-white hover:border-cyber-blue/60 transition-all duration-300 touch-manipulation"
                aria-label="Back to home"
              >
                <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                <span className="font-exo text-xs uppercase tracking-wider">Back</span>
              </Link>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
              className="space-y-8"
            >
              <h1 className="font-orbitron text-5xl md:text-7xl lg:text-8xl font-black leading-tight">
                <span className="block bg-gradient-to-r from-cyber-blue via-cyber-cyan to-white bg-clip-text text-transparent">
                  CYBER OPERATIONS
                </span>
                <span className="block text-3xl md:text-4xl lg:text-5xl mt-4 text-gray-400 font-normal">
                  Professional Security Services
                </span>
              </h1>

              <p className="font-exo text-lg md:text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
                Comprehensive cybersecurity solutions designed to protect your digital infrastructure. 
                Our certified team delivers enterprise-grade security assessments and custom solutions.
              </p>

              {/* Stats Row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-16 max-w-4xl mx-auto">
                {stats.map((stat, index) => (
                  <motion.div
                    key={stat.label}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.3 + index * 0.1, duration: 0.5 }}
                    whileHover={{ scale: 1.05, y: -5 }}
                    className="relative group"
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent rounded-lg blur-lg group-hover:blur-xl transition-all duration-300" />
                    <div className="relative p-6 bg-white/5 backdrop-blur-sm border border-white/10 rounded-lg hover:border-cyber-blue/50 transition-all duration-300">
                      <stat.icon className={`w-8 h-8 ${stat.color} mx-auto mb-3`} />
                      <div className="font-orbitron text-3xl md:text-4xl font-black text-white mb-1">
                        {stat.value}
                      </div>
                      <div className="font-exo text-xs text-gray-400 uppercase tracking-wider">
                        {stat.label}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </div>
        </section>

        {/* Services Grid */}
        <section className="relative py-20 md:py-32">
          <div className="max-w-7xl mx-auto px-6 md:px-12 lg:px-20">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.6 }}
              className="text-center mb-16"
            >
              <h2 className="font-orbitron text-4xl md:text-5xl font-black mb-4">
                <span className="text-white/30">OUR </span>
                <span className="bg-gradient-to-r from-cyber-blue to-cyber-cyan bg-clip-text text-transparent">
                  SERVICES
                </span>
              </h2>
              <p className="font-exo text-gray-400 max-w-2xl mx-auto">
                Enterprise-grade security solutions covering every aspect of your digital defense
              </p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
              {services.map((service, index) => {
                const Icon = service.icon;
                const isHovered = hoveredCard === index;
                
                return (
                  <motion.div
                    key={service.id}
                    initial={{ opacity: 0, y: 50 }}
                    animate={isInView ? { opacity: 1, y: 0 } : {}}
                    transition={{ 
                      duration: 0.6, 
                      delay: index * 0.1,
                      ease: [0.4, 0, 0.2, 1]
                    }}
                    onMouseEnter={() => setHoveredCard(index)}
                    onMouseLeave={() => setHoveredCard(null)}
                    className="group relative"
                  >
                    {/* Glow Effect */}
                    <div
                      className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-50 transition-opacity duration-500 blur-2xl"
                      style={{ backgroundColor: service.glow }}
                    />

                    {/* Card */}
                    <div className="relative h-full p-6 sm:p-7 lg:p-8 bg-gradient-to-br from-white/5 via-white/5 to-white/0 backdrop-blur-sm border border-white/10 rounded-2xl overflow-hidden transition-all duration-500 group-hover:border-white/20"
                      style={{
                        boxShadow: isHovered ? `0 10px 30px ${service.glow}` : 'none'
                      }}
                    >
                      {/* Background Gradient */}
                      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${service.gradient} opacity-0 group-hover:opacity-5 transition-opacity duration-500`} />

                      {/* Badge */}
                      {service.badge && (
                        <div className="absolute top-4 right-4">
                          <span className="px-3 py-1 text-xs font-exo font-bold uppercase tracking-wider bg-gradient-to-r from-cyber-blue to-cyber-cyan text-white rounded-full shadow-lg shadow-cyber-blue/20">
                            {service.badge}
                          </span>
                        </div>
                      )}

                      {/* Icon */}
                      <motion.div
                        animate={isHovered ? { 
                          scale: 1.05
                        } : {}}
                        transition={{ duration: 0.3 }}
                        className={`relative mb-6 w-14 h-14 sm:w-16 sm:h-16 rounded-xl bg-gradient-to-br ${service.gradient} flex items-center justify-center`}
                      >
                        <Icon className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
                      </motion.div>

                      {/* Category */}
                      <div className="mb-3">
                        <span className="text-xs font-exo font-semibold text-cyber-blue uppercase tracking-wider">
                          {service.category}
                        </span>
                      </div>

                      {/* Title */}
                      <h3 className="font-orbitron text-xl md:text-2xl font-bold text-white mb-4 leading-tight">
                        {service.title}
                      </h3>

                      {/* Description */}
                      <p className="font-exo text-sm text-gray-400 mb-6 leading-relaxed">
                        {service.description}
                      </p>

                      {/* Features List */}
                      <div className="space-y-2.5 mb-6">
                        {service.features.slice(0, 3).map((feature, idx) => (
                          <motion.div
                            key={idx}
                            initial={{ opacity: 0, x: -10 }}
                            animate={isHovered ? { opacity: 1, x: 0 } : { opacity: 0.7, x: 0 }}
                            transition={{ delay: idx * 0.05 }}
                            className="flex items-center gap-2"
                          >
                            <CheckCircle2 className="w-4 h-4 text-cyber-blue flex-shrink-0" />
                            <span className="font-exo text-xs text-gray-400">{feature}</span>
                          </motion.div>
                        ))}
                      </div>

                      {/* CTA */}
                      <div className="relative z-10 mt-auto">
                        <Link
                          to={`/services/${service.serviceId}`}
                          className="inline-flex w-full items-center justify-center gap-2 px-4 py-3 rounded-lg border border-cyber-blue/50 text-cyber-blue hover:text-white hover:border-cyber-cyan hover:bg-cyber-blue/10 font-orbitron text-xs sm:text-sm uppercase tracking-[0.2em] transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-cyber-cyan"
                        >
                          Learn More
                          <ArrowRight className="w-4 h-4" />
                        </Link>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="relative py-20 md:py-32 border-t border-white/10 overflow-hidden">
          {/* Decorative Background Elements */}
          <div className="absolute inset-0">
            <div className="absolute top-0 left-1/4 w-96 h-96 bg-cyber-blue/5 rounded-full blur-3xl" />
            <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-cyber-purple/5 rounded-full blur-3xl" />
          </div>

          <div className="max-w-6xl mx-auto px-6 md:px-12 lg:px-20 relative z-10">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.8 }}
              className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center"
            >
              {/* Left Side - Content */}
              <div className="space-y-8">
                <div className="inline-flex items-center gap-3 px-4 py-2 bg-cyber-blue/10 border border-cyber-blue/30 rounded-full w-fit">
                  <MessageSquare className="w-5 h-5 text-cyber-blue" />
                  <span className="font-exo text-xs text-cyber-blue uppercase tracking-wider font-semibold">
                    Get Started Today
                  </span>
                </div>

                <h2 className="font-orbitron text-4xl md:text-5xl lg:text-6xl font-black leading-tight">
                  <span className="text-white/30">READY TO </span>
                  <span className="block bg-gradient-to-r from-cyber-blue via-cyber-cyan to-white bg-clip-text text-transparent">
                    SECURE YOUR FUTURE?
                  </span>
                </h2>

                <p className="font-exo text-lg text-gray-400 leading-relaxed">
                  Schedule a free consultation with our cybersecurity experts. We'll assess your needs and provide a 
                  comprehensive security solution tailored to your organization's unique requirements.
                </p>

                {/* Quick Stats */}
                <div className="grid grid-cols-3 gap-6 pt-4">
                  <div className="text-center">
                    <div className="flex items-center justify-center mb-2">
                      <Clock className="w-5 h-5 text-cyber-blue" />
                    </div>
                    <div className="font-orbitron text-2xl font-bold text-white">24/7</div>
                    <div className="font-exo text-xs text-gray-500 uppercase tracking-wider">Support</div>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center mb-2">
                      <Users className="w-5 h-5 text-cyber-cyan" />
                    </div>
                    <div className="font-orbitron text-2xl font-bold text-white">500+</div>
                    <div className="font-exo text-xs text-gray-500 uppercase tracking-wider">Clients</div>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center justify-center mb-2">
                      <TrendingUp className="w-5 h-5 text-purple-400" />
                    </div>
                    <div className="font-orbitron text-2xl font-bold text-white">98%</div>
                    <div className="font-exo text-xs text-gray-500 uppercase tracking-wider">Satisfaction</div>
                  </div>
                </div>
              </div>

              {/* Right Side - CTA Card */}
              <motion.div
                initial={{ opacity: 0, x: 30 }}
                animate={isInView ? { opacity: 1, x: 0 } : {}}
                transition={{ duration: 0.8, delay: 0.2 }}
                className="relative"
              >
                <div className="relative p-8 md:p-10 bg-gradient-to-br from-white/5 via-white/5 to-white/0 backdrop-blur-sm border border-white/10 rounded-2xl overflow-hidden">
                  {/* Gradient Overlay */}
                  <div className="absolute inset-0 bg-gradient-to-br from-cyber-blue/10 via-purple-500/10 to-cyber-blue/10 opacity-0 hover:opacity-100 transition-opacity duration-500" />
                  
                  {/* Content */}
                  <div className="relative z-10 space-y-6">
                    <div className="flex items-center gap-3 mb-6">
                      <div className="p-3 bg-gradient-to-br from-cyber-blue to-cyber-cyan rounded-lg">
                        <Calendar className="w-6 h-6 text-white" />
                      </div>
                      <div>
                        <h3 className="font-orbitron text-xl font-bold text-white">Schedule Consultation</h3>
                        <p className="font-exo text-sm text-gray-400">Free 30-minute assessment</p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <motion.a
                        href="mailto:Team@projectclawnet.online"
                        whileHover={{ scale: 1.02, x: 5 }}
                        whileTap={{ scale: 0.98 }}
                        className="flex items-center justify-between p-4 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-white font-orbitron font-bold text-sm uppercase tracking-wider rounded-lg hover:shadow-lg hover:shadow-cyber-blue/50 transition-all group"
                      >
                        <span className="flex items-center gap-3">
                          <Mail className="w-5 h-5" />
                          Email Us
                        </span>
                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                      </motion.a>

                      <motion.a
                        href="mailto:Team@projectclawnet.online?subject=Consultation Request"
                        whileHover={{ scale: 1.02, x: 5 }}
                        whileTap={{ scale: 0.98 }}
                        className="flex items-center justify-between p-4 border-2 border-cyber-blue/50 text-cyber-blue font-orbitron font-bold text-sm uppercase tracking-wider rounded-lg hover:bg-cyber-blue/10 transition-all group"
                      >
                        <span className="flex items-center gap-3">
                          <MessageSquare className="w-5 h-5" />
                          Request Callback
                        </span>
                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                      </motion.a>

                      <motion.a
                        href="/team"
                        whileHover={{ scale: 1.02, x: 5 }}
                        whileTap={{ scale: 0.98 }}
                        className="flex items-center justify-between p-4 border border-white/10 text-gray-400 hover:text-white hover:border-white/30 font-exo font-semibold text-sm uppercase tracking-wider rounded-lg transition-all group"
                      >
                        <span className="flex items-center gap-3">
                          <Users className="w-5 h-5" />
                          Meet Our Team
                        </span>
                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                      </motion.a>
                    </div>

                    <div className="pt-4 border-t border-white/10">
                      <p className="font-exo text-xs text-gray-500 text-center">
                        We typically respond within 24 hours
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          </div>
        </section>
      </div>

      <style>{`
        @keyframes grid-move {
          0% { transform: translate(0, 0); }
          100% { transform: translate(50px, 50px); }
        }
      `}</style>
    </div>
  );
};

export default CyberOperationsPage;
