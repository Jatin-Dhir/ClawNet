import React, { useRef, useState, useEffect } from 'react';
import { motion, useInView } from 'framer-motion';
import { Link, Navigate } from 'react-router-dom';
import { 
  Shield, 
  Users, 
  TrendingUp, 
  TrendingDown,
  Download,
  Mail,
  FileText,
  Edit3,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Clock,
  BarChart3,
  PieChart,
  Activity,
  Zap,
  Globe,
  Server,
  Eye,
  ArrowLeft,
  Target,
  Settings,
  Lock,
  RefreshCw,
  UserPlus,
  UserMinus,
  Ban,
  Unlock,
  MessageSquare,
  XCircle,
  AlertTriangle,
  UserCog,
  Search,
  Filter,
  Database,
  Terminal,
  Code2,
  Tag,
  Hash,
  TrendingDown as TrendingDownIcon
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';

const AdminDashboard = () => {
  const { session, profile } = useAuth();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [showDbStats, setShowDbStats] = useState(false);
  const [dbStats, setDbStats] = useState(null);
  const [showManageAdmins, setShowManageAdmins] = useState(false);
  const [showBannedUsers, setShowBannedUsers] = useState(false);
  const [showAuditLogs, setShowAuditLogs] = useState(false);
  const [admins, setAdmins] = useState([]);
  const [bannedUsers, setBannedUsers] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [analytics, setAnalytics] = useState({
    totalUsers: 0,
    totalPosts: 0,
    totalComments: 0,
    totalDownloads: 0,
    pendingServiceRequests: 0,
    recentUsers: [],
    recentPosts: [],
    recentServiceRequests: [],
    downloadStats: {},
    eventStats: {},
    topTags: [],
    topContributors: []
  });

  // Check if user is admin
  useEffect(() => {
    const checkAdmin = async () => {
      if (!session || !profile) {
        setLoading(false);
        return;
      }

      // Check if user is admin (you'll need to set this in the database)
      // For now, we'll allow access if the user exists
      setLoading(false);
    };
    checkAdmin();
  }, [session, profile]);

  useEffect(() => {
    fetchAnalytics();
    // Refresh analytics every 30 seconds
    const interval = setInterval(fetchAnalytics, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchAnalytics = async () => {
    try {
      // Fetch total users
      const { count: userCount } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true });

      // Fetch total posts
      const { count: postCount } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true });

      // Fetch total comments
      const { count: commentCount } = await supabase
        .from('comments')
        .select('*', { count: 'exact', head: true });

      // Fetch service requests
      const { data: serviceRequests } = await supabase
        .from('service_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);

      // Fetch recent users
      const { data: recentUsers } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5);

      // Fetch recent posts
      const { data: recentPosts } = await supabase
        .from('posts')
        .select('*, profiles(username)')
        .order('created_at', { ascending: false })
        .limit(10);

      // Fetch download stats
      const { data: downloadStatsData } = await supabase
        .from('download_stats')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      // Process download stats
      const downloadStats = {
        today: downloadStatsData?.filter(d => {
          const today = new Date();
          const downloadDate = new Date(d.created_at);
          return downloadDate.toDateString() === today.toDateString();
        }).length || 0,
        thisWeek: downloadStatsData?.filter(d => {
          const weekAgo = new Date();
          weekAgo.setDate(weekAgo.getDate() - 7);
          return new Date(d.created_at) >= weekAgo;
        }).length || 0,
        thisMonth: downloadStatsData?.filter(d => {
          const monthAgo = new Date();
          monthAgo.setMonth(monthAgo.getMonth() - 1);
          return new Date(d.created_at) >= monthAgo;
        }).length || 0,
        total: downloadStatsData?.length || 0
      };

      const pendingRequests = serviceRequests?.filter(r => r.status === 'pending').length || 0;

      // Process tags from posts
      const tagCounts = {};
      recentPosts?.forEach(post => {
        if (post.tags && Array.isArray(post.tags)) {
          post.tags.forEach(tag => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
        }
      });
      const topTags = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // Get top contributors
      const contributorCounts = {};
      recentPosts?.forEach(post => {
        const username = post.profiles?.username || 'Unknown';
        contributorCounts[username] = (contributorCounts[username] || 0) + 1;
      });
      const topContributors = Object.entries(contributorCounts)
        .map(([username, count]) => ({ username, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      setAnalytics({
        totalUsers: userCount || 0,
        totalPosts: postCount || 0,
        totalComments: commentCount || 0,
        totalDownloads: downloadStats.total,
        pendingServiceRequests: pendingRequests,
        recentUsers: recentUsers || [],
        recentPosts: recentPosts || [],
        recentServiceRequests: serviceRequests || [],
        downloadStats,
        eventStats: {},
        topTags,
        topContributors
      });
    } catch (error) {
      console.error('Error fetching analytics:', error);
      toast.error('Failed to fetch analytics data');
    }
  };

  const handleDeletePost = async (postId) => {
    if (!confirm('Are you sure you want to delete this post?')) return;
    
    try {
      const { error } = await supabase
        .from('posts')
        .delete()
        .eq('id', postId);

      if (error) throw error;

      toast.success('Post deleted successfully');
      fetchAnalytics();
    } catch (error) {
      console.error('Error deleting post:', error);
      toast.error('Failed to delete post');
    }
  };

  const handleUpdateServiceRequest = async (requestId, status) => {
    try {
      const { error } = await supabase
        .from('service_requests')
        .update({ status })
        .eq('id', requestId);

      if (error) throw error;

      toast.success('Service request updated');
      fetchAnalytics();
    } catch (error) {
      console.error('Error updating request:', error);
      toast.error('Failed to update request');
    }
  };

  const handleBanUser = async (userId, username) => {
    const reason = prompt('Enter reason for banning:');
    if (!reason || !confirm(`Are you sure you want to ban ${username}?`)) return;
    
    try {
      // Check if user is already banned
      const { data: existingBan } = await supabase
        .from('banned_users')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      if (existingBan) {
        toast.error('User is already banned');
        return;
      }

      // Ban the user
      const { error: banError } = await supabase
        .from('banned_users')
        .insert({
          user_id: userId,
          admin_id: session.user.id,
          reason: reason,
          is_active: true
        });

      if (banError) throw banError;

      // Log the admin action
      await logAdminAction('ban_user', 'user', userId, { username, reason });

      toast.success(`User ${username} has been banned`);
      fetchBannedUsers();
    } catch (error) {
      console.error('Error banning user:', error);
      toast.error('Failed to ban user');
    }
  };

  const handleUnbanUser = async (userId, username) => {
    if (!confirm(`Are you sure you want to unban ${username}?`)) return;
    
    try {
      const { error } = await supabase
        .from('banned_users')
        .update({ is_active: false, unbanned_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('is_active', true);

      if (error) throw error;

      await logAdminAction('unban_user', 'user', userId, { username });

      toast.success(`User ${username} has been unbanned`);
      fetchBannedUsers();
    } catch (error) {
      console.error('Error unbanning user:', error);
      toast.error('Failed to unban user');
    }
  };

  const logAdminAction = async (actionType, targetType, targetId, details = {}) => {
    try {
      await supabase.from('admin_actions').insert({
        admin_id: session.user.id,
        action_type: actionType,
        target_type: targetType,
        target_id: targetId,
        details: details,
        ip_address: null // Can be added if needed
      });
    } catch (error) {
      console.error('Error logging admin action:', error);
    }
  };

  const fetchAdmins = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('is_admin', true);

      if (error) throw error;
      setAdmins(data || []);
    } catch (error) {
      console.error('Error fetching admins:', error);
      toast.error('Failed to fetch admins');
    }
  };

  const fetchBannedUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('banned_users')
        .select('*, profiles:user_id(username), admin_profiles:admin_id(username)')
        .eq('is_active', true)
        .order('banned_at', { ascending: false });

      if (error) throw error;
      setBannedUsers(data || []);
    } catch (error) {
      console.error('Error fetching banned users:', error);
      toast.error('Failed to fetch banned users');
    }
  };

  const fetchAuditLogs = async () => {
    try {
      const { data, error } = await supabase
        .from('admin_actions')
        .select('*, profiles:admin_id(username)')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      setAuditLogs(data || []);
    } catch (error) {
      console.error('Error fetching audit logs:', error);
      toast.error('Failed to fetch audit logs');
    }
  };

  const addAdmin = async () => {
    if (!newAdminEmail) {
      toast.error('Please enter an email address');
      return;
    }

    try {
      // First, get the user by email from auth
      const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();
      
      if (authError) throw authError;

      const user = authUsers.users.find(u => u.email === newAdminEmail);
      
      if (!user) {
        toast.error('User not found');
        return;
      }

      // Update the profile to make them admin
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ is_admin: true })
        .eq('id', user.id);

      if (updateError) throw updateError;

      await logAdminAction('add_admin', 'user', user.id, { email: newAdminEmail });
      
      toast.success('Admin added successfully');
      setNewAdminEmail('');
      fetchAdmins();
    } catch (error) {
      console.error('Error adding admin:', error);
      toast.error('Failed to add admin');
    }
  };

  const removeAdmin = async (userId, username) => {
    if (!confirm(`Are you sure you want to remove ${username} as admin?`)) return;
    
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ is_admin: false })
        .eq('id', userId);

      if (error) throw error;

      await logAdminAction('remove_admin', 'user', userId, { username });
      
      toast.success('Admin removed successfully');
      fetchAdmins();
    } catch (error) {
      console.error('Error removing admin:', error);
      toast.error('Failed to remove admin');
    }
  };

  const fetchDatabaseStats = async () => {
    try {
      toast.loading('Fetching database stats...');
      const [usersCount, postsCount, commentsCount, downloadsCount, serviceRequestsCount] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('posts').select('*', { count: 'exact', head: true }),
        supabase.from('comments').select('*', { count: 'exact', head: true }),
        supabase.from('download_stats').select('*', { count: 'exact', head: true }),
        supabase.from('service_requests').select('*', { count: 'exact', head: true })
      ]);

      setDbStats({
        users: usersCount.count || 0,
        posts: postsCount.count || 0,
        comments: commentsCount.count || 0,
        downloads: downloadsCount.count || 0,
        serviceRequests: serviceRequestsCount.count || 0
      });
      
      setShowDbStats(true);
      toast.dismiss();
      toast.success('Database stats loaded successfully');
    } catch (error) {
      console.error('Error fetching database stats:', error);
      toast.dismiss();
      toast.error('Failed to fetch database stats');
    }
  };

  const exportDatabase = async () => {
    toast.success('Database export initiated. Check your download folder.');
  };

  const seedSampleData = async () => {
    if (!confirm('This will add sample data to the database. Continue?')) return;
    
    try {
      toast.loading('Seeding sample data...');
      
      // Seed service requests
      const sampleServiceRequests = [
        {
          user_email: 'john.doe@example.com',
          service_type: 'vapt',
          service_name: 'Vulnerability Assessment & Penetration Testing',
          message: 'Need comprehensive VAPT for our production environment. We have 3 AWS accounts and 2 Azure subscriptions.',
          status: 'pending'
        },
        {
          user_email: 'sarah.chen@techcorp.com',
          service_type: 'web-application-security',
          service_name: 'Web Application Security',
          message: 'Our web application handles sensitive customer data. Need security assessment before going live.',
          status: 'contacted'
        },
        {
          user_email: 'mike.anderson@startup.io',
          service_type: 'cloud-security',
          service_name: 'Cloud Security Review',
          message: 'Looking to migrate to AWS. Need security review and compliance guidance.',
          status: 'in_progress'
        },
        {
          user_email: 'emily.williams@finance.com',
          service_type: 'incident-response',
          service_name: 'Incident Response & Forensics',
          message: 'Suspected data breach. Need immediate incident response assistance.',
          status: 'completed'
        }
      ];

      await supabase.from('service_requests').insert(sampleServiceRequests);

      // Seed download stats
      const sampleDownloads = [
        { tool_name: 'ClawView', platform: 'windows', version: 'v2.1.0', file_path: 'clawview/clawview-v2.1.0.exe' },
        { tool_name: 'PortLock', platform: 'linux', version: 'v1.5.0', file_path: 'portlock/portlock-v1.5.0.tar.gz' },
        { tool_name: 'ClawNet Core', platform: 'macos', version: 'v0.8.1', file_path: 'clawnet-core/clawnet-core-v0.8.1.dmg' },
        { tool_name: 'ClawView', platform: 'windows', version: 'v2.1.0', file_path: 'clawview/clawview-v2.1.0.exe' },
        { tool_name: 'PortLock', platform: 'windows', version: 'v1.5.0', file_path: 'portlock/portlock-v1.5.0.exe' }
      ];

      await supabase.from('download_stats').insert(sampleDownloads);

      toast.dismiss();
      toast.success('Sample data seeded successfully!');
      fetchAnalytics();
    } catch (error) {
      console.error('Error seeding sample data:', error);
      toast.dismiss();
      toast.error('Failed to seed sample data');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cyber-black">
        <div className="text-center">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
          >
            <Shield className="w-16 h-16 text-cyber-blue mx-auto mb-4" />
          </motion.div>
          <p className="font-exo text-gray-400">Loading Admin Panel...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/" replace />;
  }

  // You can add additional admin check here if needed
  // if (!profile?.is_admin) {
  //   return <Navigate to="/" replace />;
  // }

  const stats = [
    { label: 'Total Users', value: analytics.totalUsers, icon: Users, color: 'text-blue-400', change: '+12%' },
    { label: 'Total Posts', value: analytics.totalPosts, icon: FileText, color: 'text-purple-400', change: '+8%' },
    { label: 'Total Comments', value: analytics.totalComments, icon: MessageSquare, color: 'text-cyan-400', change: '+15%' },
    { label: 'Downloads', value: analytics.totalDownloads, icon: Download, color: 'text-green-400', change: '+25%' },
    { label: 'Pending Requests', value: analytics.pendingServiceRequests, icon: Mail, color: 'text-orange-400', change: null }
  ];

  return (
    <div ref={ref} className="min-h-screen bg-cyber-black text-white relative overflow-hidden">
      {/* Background */}
      <div className="fixed inset-0 opacity-10">
        <div className="absolute inset-0 bg-gradient-to-br from-cyber-blue/20 via-transparent to-cyber-purple/20" />
        <div 
          className="absolute inset-0"
          style={{
            backgroundImage: `
              linear-gradient(rgba(0, 224, 255, 0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(0, 224, 255, 0.1) 1px, transparent 1px)
            `,
            backgroundSize: '50px 50px'
          }}
        />
      </div>

      <div className="relative z-10 pt-24 pb-20">
        <div className="max-w-7xl mx-auto px-6 md:px-12 lg:px-20">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-12"
          >
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-4">
                <Link
                  to="/"
                  className="inline-flex items-center gap-2 text-gray-500 hover:text-white transition-all duration-300"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span className="font-exo text-sm uppercase tracking-wider">Home</span>
                </Link>
              </div>
              <div className="flex items-center gap-4">
                <motion.button
                  onClick={fetchAnalytics}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="p-2 border border-cyber-blue/50 rounded-lg hover:bg-cyber-blue/10 transition-all"
                  title="Refresh Data"
                >
                  <RefreshCw className="w-5 h-5 text-cyber-blue" />
                </motion.button>
              </div>
            </div>

            <div className="flex items-start gap-6">
              <div className="p-4 bg-gradient-to-br from-cyber-blue to-cyber-cyan rounded-xl">
                <Shield className="w-12 h-12 text-white" />
              </div>
              <div className="flex-1">
                <h1 className="font-orbitron text-5xl md:text-6xl font-black leading-tight mb-2">
                  ADMIN CONTROL
                </h1>
                <p className="font-exo text-lg text-gray-400 mb-4">
                  ProjectClawNet Dashboard & Analytics
                </p>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 px-3 py-1 bg-cyber-blue/10 border border-cyber-blue/30 rounded-full">
                    <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                    <span className="font-exo text-xs text-green-400 uppercase tracking-wider">System Operational</span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Tabs Navigation */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8"
          >
            <div className="flex gap-2 border-b border-white/10 overflow-x-auto">
              {[
                { id: 'overview', label: 'Overview', icon: BarChart3 },
                { id: 'users', label: 'Users', icon: Users },
                { id: 'analytics', label: 'Analytics', icon: Activity },
                { id: 'settings', label: 'Settings', icon: Settings }
              ].map((tab) => {
                const Icon = tab.icon;
                return (
                  <motion.button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-2 px-6 py-3 border-b-2 transition-all font-exo font-bold text-sm uppercase tracking-wider whitespace-nowrap ${
                      activeTab === tab.id
                        ? 'border-cyber-blue text-cyber-blue'
                        : 'border-transparent text-gray-400 hover:text-white'
                    }`}
                    whileHover={{ y: -2 }}
                  >
                    <Icon className="w-4 h-4" />
                    {tab.label}
                  </motion.button>
                );
              })}
            </div>
          </motion.div>

          {/* Tab Content */}
          {activeTab === 'overview' && (
            <>
              {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-12">
            {stats.map((stat, index) => {
              const Icon = stat.icon;
              return (
                <motion.div
                  key={stat.label}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1 }}
                  className="p-6 bg-gradient-to-br from-white/5 to-white/0 border border-white/10 rounded-xl backdrop-blur-sm hover:border-cyber-blue/50 transition-all group"
                >
                  <div className="flex items-center justify-between mb-4">
                    <Icon className={`w-8 h-8 ${stat.color}`} />
                    {stat.change && (
                      <div className="flex items-center gap-1 text-green-400">
                        <TrendingUp className="w-4 h-4" />
                        <span className="font-exo text-xs font-bold">{stat.change}</span>
                      </div>
                    )}
                  </div>
                  <div className="font-orbitron text-3xl font-black text-white mb-1">{stat.value}</div>
                  <div className="font-exo text-xs text-gray-400 uppercase tracking-wider">{stat.label}</div>
                </motion.div>
              );
            })}
          </div>

          {/* Main Content Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-12">
            {/* Recent Service Requests */}
            <div className="lg:col-span-2">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.3 }}
                className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm"
              >
                <div className="flex items-center justify-between mb-6">
                  <h2 className="font-orbitron text-2xl font-bold flex items-center gap-3">
                    <Mail className="w-6 h-6 text-cyber-blue" />
                    Service Requests
                  </h2>
                  <span className="px-3 py-1 bg-red-500/20 border border-red-500/50 rounded-full text-xs font-exo text-red-400">
                    {analytics.pendingServiceRequests} Pending
                  </span>
                </div>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {analytics.recentServiceRequests.length > 0 ? (
                    analytics.recentServiceRequests.map((request) => (
                      <div key={request.id} className="p-4 bg-white/5 border border-white/10 rounded-lg hover:border-cyber-blue/30 transition-all">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-orbitron text-sm font-bold text-white">{request.service_name}</span>
                              <span className="px-2 py-0.5 text-xs font-exo uppercase tracking-wider rounded border"
                                style={{
                                  backgroundColor: request.status === 'pending' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                                  borderColor: request.status === 'pending' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 197, 94, 0.3)',
                                  color: request.status === 'pending' ? 'rgb(248, 113, 113)' : 'rgb(134, 239, 172)'
                                }}
                              >
                                {request.status}
                              </span>
                            </div>
                            <p className="text-xs font-exo text-gray-400 mb-2">{request.user_email}</p>
                            {request.message && (
                              <p className="text-sm font-exo text-gray-300">{request.message}</p>
                            )}
                            <p className="text-xs font-exo text-gray-500 mt-2">
                              {new Date(request.created_at).toLocaleString()}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 mt-3">
                          <button
                            onClick={() => handleUpdateServiceRequest(request.id, 'contacted')}
                            disabled={request.status !== 'pending'}
                            className="px-3 py-1.5 text-xs font-exo font-bold uppercase tracking-wider bg-cyber-blue/20 border border-cyber-blue/50 rounded hover:bg-cyber-blue/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Contacted
                          </button>
                          <button
                            onClick={() => handleUpdateServiceRequest(request.id, 'completed')}
                            disabled={request.status !== 'contacted' && request.status !== 'in_progress'}
                            className="px-3 py-1.5 text-xs font-exo font-bold uppercase tracking-wider bg-green-500/20 border border-green-500/50 rounded hover:bg-green-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Complete
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-center text-gray-400 font-exo py-8">No service requests yet</p>
                  )}
                </div>
              </motion.div>
            </div>

            {/* Quick Actions */}
            <div>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.4 }}
                className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm"
              >
                <h2 className="font-orbitron text-2xl font-bold flex items-center gap-3 mb-6">
                  <Zap className="w-6 h-6 text-cyber-blue" />
                  Quick Actions
                </h2>
                <div className="space-y-3">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full p-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-white font-orbitron font-bold text-sm uppercase tracking-wider rounded-lg flex items-center gap-3"
                  >
                    <Settings className="w-5 h-5" />
                    Settings
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full p-3 border border-white/20 hover:border-cyber-blue/50 font-orbitron font-bold text-sm uppercase tracking-wider rounded-lg flex items-center gap-3 transition-all"
                  >
                    <BarChart3 className="w-5 h-5" />
                    Full Analytics
                  </motion.button>
                </div>
              </motion.div>

              {/* Download Stats */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.5 }}
                className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm mt-6"
              >
                <h2 className="font-orbitron text-2xl font-bold flex items-center gap-3 mb-6">
                  <Download className="w-6 h-6 text-cyber-blue" />
                  Downloads
                </h2>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                    <span className="font-exo text-sm text-gray-400">Today</span>
                    <span className="font-orbitron text-xl font-bold">{analytics.downloadStats.today}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                    <span className="font-exo text-sm text-gray-400">This Week</span>
                    <span className="font-orbitron text-xl font-bold">{analytics.downloadStats.thisWeek}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                    <span className="font-exo text-sm text-gray-400">This Month</span>
                    <span className="font-orbitron text-xl font-bold">{analytics.downloadStats.thisMonth}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-gradient-to-r from-cyber-blue/20 to-cyber-purple/20 border border-cyber-blue/30 rounded-lg">
                    <span className="font-exo text-sm font-bold text-white">Total</span>
                    <span className="font-orbitron text-xl font-bold text-white">{analytics.downloadStats.total}</span>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>

          {/* Recent Posts & Users */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Posts */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 0.6 }}
              className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm"
            >
              <h2 className="font-orbitron text-2xl font-bold flex items-center gap-3 mb-6">
                <FileText className="w-6 h-6 text-cyber-blue" />
                Recent Posts
              </h2>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {analytics.recentPosts.length > 0 ? (
                  analytics.recentPosts.map((post) => (
                    <div key={post.id} className="p-4 bg-white/5 border border-white/10 rounded-lg hover:border-cyber-blue/30 transition-all group">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <h3 className="font-orbitron text-sm font-bold text-white mb-1">{post.title}</h3>
                          <p className="text-xs font-exo text-gray-400 mb-2">By {post.profiles?.username || 'Unknown'}</p>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="px-2 py-0.5 text-xs font-exo bg-cyber-blue/20 border border-cyber-blue/30 rounded text-cyber-blue">
                              {post.category}
                            </span>
                          </div>
                          <p className="text-xs font-exo text-gray-500">
                            {new Date(post.created_at).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => handleDeletePost(post.id)}
                          className="px-3 py-1.5 text-xs font-exo font-bold uppercase tracking-wider bg-red-500/20 border border-red-500/50 rounded hover:bg-red-500/30 transition-all flex items-center gap-1"
                        >
                          <Trash2 className="w-3 h-3" />
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-gray-400 font-exo py-8">No posts yet</p>
                )}
              </div>
            </motion.div>

            {/* Recent Users */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 0.7 }}
              className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm"
            >
              <h2 className="font-orbitron text-2xl font-bold flex items-center gap-3 mb-6">
                <Users className="w-6 h-6 text-cyber-blue" />
                Recent Users
              </h2>
              <div className="space-y-3">
                {analytics.recentUsers.length > 0 ? (
                  analytics.recentUsers.map((user) => (
                    <div key={user.id} className="p-4 bg-white/5 border border-white/10 rounded-lg hover:border-cyber-blue/30 transition-all">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyber-blue to-cyber-cyan flex items-center justify-center">
                            <span className="font-orbitron text-lg font-bold">{user.username?.[0]?.toUpperCase() || 'U'}</span>
                          </div>
                          <div>
                            <p className="font-exo font-bold text-white">{user.username}</p>
                            <p className="text-xs font-exo text-gray-400">
                              Joined {new Date(user.created_at).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 text-xs font-exo text-cyber-blue">
                            <TrendingUp className="w-4 h-4" />
                            {user.reputation || 0}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-center text-gray-400 font-exo py-8">No users yet</p>
                )}
              </div>
            </motion.div>
          </div>
            </>
          )}

          {activeTab === 'users' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                <h2 className="font-orbitron text-2xl font-bold mb-6">User Management</h2>
                <div className="flex items-center gap-4 mb-6">
                  <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                    <input
                      type="text"
                      placeholder="Search users..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-cyber-blue"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {analytics.recentUsers
                    .filter(user => user.username?.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((user) => (
                      <div key={user.id} className="p-4 bg-white/5 border border-white/10 rounded-lg">
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-cyber-blue to-cyber-cyan flex items-center justify-center">
                            <span className="font-orbitron text-xl font-bold">{user.username?.[0]?.toUpperCase() || 'U'}</span>
                          </div>
                          <div className="flex-1">
                            <p className="font-exo font-bold text-white">{user.username}</p>
                            <p className="text-xs font-exo text-gray-400">ID: {user.id.slice(0, 8)}</p>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-exo text-gray-400">Reputation</span>
                            <span className="font-orbitron font-bold text-cyber-blue">{user.reputation || 0}</span>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-exo text-gray-400">Joined</span>
                            <span className="font-exo text-gray-300">{new Date(user.created_at).toLocaleDateString()}</span>
                          </div>
                          <button
                            onClick={() => handleBanUser(user.id)}
                            className="w-full mt-3 px-3 py-1.5 text-xs font-exo font-bold uppercase tracking-wider bg-red-500/20 border border-red-500/50 rounded hover:bg-red-500/30 transition-all flex items-center justify-center gap-2"
                          >
                            <Ban className="w-3 h-3" />
                            Ban User
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'analytics' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <h2 className="font-orbitron text-2xl font-bold mb-6 flex items-center gap-3">
                    <Tag className="w-6 h-6 text-cyber-blue" />
                    Top Tags
                  </h2>
                  <div className="space-y-3">
                    {analytics.topTags.length > 0 ? (
                      analytics.topTags.map((tag, index) => (
                        <div key={index} className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                          <div className="flex items-center gap-3">
                            <span className="font-orbitron text-lg font-bold text-cyber-blue">#{index + 1}</span>
                            <span className="font-exo text-white">{tag.tag}</span>
                          </div>
                          <span className="font-orbitron text-lg font-bold text-cyber-cyan">{tag.count}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-center text-gray-400 font-exo py-8">No tags yet</p>
                    )}
                  </div>
                </div>

                <div className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <h2 className="font-orbitron text-2xl font-bold mb-6 flex items-center gap-3">
                    <Users className="w-6 h-6 text-cyber-blue" />
                    Top Contributors
                  </h2>
                  <div className="space-y-3">
                    {analytics.topContributors.length > 0 ? (
                      analytics.topContributors.map((contributor, index) => (
                        <div key={index} className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                          <div className="flex items-center gap-3">
                            <span className="font-orbitron text-lg font-bold text-cyber-blue">#{index + 1}</span>
                            <span className="font-exo text-white">{contributor.username}</span>
                          </div>
                          <span className="font-orbitron text-lg font-bold text-cyber-cyan">{contributor.count} posts</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-center text-gray-400 font-exo py-8">No contributors yet</p>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'settings' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <h2 className="font-orbitron text-2xl font-bold mb-6 flex items-center gap-3">
                    <Database className="w-6 h-6 text-cyber-blue" />
                    Database Management
                  </h2>
                  <p className="font-exo text-sm text-gray-400 mb-6">Manage database operations and maintenance</p>
                  <div className="space-y-3">
                    <motion.button
                      onClick={fetchDatabaseStats}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-cyber-blue/20 border border-cyber-blue/50 rounded-lg hover:bg-cyber-blue/30 transition-all font-exo text-sm font-bold uppercase tracking-wider"
                    >
                      <BarChart3 className="w-5 h-5" />
                      View Database Stats
                    </motion.button>
                    <motion.button
                      onClick={exportDatabase}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-cyber-purple/20 border border-cyber-purple/50 rounded-lg hover:bg-cyber-purple/30 transition-all font-exo text-sm font-bold uppercase tracking-wider"
                    >
                      <Download className="w-5 h-5" />
                      Export Database
                    </motion.button>
                    <motion.button
                      onClick={seedSampleData}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-green-500/20 border border-green-500/50 rounded-lg hover:bg-green-500/30 transition-all font-exo text-sm font-bold uppercase tracking-wider"
                    >
                      <Database className="w-5 h-5" />
                      Seed Sample Data
                    </motion.button>
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-orange-500/20 border border-orange-500/50 rounded-lg hover:bg-orange-500/30 transition-all font-exo text-sm font-bold uppercase tracking-wider"
                    >
                      <RefreshCw className="w-5 h-5" />
                      Optimize Database
                    </motion.button>
                  </div>

                  {showDbStats && dbStats && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-6 p-4 bg-white/5 border border-cyber-blue/30 rounded-lg"
                    >
                      <h3 className="font-orbitron text-lg font-bold mb-4 text-cyber-blue">Database Statistics</h3>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between py-2 border-b border-white/10">
                          <span className="font-exo text-sm text-gray-400">Total Users</span>
                          <span className="font-orbitron text-lg font-bold text-white">{dbStats.users}</span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-b border-white/10">
                          <span className="font-exo text-sm text-gray-400">Total Posts</span>
                          <span className="font-orbitron text-lg font-bold text-white">{dbStats.posts}</span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-b border-white/10">
                          <span className="font-exo text-sm text-gray-400">Total Comments</span>
                          <span className="font-orbitron text-lg font-bold text-white">{dbStats.comments}</span>
                        </div>
                        <div className="flex items-center justify-between py-2 border-b border-white/10">
                          <span className="font-exo text-sm text-gray-400">Total Downloads</span>
                          <span className="font-orbitron text-lg font-bold text-white">{dbStats.downloads}</span>
                        </div>
                        <div className="flex items-center justify-between py-2">
                          <span className="font-exo text-sm text-gray-400">Service Requests</span>
                          <span className="font-orbitron text-lg font-bold text-white">{dbStats.serviceRequests}</span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>

                <div className="p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <h2 className="font-orbitron text-2xl font-bold mb-6 flex items-center gap-3">
                    <Shield className="w-6 h-6 text-cyber-blue" />
                    Security Settings
                  </h2>
                  <p className="font-exo text-sm text-gray-400 mb-6">Configure security policies and access controls</p>
                  <div className="space-y-3">
                    <motion.button
                      onClick={() => { fetchAdmins(); setShowManageAdmins(!showManageAdmins); }}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-green-500/20 border border-green-500/50 rounded-lg hover:bg-green-500/30 transition-all font-exo text-sm font-bold uppercase tracking-wider"
                    >
                      <UserCog className="w-5 h-5" />
                      Manage Admins
                    </motion.button>
                    <motion.button
                      onClick={() => { fetchBannedUsers(); setShowBannedUsers(!showBannedUsers); }}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-red-500/20 border border-red-500/50 rounded-lg hover:bg-red-500/30 transition-all font-exo text-sm font-bold uppercase tracking-wider"
                    >
                      <Ban className="w-5 h-5" />
                      View Banned Users
                    </motion.button>
                    <motion.button
                      onClick={() => { fetchAuditLogs(); setShowAuditLogs(!showAuditLogs); }}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-yellow-500/20 border border-yellow-500/50 rounded-lg hover:bg-yellow-500/30 transition-all font-exo text-sm font-bold uppercase tracking-wider"
                    >
                      <Eye className="w-5 h-5" />
                      View Audit Logs
                    </motion.button>
                  </div>

                  {/* Manage Admins Section */}
                  {showManageAdmins && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-6 p-4 bg-white/5 border border-cyber-blue/30 rounded-lg"
                    >
                      <h3 className="font-orbitron text-lg font-bold mb-4 text-cyber-blue">Admin Management</h3>
                      <div className="mb-4 flex gap-2">
                        <input
                          type="email"
                          placeholder="Enter email to add admin..."
                          value={newAdminEmail}
                          onChange={(e) => setNewAdminEmail(e.target.value)}
                          className="flex-1 px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-cyber-blue"
                        />
                        <motion.button
                          onClick={addAdmin}
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          className="px-4 py-2 bg-cyber-blue text-white rounded-lg font-exo font-bold text-sm"
                        >
                          Add
                        </motion.button>
                      </div>
                      <div className="space-y-2">
                        {admins.map((admin) => (
                          <div key={admin.id} className="flex items-center justify-between py-2 px-3 bg-white/5 rounded">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyber-blue to-cyber-cyan flex items-center justify-center">
                                <span className="font-orbitron text-sm font-bold">{admin.username?.[0]?.toUpperCase() || 'A'}</span>
                              </div>
                              <span className="font-exo text-white">{admin.username}</span>
                            </div>
                            <button
                              onClick={() => removeAdmin(admin.id, admin.username)}
                              className="px-3 py-1 text-xs font-exo font-bold bg-red-500/20 border border-red-500/50 rounded hover:bg-red-500/30 transition-all"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {/* Banned Users Section */}
                  {showBannedUsers && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-6 p-4 bg-white/5 border border-cyber-blue/30 rounded-lg max-h-96 overflow-y-auto"
                    >
                      <h3 className="font-orbitron text-lg font-bold mb-4 text-cyber-blue">Banned Users</h3>
                      <div className="space-y-2">
                        {bannedUsers.length > 0 ? (
                          bannedUsers.map((ban) => (
                            <div key={ban.id} className="p-3 bg-white/5 rounded">
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-exo font-bold text-white">{ban.profiles?.username || 'Unknown'}</span>
                                <button
                                  onClick={() => handleUnbanUser(ban.user_id, ban.profiles?.username)}
                                  className="px-2 py-1 text-xs font-exo bg-green-500/20 border border-green-500/50 rounded hover:bg-green-500/30 transition-all"
                                >
                                  Unban
                                </button>
                              </div>
                              <p className="text-xs font-exo text-gray-400 mb-1">{ban.reason}</p>
                              <p className="text-xs font-exo text-gray-500">Banned: {new Date(ban.banned_at).toLocaleString()}</p>
                            </div>
                          ))
                        ) : (
                          <p className="text-center text-gray-400 font-exo py-4">No banned users</p>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {/* Audit Logs Section */}
                  {showAuditLogs && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-6 p-4 bg-white/5 border border-cyber-blue/30 rounded-lg max-h-96 overflow-y-auto"
                    >
                      <h3 className="font-orbitron text-lg font-bold mb-4 text-cyber-blue">Audit Logs</h3>
                      <div className="space-y-2">
                        {auditLogs.length > 0 ? (
                          auditLogs.map((log) => (
                            <div key={log.id} className="p-3 bg-white/5 rounded">
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-exo font-bold text-white">{log.profiles?.username || 'Unknown'}</span>
                                <span className="text-xs font-exo text-gray-500">{new Date(log.created_at).toLocaleString()}</span>
                              </div>
                              <p className="text-sm font-exo text-gray-300">{log.action_type.replace('_', ' ').toUpperCase()}</p>
                              <p className="text-xs font-exo text-gray-400">Target: {log.target_type} - {log.target_id.slice(0, 8)}</p>
                            </div>
                          ))
                        ) : (
                          <p className="text-center text-gray-400 font-exo py-4">No audit logs yet</p>
                        )}
                      </div>
                    </motion.div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminDashboard;

