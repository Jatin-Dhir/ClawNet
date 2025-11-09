import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { motion, useInView } from 'framer-motion';
import { Link, Navigate } from 'react-router-dom';
import {
  Shield,
  Users,
  TrendingUp,
  Download,
  Mail,
  FileText,
  Trash2,
  BarChart3,
  Activity,
  Zap,
  Eye,
  ArrowLeft,
  Settings,
  RefreshCw,
  Ban,
  MessageSquare,
  UserCog,
  Search,
  Filter,
  Database,
  Tag,
  Clock,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Edit,
  Star,
  TrendingDown,
  Bell,
  Send,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';

const SERVICE_REQUEST_STATUSES = ['pending', 'contacted', 'in_progress', 'completed', 'closed'];
const FALLBACK_ADMIN_EMAILS = [
  'admin@projectclawnet.online',
  'team@projectclawnet.online',
  'dhirjatin@icloud.com',
  'dhirjatin@outlook.com',
];

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
  const [serviceRequests, setServiceRequests] = useState([]);
  const [serviceRequestFilter, setServiceRequestFilter] = useState('all');
  const [serviceRequestSearch, setServiceRequestSearch] = useState('');
  const [requestNotes, setRequestNotes] = useState({});
  const [users, setUsers] = useState([]);
  const [posts, setPosts] = useState([]);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [recentActivity, setRecentActivity] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [selectedPosts, setSelectedPosts] = useState([]);
  const [showReputationModal, setShowReputationModal] = useState(false);
  const [reputationUser, setReputationUser] = useState(null);
  const [reputationValue, setReputationValue] = useState(0);
  const [flaggedContent, setFlaggedContent] = useState([]);
  const [flaggedFilter, setFlaggedFilter] = useState('pending');
  const [systemHealth, setSystemHealth] = useState({
    dbSize: 0,
    avgResponseTime: 0,
    uptime: 99.9,
    activeConnections: 0
  });
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

  const filteredServiceRequests = useMemo(() => {
    const query = serviceRequestSearch.trim().toLowerCase();
    return serviceRequests.filter((request) => {
      const matchesStatus =
        serviceRequestFilter === 'all' || request.status === serviceRequestFilter;
      const haystack = `${request.service_name ?? ''} ${request.user_email ?? ''} ${
        request.message ?? ''
      } ${request.admin_notes ?? ''}`.toLowerCase();
      const matchesQuery = !query || haystack.includes(query);
      return matchesStatus && matchesQuery;
    });
  }, [serviceRequests, serviceRequestFilter, serviceRequestSearch]);

  const pendingRequestCount = useMemo(
    () => serviceRequests.filter((request) => request.status === 'pending').length,
    [serviceRequests]
  );

  const filteredUsers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) => (user.username ?? '').toLowerCase().includes(query));
  }, [users, searchQuery]);

  const recentUsersList = useMemo(() => users.slice(0, 6), [users]);
  const recentPostsList = useMemo(() => posts.slice(0, 10), [posts]);

  useEffect(() => {
    setRequestNotes((prev) => {
      const updated = {};
      serviceRequests.forEach((request) => {
        updated[request.id] = Object.prototype.hasOwnProperty.call(prev, request.id)
          ? prev[request.id]
          : request.admin_notes || '';
      });
      return updated;
    });
  }, [serviceRequests]);

  // Verify admin access against Supabase profile (with fallback email allow list)
  useEffect(() => {
    const verifyAdmin = async () => {
      if (!session?.user) {
        console.log('AdminDashboard: No session found');
        setIsAuthorized(false);
        setLoading(false);
        return;
      }

      const userEmail = session.user.email?.trim().toLowerCase();
      if (userEmail && FALLBACK_ADMIN_EMAILS.includes(userEmail)) {
        console.log('AdminDashboard: matched fallback admin email', { userEmail });
        setIsAuthorized(true);
        setLoading(false);
        return;
      }

      if (profile && typeof profile.is_admin === 'boolean') {
        console.log('AdminDashboard: using profile flag', { is_admin: profile.is_admin });
        setIsAuthorized(profile.is_admin === true);
        setLoading(false);
        return;
      }

      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('is_admin')
          .eq('id', session.user.id)
          .single();

        if (error) throw error;

        const isAdmin = data?.is_admin === true;
        console.log('AdminDashboard: fetched admin flag', { is_admin: isAdmin });
        setIsAuthorized(isAdmin);
      } catch (error) {
        console.error('AdminDashboard: error verifying admin status', error);
        setIsAuthorized(false);
      } finally {
        setLoading(false);
      }
    };

    verifyAdmin();
  }, [session, profile]);

  useEffect(() => {
    if (!isAuthorized) return;
    fetchAnalytics();
    const interval = setInterval(fetchAnalytics, 30000);
    return () => clearInterval(interval);
  }, [isAuthorized]);

  useEffect(() => {
    if (activeTab === 'moderation' && isAuthorized) {
      fetchFlaggedContent();
    }
  }, [activeTab, flaggedFilter, isAuthorized]);

  const fetchAnalytics = useCallback(async () => {
    try {
      setIsRefreshing(true);

      const [
        userCountResult,
        postCountResult,
        commentCountResult,
        serviceRequestsResult,
        recentUsersResult,
        postsResult,
        downloadStatsResult,
        analyticsEventsResult,
        adminActionsResult,
      ] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('posts').select('*', { count: 'exact', head: true }),
        supabase.from('comments').select('*', { count: 'exact', head: true }),
        supabase
          .from('service_requests')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('profiles')
          .select('id, username, created_at, reputation, is_admin')
          .order('created_at', { ascending: false })
          .limit(30),
        supabase
          .from('posts')
          .select('id, title, category, created_at, tags, profiles(username)')
          .order('created_at', { ascending: false })
          .limit(40),
        supabase
          .from('download_stats')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('analytics')
          .select('event_type, created_at, entity_type, metadata')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('admin_actions')
          .select('*, profiles:admin_id(username)')
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      const serviceRequestsData = serviceRequestsResult.data || [];
      const usersData = recentUsersResult.data || [];
      const postsData = postsResult.data || [];
      const downloadStatsData = downloadStatsResult.data || [];
      const analyticsEvents = analyticsEventsResult.data || [];
      const adminActions = adminActionsResult.data || [];

      setServiceRequests(serviceRequestsData);
      setUsers(usersData);
      setPosts(postsData);

      // Build recent activity feed from multiple sources
      const activityFeed = [];
      
      // Add recent posts
      postsData.slice(0, 5).forEach(post => {
        activityFeed.push({
          type: 'post',
          icon: FileText,
          color: 'text-purple-400',
          title: `New post: ${post.title}`,
          user: post.profiles?.username || 'Unknown',
          timestamp: post.created_at
        });
      });

      // Add recent downloads
      downloadStatsData.slice(0, 5).forEach(download => {
        activityFeed.push({
          type: 'download',
          icon: Download,
          color: 'text-green-400',
          title: `Downloaded ${download.tool_name}`,
          user: 'User',
          timestamp: download.created_at
        });
      });

      // Add admin actions
      adminActions.slice(0, 5).forEach(action => {
        activityFeed.push({
          type: 'admin_action',
          icon: Shield,
          color: 'text-red-400',
          title: `Admin: ${action.action_type.replace(/_/g, ' ')}`,
          user: action.profiles?.username || 'Admin',
          timestamp: action.created_at
        });
      });

      // Sort by timestamp and take top 15
      activityFeed.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      setRecentActivity(activityFeed.slice(0, 15));

      const tagCounts = {};
      postsData.forEach((post) => {
        if (Array.isArray(post.tags)) {
          post.tags.forEach((tag) => {
            const normalizedTag = tag?.toLowerCase();
            if (normalizedTag) {
              tagCounts[normalizedTag] = (tagCounts[normalizedTag] || 0) + 1;
            }
          });
        }
      });

      const topTags = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      const contributorCounts = {};
      postsData.forEach((post) => {
        const username = post.profiles?.username || 'Unknown';
        contributorCounts[username] = (contributorCounts[username] || 0) + 1;
      });

      const topContributors = Object.entries(contributorCounts)
        .map(([username, count]) => ({ username, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfWeek = new Date(now);
      startOfWeek.setDate(startOfWeek.getDate() - 7);
      const startOfMonth = new Date(now);
      startOfMonth.setMonth(startOfMonth.getMonth() - 1);

      const downloadStats = {
        today: downloadStatsData.filter((d) => new Date(d.created_at) >= startOfDay).length,
        thisWeek: downloadStatsData.filter((d) => new Date(d.created_at) >= startOfWeek).length,
        thisMonth: downloadStatsData.filter((d) => new Date(d.created_at) >= startOfMonth).length,
        total: downloadStatsData.length,
      };

      const eventStats = analyticsEvents.reduce((acc, event) => {
        if (event.event_type) {
          acc[event.event_type] = (acc[event.event_type] || 0) + 1;
        }
        return acc;
      }, {});

      const pendingRequests = serviceRequestsData.filter((r) => r.status === 'pending').length;

      setAnalytics({
        totalUsers: userCountResult.count || 0,
        totalPosts: postCountResult.count || 0,
        totalComments: commentCountResult.count || 0,
        totalDownloads: downloadStats.total,
        pendingServiceRequests: pendingRequests,
        recentUsers: usersData.slice(0, 6),
        recentPosts: postsData.slice(0, 10),
        recentServiceRequests: serviceRequestsData.slice(0, 10),
        downloadStats,
        eventStats,
        topTags,
        topContributors,
      });
    } catch (error) {
      console.error('Error fetching analytics:', error);
      toast.error('Failed to fetch analytics data');
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const handleDeletePost = async (postId) => {
    if (!confirm('Are you sure you want to delete this post?')) return;
    
    try {
      const { error } = await supabase
        .from('posts')
        .delete()
        .eq('id', postId);

      if (error) throw error;

      await logAdminAction('delete_post', 'post', postId.toString(), {});
      toast.success('Post deleted successfully');
      setPosts((prev) => prev.filter((post) => post.id !== postId));
      fetchAnalytics();
    } catch (error) {
      console.error('Error deleting post:', error);
      toast.error('Failed to delete post');
    }
  };

  const handleBulkDeletePosts = async () => {
    if (selectedPosts.length === 0) {
      toast.error('No posts selected');
      return;
    }
    if (!confirm(`Delete ${selectedPosts.length} selected posts?`)) return;

    const toastId = toast.loading(`Deleting ${selectedPosts.length} posts...`);
    try {
      const { error } = await supabase
        .from('posts')
        .delete()
        .in('id', selectedPosts);

      if (error) throw error;

      await logAdminAction('bulk_delete_posts', 'post', 'multiple', { count: selectedPosts.length });
      toast.success(`${selectedPosts.length} posts deleted`, { id: toastId });
      setSelectedPosts([]);
      fetchAnalytics();
    } catch (error) {
      console.error('Error bulk deleting posts:', error);
      toast.error('Failed to delete posts', { id: toastId });
    }
  };

  const handleBulkBanUsers = async () => {
    if (selectedUsers.length === 0) {
      toast.error('No users selected');
      return;
    }
    const reason = prompt('Enter reason for bulk ban:');
    if (!reason || !confirm(`Ban ${selectedUsers.length} selected users?`)) return;

    const toastId = toast.loading(`Banning ${selectedUsers.length} users...`);
    try {
      const banRecords = selectedUsers.map(userId => ({
        user_id: userId,
        admin_id: session.user.id,
        reason,
        is_active: true
      }));

      const { error } = await supabase
        .from('banned_users')
        .insert(banRecords);

      if (error) throw error;

      await logAdminAction('bulk_ban_users', 'user', 'multiple', { count: selectedUsers.length, reason });
      toast.success(`${selectedUsers.length} users banned`, { id: toastId });
      setSelectedUsers([]);
      fetchAnalytics();
    } catch (error) {
      console.error('Error bulk banning users:', error);
      toast.error('Failed to ban users', { id: toastId });
    }
  };

  const handleUpdateReputation = async () => {
    if (!reputationUser) return;

    const toastId = toast.loading('Updating reputation...');
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ reputation: reputationValue })
        .eq('id', reputationUser.id);

      if (error) throw error;

      await logAdminAction('update_reputation', 'user', reputationUser.id, { 
        username: reputationUser.username,
        old_reputation: reputationUser.reputation,
        new_reputation: reputationValue
      });

      toast.success('Reputation updated', { id: toastId });
      setShowReputationModal(false);
      setReputationUser(null);
      fetchAnalytics();
    } catch (error) {
      console.error('Error updating reputation:', error);
      toast.error('Failed to update reputation', { id: toastId });
    }
  };

  const handleUpdateServiceRequest = async (requestId, updates, successMessage = 'Service request updated') => {
    const toastId = toast.loading('Saving changes...');
    try {
      const { data, error } = await supabase
        .from('service_requests')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', requestId)
        .select()
        .single();

      if (error) throw error;

      setServiceRequests((prev) =>
        prev.map((request) => (request.id === requestId ? { ...request, ...data } : request))
      );

      toast.success(successMessage, { id: toastId });
      fetchAnalytics();
    } catch (error) {
      console.error('Error updating request:', error);
      toast.error('Failed to update request', { id: toastId });
    }
  };

  const handleStatusChange = (requestId, status) => {
    const currentRequest = serviceRequests.find((request) => request.id === requestId);
    if (!currentRequest || currentRequest.status === status) return;
    handleUpdateServiceRequest(requestId, { status }, 'Status updated');
  };

  const handleSaveRequestNotes = (requestId) => {
    const draftNotes = (requestNotes[requestId] ?? '').trim();
    const currentRequest = serviceRequests.find((request) => request.id === requestId);
    if (!currentRequest || (currentRequest.admin_notes || '').trim() === draftNotes) {
      return;
    }
    handleUpdateServiceRequest(requestId, { admin_notes: draftNotes }, 'Notes saved');
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

    const toastId = toast.loading('Adding admin...');
    try {
      const emailLower = newAdminEmail.toLowerCase().trim();
      
      // Look up user by email in our user_emails table
      const { data: userEmail, error: emailError } = await supabase
        .from('user_emails')
        .select('user_id')
        .eq('email', emailLower)
        .single();

      if (emailError || !userEmail) {
        toast.error('User not found. Make sure they have signed up and logged in at least once.', { id: toastId });
        return;
      }

      // Update the profile to make them admin
      const { data: updatedProfile, error: updateError } = await supabase
        .from('profiles')
        .update({ is_admin: true })
        .eq('id', userEmail.user_id)
        .select('id, username')
        .single();

      if (updateError) throw updateError;

      await logAdminAction('add_admin', 'user', updatedProfile.id, { email: newAdminEmail, username: updatedProfile.username });
      
      toast.success(`${updatedProfile.username} is now an admin! They need to refresh to see the admin button.`, { id: toastId });
      setNewAdminEmail('');
      fetchAdmins();
    } catch (error) {
      console.error('Error adding admin:', error);
      toast.error('Failed to add admin. Ensure the user has signed up first.', { id: toastId });
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
    const toastId = toast.loading('Fetching database stats...');
    try {
      const [
        usersCount,
        postsCount,
        commentsCount,
        downloadsCount,
        serviceRequestsCount,
      ] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('posts').select('*', { count: 'exact', head: true }),
        supabase.from('comments').select('*', { count: 'exact', head: true }),
        supabase.from('download_stats').select('*', { count: 'exact', head: true }),
        supabase.from('service_requests').select('*', { count: 'exact', head: true }),
      ]);

      setDbStats({
        users: usersCount.count || 0,
        posts: postsCount.count || 0,
        comments: commentsCount.count || 0,
        downloads: downloadsCount.count || 0,
        serviceRequests: serviceRequestsCount.count || 0,
      });

      setShowDbStats(true);
      toast.success('Database stats loaded successfully', { id: toastId });
    } catch (error) {
      console.error('Error fetching database stats:', error);
      toast.error('Failed to fetch database stats', { id: toastId });
    }
  };

  const exportDatabase = async () => {
    const toastId = toast.loading('Preparing data export...');
    try {
      const [
        serviceRequestsResult,
        postsResult,
        usersResult,
        downloadsResult,
        auditLogResult,
      ] = await Promise.all([
        supabase.from('service_requests').select('*').order('created_at', { ascending: false }),
        supabase
          .from('posts')
          .select('id, title, category, tags, created_at, user_id')
          .order('created_at', { ascending: false }),
        supabase
          .from('profiles')
          .select('id, username, created_at, reputation, is_admin')
          .order('created_at', { ascending: false }),
        supabase.from('download_stats').select('*').order('created_at', { ascending: false }),
        supabase
          .from('admin_actions')
          .select('id, admin_id, action_type, target_type, target_id, created_at')
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      const firstError = [
        serviceRequestsResult,
        postsResult,
        usersResult,
        downloadsResult,
        auditLogResult,
      ].find((result) => result?.error);
      if (firstError?.error) {
        throw firstError.error;
      }

      const payload = {
        exported_at: new Date().toISOString(),
        service_requests: serviceRequestsResult.data ?? [],
        posts: postsResult.data ?? [],
        users: usersResult.data ?? [],
        download_stats: downloadsResult.data ?? [],
        admin_actions: auditLogResult.data ?? [],
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `clawnet-admin-export-${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success('Export ready. Check your downloads.', { id: toastId });
    } catch (error) {
      console.error('Error exporting data:', error);
      toast.error('Failed to export data', { id: toastId });
    }
  };

  const seedSampleData = async () => {
    if (!confirm('This will add comprehensive sample data to the database. Continue?')) return;
    
    const toastId = toast.loading('Seeding sample data...');
    try {
      
      // First, get current user ID
      const currentUserId = session.user.id;
      
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
        },
        {
          user_email: 'david.kim@enterprise.com',
          service_type: 'network-security',
          service_name: 'Network Security Assessment',
          message: 'Need assessment for our corporate network infrastructure including firewalls and VPN configurations.',
          status: 'pending'
        },
        {
          user_email: 'lisa.patel@healthcare.org',
          service_type: 'custom-solutions',
          service_name: 'Custom Security Solutions',
          message: 'We need a custom HIPAA-compliant security monitoring system for our healthcare platform.',
          status: 'pending'
        }
      ];

      await supabase.from('service_requests').insert(sampleServiceRequests);

      // Seed download stats (more diverse)
      const sampleDownloads = [
        { tool_name: 'ClawView', platform: 'windows', version: 'v2.1.0', file_path: 'clawview/clawview-v2.1.0.exe', user_id: currentUserId },
        { tool_name: 'PortLock', platform: 'linux', version: 'v1.5.0', file_path: 'portlock/portlock-v1.5.0.tar.gz', user_id: currentUserId },
        { tool_name: 'ClawNet Core', platform: 'macos', version: 'v0.8.1', file_path: 'clawnet-core/clawnet-core-v0.8.1.dmg', user_id: currentUserId },
        { tool_name: 'ClawView', platform: 'windows', version: 'v2.1.0', file_path: 'clawview/clawview-v2.1.0.exe', user_id: currentUserId },
        { tool_name: 'PortLock', platform: 'windows', version: 'v1.5.0', file_path: 'portlock/portlock-v1.5.0.exe', user_id: currentUserId },
        { tool_name: 'ClawView', platform: 'macos', version: 'v2.1.0', file_path: 'clawview/clawview-v2.1.0.dmg', user_id: currentUserId },
        { tool_name: 'ClawNet Core', platform: 'linux', version: 'v0.8.1', file_path: 'clawnet-core/clawnet-core-v0.8.1-linux.tar.gz', user_id: currentUserId },
        { tool_name: 'PortLock', platform: 'linux', version: 'v1.5.0', file_path: 'portlock/portlock-v1.5.0.tar.gz', user_id: currentUserId },
        { tool_name: 'ClawView', platform: 'windows', version: 'v2.0.5', file_path: 'clawview/clawview-v2.0.5.exe', user_id: currentUserId },
        { tool_name: 'PortLock', platform: 'windows', version: 'v1.4.2', file_path: 'portlock/portlock-v1.4.2.exe', user_id: currentUserId }
      ];

      await supabase.from('download_stats').insert(sampleDownloads);

      // Seed analytics events
      const sampleAnalytics = [
        { event_type: 'page_view', entity_type: 'service', entity_id: 'vapt', user_id: currentUserId, metadata: { page: '/services/vapt' } },
        { event_type: 'download', entity_type: 'tool', entity_id: 'clawview', user_id: currentUserId, metadata: { tool: 'ClawView' } },
        { event_type: 'page_view', entity_type: 'service', entity_id: 'web-security', user_id: currentUserId, metadata: { page: '/services/web-application-security' } },
        { event_type: 'download', entity_type: 'tool', entity_id: 'portlock', user_id: currentUserId, metadata: { tool: 'PortLock' } },
        { event_type: 'service_view', entity_type: 'service', entity_id: 'cloud-security', user_id: currentUserId, metadata: { service: 'Cloud Security Review' } }
      ];

      await supabase.from('analytics').insert(sampleAnalytics);

      toast.success('Sample data seeded successfully!', { id: toastId });
      fetchAnalytics();
    } catch (error) {
      console.error('Error seeding sample data:', error);
      toast.error('Failed to seed sample data', { id: toastId });
    }
  };

  const fetchSystemHealth = async () => {
    const toastId = toast.loading('Checking system health...');
    try {
      const startTime = Date.now();
      
      // Fetch database size estimate
      const { data: tableData } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true });
      
      const responseTime = Date.now() - startTime;

      // Simulate system metrics (in production, these would come from actual monitoring)
      setSystemHealth({
        dbSize: Math.round(Math.random() * 50 + 10), // Simulated
        avgResponseTime: responseTime,
        uptime: 99.9,
        activeConnections: Math.round(Math.random() * 20 + 5) // Simulated
      });

      toast.success('System health updated', { id: toastId });
    } catch (error) {
      console.error('Error fetching system health:', error);
      toast.error('Failed to fetch system health', { id: toastId });
    }
  };

  const sendServiceRequestNotification = async (requestId) => {
    const request = serviceRequests.find(r => r.id === requestId);
    if (!request) return;

    const toastId = toast.loading('Sending notification...');
    try {
      // In production, this would integrate with an email service
      // For now, we'll just log the action
      await logAdminAction('send_notification', 'service_request', requestId.toString(), {
        email: request.user_email,
        service: request.service_name
      });

      toast.success(`Notification sent to ${request.user_email}`, { id: toastId });
    } catch (error) {
      console.error('Error sending notification:', error);
      toast.error('Failed to send notification', { id: toastId });
    }
  };

  const fetchFlaggedContent = async () => {
    try {
      const { data, error } = await supabase
        .from('flagged_content')
        .select('*, reporter:reporter_id(username), posts(title, category)')
        .eq('status', flaggedFilter)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setFlaggedContent(data || []);
    } catch (error) {
      console.error('Error fetching flagged content:', error);
      toast.error('Failed to fetch flagged content');
    }
  };

  const handleReviewFlag = async (flagId, action) => {
    const toastId = toast.loading('Processing...');
    try {
      const { error } = await supabase
        .from('flagged_content')
        .update({
          status: action === 'dismiss' ? 'dismissed' : 'actioned',
          reviewed_by: session.user.id,
          reviewed_at: new Date().toISOString()
        })
        .eq('id', flagId);

      if (error) throw error;

      await logAdminAction(`flag_${action}`, 'flagged_content', flagId.toString(), {});
      toast.success(`Flag ${action}ed`, { id: toastId });
      fetchFlaggedContent();
    } catch (error) {
      console.error('Error reviewing flag:', error);
      toast.error('Failed to process flag', { id: toastId });
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

  if (!session || !isAuthorized) {
    return <Navigate to="/" replace />;
  }

  const stats = [
    { label: 'Total Users', value: analytics.totalUsers, icon: Users, color: 'text-blue-400', change: '+12%' },
    { label: 'Total Posts', value: analytics.totalPosts, icon: FileText, color: 'text-purple-400', change: '+8%' },
    { label: 'Total Comments', value: analytics.totalComments, icon: MessageSquare, color: 'text-cyan-400', change: '+15%' },
    { label: 'Downloads', value: analytics.totalDownloads, icon: Download, color: 'text-green-400', change: '+25%' },
    { label: 'Pending Requests', value: pendingRequestCount, icon: Mail, color: 'text-orange-400', change: null }
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

            <div className="flex flex-col sm:flex-row items-start gap-4 sm:gap-6">
              <div className="p-3 sm:p-4 bg-gradient-to-br from-cyber-blue to-cyber-cyan rounded-xl">
                <Shield className="w-8 h-8 sm:w-12 sm:h-12 text-white" />
              </div>
              <div className="flex-1">
                <h1 className="font-orbitron text-3xl sm:text-5xl md:text-6xl font-black leading-tight mb-2">
                  ADMIN CONTROL
                </h1>
                <p className="font-exo text-base sm:text-lg text-gray-400 mb-4">
                  ProjectClawNet Dashboard & Analytics
                </p>
                <div className="flex flex-wrap items-center gap-2 sm:gap-4">
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
                { id: 'moderation', label: 'Moderation', icon: Shield },
                { id: 'users', label: 'Users', icon: Users },
                { id: 'analytics', label: 'Analytics', icon: Activity },
                { id: 'settings', label: 'Settings', icon: Settings }
              ].map((tab) => {
                const Icon = tab.icon;
                return (
                  <motion.button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-6 py-2 sm:py-3 border-b-2 transition-all font-exo font-bold text-xs sm:text-sm uppercase tracking-wider whitespace-nowrap ${
                      activeTab === tab.id
                        ? 'border-cyber-blue text-cyber-blue'
                        : 'border-transparent text-gray-400 hover:text-white'
                    }`}
                    whileHover={{ y: -2 }}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="hidden sm:inline">{tab.label}</span>
                    <span className="sm:hidden">{tab.label.split(' ')[0]}</span>
                  </motion.button>
                );
              })}
            </div>
          </motion.div>

          {/* Tab Content */}
          {activeTab === 'overview' && (
            <>
              {/* Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4 mb-8 sm:mb-12">
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
                  <div className="flex items-center justify-between mb-3 sm:mb-4">
                    <Icon className={`w-6 h-6 sm:w-8 sm:h-8 ${stat.color}`} />
                    {stat.change && (
                      <div className="flex items-center gap-1 text-green-400">
                        <TrendingUp className="w-3 h-3 sm:w-4 sm:h-4" />
                        <span className="font-exo text-xs font-bold">{stat.change}</span>
                      </div>
                    )}
                  </div>
                  <div className="font-orbitron text-2xl sm:text-3xl font-black text-white mb-1">{stat.value}</div>
                  <div className="font-exo text-xs text-gray-400 uppercase tracking-wider">{stat.label}</div>
                </motion.div>
              );
            })}
          </div>

          {/* Main Content Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 mb-8 sm:mb-12">
            {/* Recent Service Requests */}
            <div className="lg:col-span-2">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.3 }}
                className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm"
              >
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 sm:mb-6 gap-3">
                  <h2 className="font-orbitron text-xl sm:text-2xl font-bold flex items-center gap-2 sm:gap-3">
                    <Mail className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
                    Service Requests
                  </h2>
                  <span className="px-3 py-1 bg-red-500/20 border border-red-500/50 rounded-full text-xs font-exo text-red-400 w-fit">
                    {pendingRequestCount} Pending
                  </span>
                </div>
                <div className="flex flex-col md:flex-row gap-3 mb-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 w-4 h-4" />
                    <input
                      type="text"
                      value={serviceRequestSearch}
                      onChange={(e) => setServiceRequestSearch(e.target.value)}
                      placeholder="Search by company, email, or notes..."
                      className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyber-blue"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-gray-400" />
                    <select
                      value={serviceRequestFilter}
                      onChange={(e) => setServiceRequestFilter(e.target.value)}
                      className="px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-cyber-blue"
                    >
                      <option value="all">All statuses</option>
                      {SERVICE_REQUEST_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {status.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-3 max-h-[28rem] overflow-y-auto pr-1">
                  {filteredServiceRequests.length > 0 ? (
                    filteredServiceRequests.map((request) => {
                      const draftNotes = requestNotes[request.id] ?? '';
                      const notesChanged =
                        (request.admin_notes || '').trim() !== draftNotes.trim();
                      return (
                        <div
                          key={request.id}
                          className="p-4 bg-white/5 border border-white/10 rounded-lg hover:border-cyber-blue/30 transition-all"
                        >
                          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                            <div className="flex-1">
                              <div className="flex items-center flex-wrap gap-2 mb-2">
                                <span className="font-orbitron text-sm font-bold text-white">
                                  {request.service_name}
                                </span>
                                <span className="px-2 py-0.5 text-xs font-exo uppercase tracking-wider rounded border border-white/10 text-gray-300">
                                  {request.service_type}
                                </span>
                              </div>
                              <p className="text-xs font-exo text-gray-400 mb-2">
                                {request.user_email}
                              </p>
                              {request.message && (
                                <p className="text-sm font-exo text-gray-300 leading-relaxed">
                                  {request.message}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-exo text-xs uppercase text-gray-400">Status</span>
                              <select
                                value={request.status || 'pending'}
                                onChange={(e) => handleStatusChange(request.id, e.target.value)}
                                className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-white uppercase tracking-wider focus:outline-none focus:border-cyber-blue"
                              >
                                {SERVICE_REQUEST_STATUSES.map((status) => (
                                  <option key={status} value={status}>
                                    {status.replace(/_/g, ' ')}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div className="mt-3">
                            <label className="block text-xs font-exo text-gray-400 mb-1">
                              Admin notes
                            </label>
                            <textarea
                              value={draftNotes}
                              onChange={(e) =>
                                setRequestNotes((prev) => ({ ...prev, [request.id]: e.target.value }))
                              }
                              rows={3}
                              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyber-blue resize-none"
                              placeholder="Document outreach, follow-up dates, and next steps..."
                            />
                          </div>
                          <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <p className="text-xs font-exo text-gray-500">
                              Created {new Date(request.created_at).toLocaleString()}
                            </p>
                            <div className="flex items-center gap-2 flex-wrap">
                              <button
                                onClick={() => handleSaveRequestNotes(request.id)}
                                disabled={!notesChanged}
                                className="px-3 py-1.5 text-xs font-exo font-bold uppercase tracking-wider border border-cyber-blue/50 rounded hover:bg-cyber-blue/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Save Notes
                              </button>
                              <button
                                onClick={() => sendServiceRequestNotification(request.id)}
                                className="px-3 py-1.5 text-xs font-exo font-bold uppercase tracking-wider bg-green-500/20 border border-green-500/50 rounded hover:bg-green-500/30 transition-all flex items-center gap-1"
                              >
                                <Send className="w-3 h-3" />
                                Email
                              </button>
                              {request.updated_at && (
                                <span className="text-[11px] font-exo text-gray-500">
                                  Updated {new Date(request.updated_at).toLocaleString()}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-center text-gray-400 font-exo py-8">
                      No service requests match your filters
                    </p>
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
                className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm"
              >
                <h2 className="font-orbitron text-xl sm:text-2xl font-bold flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
                  <Zap className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
                  Quick Actions
                </h2>
                <div className="space-y-3">
                  <motion.button
                    onClick={() => fetchAnalytics()}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    disabled={isRefreshing}
                    className="w-full p-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-white font-orbitron font-bold text-sm uppercase tracking-wider rounded-lg flex items-center justify-center gap-3 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
                    {isRefreshing ? 'Refreshing...' : 'Refresh Metrics'}
                  </motion.button>
                  <motion.button
                    onClick={() => {
                      setActiveTab('settings');
                      setShowManageAdmins(true);
                      fetchAdmins();
                    }}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full p-3 border border-white/20 hover:border-cyber-blue/50 font-orbitron font-bold text-sm uppercase tracking-wider rounded-lg flex items-center justify-center gap-3 transition-all"
                  >
                    <UserCog className="w-5 h-5" />
                    Manage Admins
                  </motion.button>
                  <motion.button
                    onClick={exportDatabase}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full p-3 border border-white/20 hover:border-cyber-blue/50 font-orbitron font-bold text-sm uppercase tracking-wider rounded-lg flex items-center justify-center gap-3 transition-all"
                  >
                    <Download className="w-5 h-5" />
                    Export Snapshot
                  </motion.button>
                  <motion.button
                    onClick={seedSampleData}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="w-full p-3 border border-green-500/40 bg-green-500/10 hover:bg-green-500/20 font-orbitron font-bold text-sm uppercase tracking-wider rounded-lg flex items-center justify-center gap-3 transition-all"
                  >
                    <Database className="w-5 h-5" />
                    Seed Demo Data
                  </motion.button>
                </div>
              </motion.div>

              {/* Download Stats */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ delay: 0.5 }}
                className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm mt-4 sm:mt-6"
              >
                <h2 className="font-orbitron text-xl sm:text-2xl font-bold flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
                  <Download className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
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
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
            {/* Recent Posts */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ delay: 0.6 }}
              className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm"
            >
              <div className="flex items-center justify-between mb-4 sm:mb-6">
                <h2 className="font-orbitron text-xl sm:text-2xl font-bold flex items-center gap-2 sm:gap-3">
                  <FileText className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
                  Recent Posts
                </h2>
                {selectedPosts.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-exo text-gray-400">{selectedPosts.length} selected</span>
                    <button
                      onClick={handleBulkDeletePosts}
                      className="px-2 py-1 text-xs font-exo font-bold uppercase bg-red-500/20 border border-red-500/50 rounded hover:bg-red-500/30 transition-all"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {recentPostsList.length > 0 ? (
                  recentPostsList.map((post) => (
                    <div key={post.id} className="p-4 bg-white/5 border border-white/10 rounded-lg hover:border-cyber-blue/30 transition-all group relative">
                      <input
                        type="checkbox"
                        checked={selectedPosts.includes(post.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedPosts(prev => [...prev, post.id]);
                          } else {
                            setSelectedPosts(prev => prev.filter(id => id !== post.id));
                          }
                        }}
                        className="absolute top-3 right-3 w-4 h-4 rounded border-2 border-cyber-blue/50 bg-cyber-black checked:bg-cyber-blue cursor-pointer"
                      />
                      <div className="flex items-start justify-between mb-2 pr-8">
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
              className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm"
            >
              <h2 className="font-orbitron text-xl sm:text-2xl font-bold flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
                <Users className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
                Recent Users
              </h2>
              <div className="space-y-3">
                {recentUsersList.length > 0 ? (
                  recentUsersList.map((user) => (
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

          {activeTab === 'moderation' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {/* Flagged Content Queue */}
              <div className="mb-6">
                <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-orbitron text-xl sm:text-2xl font-bold flex items-center gap-2 sm:gap-3">
                      <AlertTriangle className="w-5 h-5 sm:w-6 sm:h-6 text-orange-400" />
                      Content Moderation Queue
                    </h2>
                    <div className="flex items-center gap-2">
                      <select
                        value={flaggedFilter}
                        onChange={(e) => {
                          setFlaggedFilter(e.target.value);
                          fetchFlaggedContent();
                        }}
                        className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-white focus:outline-none focus:border-cyber-blue"
                      >
                        <option value="pending">Pending</option>
                        <option value="reviewed">Reviewed</option>
                        <option value="actioned">Actioned</option>
                        <option value="dismissed">Dismissed</option>
                      </select>
                      <button
                        onClick={fetchFlaggedContent}
                        className="p-1.5 border border-cyber-blue/50 rounded hover:bg-cyber-blue/10 transition-all"
                      >
                        <RefreshCw className="w-4 h-4 text-cyber-blue" />
                      </button>
                    </div>
                  </div>
                  <div className="space-y-3 max-h-80 overflow-y-auto">
                    {flaggedContent.length > 0 ? (
                      flaggedContent.map((flag) => (
                        <div key={flag.id} className="p-4 bg-white/5 border border-white/10 rounded-lg">
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="px-2 py-0.5 text-xs font-exo uppercase bg-orange-500/20 border border-orange-500/40 rounded text-orange-300">
                                  {flag.content_type}
                                </span>
                                <span className="text-xs font-exo text-gray-400">
                                  Reported by {flag.reporter?.username || 'Unknown'}
                                </span>
                              </div>
                              <p className="font-exo text-sm text-white mb-1">
                                {flag.posts?.title || `${flag.content_type} #${flag.content_id}`}
                              </p>
                              <p className="text-xs font-exo text-gray-400 mb-2">
                                Reason: {flag.reason}
                              </p>
                              <p className="text-xs font-exo text-gray-500">
                                {new Date(flag.created_at).toLocaleString()}
                              </p>
                            </div>
                          </div>
                          {flag.status === 'pending' && (
                            <div className="flex gap-2 mt-3">
                              <button
                                onClick={() => handleReviewFlag(flag.id, 'action')}
                                className="px-3 py-1.5 text-xs font-exo font-bold uppercase bg-red-500/20 border border-red-500/50 rounded hover:bg-red-500/30 transition-all flex items-center gap-1"
                              >
                                <Trash2 className="w-3 h-3" />
                                Take Action
                              </button>
                              <button
                                onClick={() => handleReviewFlag(flag.id, 'dismiss')}
                                className="px-3 py-1.5 text-xs font-exo font-bold uppercase bg-green-500/20 border border-green-500/50 rounded hover:bg-green-500/30 transition-all flex items-center gap-1"
                              >
                                <CheckCircle className="w-3 h-3" />
                                Dismiss
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-center text-gray-400 font-exo py-8">No flagged content in this category</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
                {/* Real-Time Activity Feed */}
                <div className="lg:col-span-2">
                  <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                    <h2 className="font-orbitron text-xl sm:text-2xl font-bold flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
                      <Activity className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
                      Real-Time Activity Feed
                    </h2>
                    <div className="space-y-2 max-h-[32rem] overflow-y-auto pr-1">
                      {recentActivity.length > 0 ? (
                        recentActivity.map((activity, index) => {
                          const Icon = activity.icon;
                          return (
                            <motion.div
                              key={index}
                              initial={{ opacity: 0, x: -20 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: index * 0.05 }}
                              className="flex items-center gap-3 p-3 bg-white/5 border border-white/10 rounded-lg hover:border-cyber-blue/30 transition-all"
                            >
                              <Icon className={`w-5 h-5 ${activity.color}`} />
                              <div className="flex-1 min-w-0">
                                <p className="font-exo text-sm text-white truncate">{activity.title}</p>
                                <p className="text-xs text-gray-400">by {activity.user}</p>
                              </div>
                              <div className="flex items-center gap-1 text-xs text-gray-500">
                                <Clock className="w-3 h-3" />
                                {new Date(activity.timestamp).toLocaleTimeString()}
                              </div>
                            </motion.div>
                          );
                        })
                      ) : (
                        <p className="text-center text-gray-400 font-exo py-8">No recent activity</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Bulk Actions Panel */}
                <div className="space-y-4">
                  <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                    <h2 className="font-orbitron text-xl font-bold flex items-center gap-2 mb-4">
                      <Zap className="w-5 h-5 text-cyber-blue" />
                      Bulk Actions
                    </h2>
                    <div className="space-y-3">
                      <div className="p-3 bg-white/5 rounded-lg">
                        <p className="text-xs font-exo text-gray-400 mb-2">Selected Users</p>
                        <p className="font-orbitron text-2xl font-bold text-white">{selectedUsers.length}</p>
                      </div>
                      <div className="p-3 bg-white/5 rounded-lg">
                        <p className="text-xs font-exo text-gray-400 mb-2">Selected Posts</p>
                        <p className="font-orbitron text-2xl font-bold text-white">{selectedPosts.length}</p>
                      </div>
                      <motion.button
                        onClick={handleBulkBanUsers}
                        disabled={selectedUsers.length === 0}
                        whileHover={{ scale: selectedUsers.length > 0 ? 1.02 : 1 }}
                        whileTap={{ scale: selectedUsers.length > 0 ? 0.98 : 1 }}
                        className="w-full p-3 bg-red-500/20 border border-red-500/50 rounded-lg hover:bg-red-500/30 transition-all font-exo text-sm font-bold uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                        <Ban className="w-4 h-4" />
                        Bulk Ban Users
                      </motion.button>
                      <motion.button
                        onClick={handleBulkDeletePosts}
                        disabled={selectedPosts.length === 0}
                        whileHover={{ scale: selectedPosts.length > 0 ? 1.02 : 1 }}
                        whileTap={{ scale: selectedPosts.length > 0 ? 0.98 : 1 }}
                        className="w-full p-3 bg-red-500/20 border border-red-500/50 rounded-lg hover:bg-red-500/30 transition-all font-exo text-sm font-bold uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                        <Trash2 className="w-4 h-4" />
                        Bulk Delete Posts
                      </motion.button>
                      <motion.button
                        onClick={() => {
                          setSelectedUsers([]);
                          setSelectedPosts([]);
                        }}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        className="w-full p-3 border border-white/20 rounded-lg hover:border-cyber-blue/50 transition-all font-exo text-sm font-bold uppercase tracking-wider flex items-center justify-center gap-2"
                      >
                        <XCircle className="w-4 h-4" />
                        Clear Selection
                      </motion.button>
                    </div>
                  </div>

                  {/* System Health */}
                  <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="font-orbitron text-xl font-bold flex items-center gap-2">
                        <Activity className="w-5 h-5 text-cyber-blue" />
                        System Health
                      </h2>
                      <button
                        onClick={fetchSystemHealth}
                        className="p-1.5 border border-cyber-blue/50 rounded hover:bg-cyber-blue/10 transition-all"
                        title="Refresh Health"
                      >
                        <RefreshCw className="w-4 h-4 text-cyber-blue" />
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                        <span className="text-xs font-exo text-gray-400">Uptime</span>
                        <span className="font-orbitron text-sm font-bold text-green-400">{systemHealth.uptime}%</span>
                      </div>
                      <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                        <span className="text-xs font-exo text-gray-400">DB Size</span>
                        <span className="font-orbitron text-sm font-bold text-white">{systemHealth.dbSize} MB</span>
                      </div>
                      <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                        <span className="text-xs font-exo text-gray-400">Avg Response</span>
                        <span className="font-orbitron text-sm font-bold text-white">{systemHealth.avgResponseTime}ms</span>
                      </div>
                      <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                        <span className="text-xs font-exo text-gray-400">Active Connections</span>
                        <span className="font-orbitron text-sm font-bold text-cyber-cyan">{systemHealth.activeConnections}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'users' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                <h2 className="font-orbitron text-xl sm:text-2xl font-bold mb-4 sm:mb-6">User Management</h2>
                <div className="flex items-center gap-4 mb-4 sm:mb-6">
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
                <div className="flex items-center gap-3 mb-4">
                  {selectedUsers.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-exo text-gray-400">{selectedUsers.length} selected</span>
                      <button
                        onClick={handleBulkBanUsers}
                        className="px-3 py-1.5 text-xs font-exo font-bold uppercase bg-red-500/20 border border-red-500/50 rounded hover:bg-red-500/30 transition-all"
                      >
                        Bulk Ban
                      </button>
                      <button
                        onClick={() => setSelectedUsers([])}
                        className="px-3 py-1.5 text-xs font-exo font-bold uppercase border border-white/20 rounded hover:border-cyber-blue/50 transition-all"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                  {filteredUsers.length > 0 ? (
                    filteredUsers.map((user) => (
                      <div key={user.id} className="p-4 bg-white/5 border border-white/10 rounded-lg relative">
                        <input
                          type="checkbox"
                          checked={selectedUsers.includes(user.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedUsers(prev => [...prev, user.id]);
                            } else {
                              setSelectedUsers(prev => prev.filter(id => id !== user.id));
                            }
                          }}
                          className="absolute top-3 right-3 w-4 h-4 rounded border-2 border-cyber-blue/50 bg-cyber-black checked:bg-cyber-blue cursor-pointer"
                        />
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-cyber-blue to-cyber-cyan flex items-center justify-center">
                            <span className="font-orbitron text-xl font-bold">
                              {user.username?.[0]?.toUpperCase() || 'U'}
                            </span>
                          </div>
                          <div className="flex-1">
                            <p className="font-exo font-bold text-white">{user.username}</p>
                            <p className="text-xs font-exo text-gray-400">ID: {user.id.slice(0, 8)}</p>
                            {user.is_admin && (
                              <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 text-[10px] font-exo uppercase tracking-wider bg-green-500/20 border border-green-500/40 rounded-full text-green-300">
                                Admin
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-exo text-gray-400">Reputation</span>
                            <button
                              onClick={() => {
                                setReputationUser(user);
                                setReputationValue(user.reputation || 0);
                                setShowReputationModal(true);
                              }}
                              className="flex items-center gap-1 font-orbitron font-bold text-cyber-blue hover:text-cyber-cyan transition-colors"
                            >
                              <Star className="w-3 h-3" />
                              {user.reputation || 0}
                            </button>
                          </div>
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-exo text-gray-400">Joined</span>
                            <span className="font-exo text-gray-300">
                              {new Date(user.created_at).toLocaleDateString()}
                            </span>
                          </div>
                          <button
                            onClick={() => handleBanUser(user.id, user.username)}
                            className="w-full mt-3 px-3 py-1.5 text-xs font-exo font-bold uppercase tracking-wider bg-red-500/20 border border-red-500/50 rounded hover:bg-red-500/30 transition-all flex items-center justify-center gap-2"
                          >
                            <Ban className="w-3 h-3" />
                            Ban User
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="col-span-full text-center text-gray-400 font-exo py-8">
                      No users match your search.
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'analytics' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <h2 className="font-orbitron text-xl sm:text-2xl font-bold mb-4 sm:mb-6 flex items-center gap-2 sm:gap-3">
                    <Tag className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
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

                <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <h2 className="font-orbitron text-xl sm:text-2xl font-bold mb-4 sm:mb-6 flex items-center gap-2 sm:gap-3">
                    <Users className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
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

                <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm lg:col-span-2">
                  <h2 className="font-orbitron text-xl sm:text-2xl font-bold mb-4 sm:mb-6 flex items-center gap-2 sm:gap-3">
                    <Activity className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
                    Event Activity
                  </h2>
                  <div className="space-y-3">
                    {Object.keys(analytics.eventStats).length > 0 ? (
                      Object.entries(analytics.eventStats).map(([eventType, count]) => (
                        <div
                          key={eventType}
                          className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/10"
                        >
                          <span className="font-exo text-gray-300 capitalize">
                            {eventType.replace(/_/g, ' ')}
                          </span>
                          <span className="font-orbitron text-lg font-bold text-cyber-cyan">
                            {count}
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="text-center text-gray-400 font-exo py-6">
                        No analytics events recorded yet.
                      </p>
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
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <h2 className="font-orbitron text-xl sm:text-2xl font-bold mb-4 sm:mb-6 flex items-center gap-2 sm:gap-3">
                    <Database className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
                    Database Management
                  </h2>
                  <p className="font-exo text-sm text-gray-400 mb-4 sm:mb-6">Manage database operations and maintenance</p>
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

                <div className="p-4 sm:p-6 bg-white/5 border border-white/10 rounded-xl backdrop-blur-sm">
                  <h2 className="font-orbitron text-xl sm:text-2xl font-bold mb-4 sm:mb-6 flex items-center gap-2 sm:gap-3">
                    <Shield className="w-5 h-5 sm:w-6 sm:h-6 text-cyber-blue" />
                    Security Settings
                  </h2>
                  <p className="font-exo text-sm text-gray-400 mb-4 sm:mb-6">Configure security policies and access controls</p>
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

      {/* Reputation Modal */}
      {showReputationModal && reputationUser && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
          onClick={() => setShowReputationModal(false)}
        >
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="relative w-full max-w-md bg-cyber-darker/95 border border-cyber-blue/30 rounded-lg p-6 shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-orbitron text-lg text-white tracking-wider">Update Reputation</h3>
              <button
                type="button"
                onClick={() => setShowReputationModal(false)}
                className="text-gray-400 hover:text-white transition-colors text-sm font-exo"
              >
                Close
              </button>
            </div>

            <div className="mb-4">
              <p className="font-exo text-sm text-gray-400 mb-2">User: <span className="text-white font-bold">{reputationUser.username}</span></p>
              <p className="font-exo text-sm text-gray-400">Current Reputation: <span className="text-cyber-cyan font-bold">{reputationUser.reputation || 0}</span></p>
            </div>

            <div className="mb-6">
              <label className="block font-exo text-xs uppercase tracking-wider text-gray-400 mb-2">
                New Reputation Value
              </label>
              <input
                type="number"
                value={reputationValue}
                onChange={(e) => setReputationValue(parseInt(e.target.value) || 0)}
                className="w-full bg-cyber-black/60 border border-cyber-blue/30 rounded-md px-3 py-2 text-sm text-white outline-none focus:border-cyber-cyan transition-colors"
                placeholder="Enter reputation value"
              />
            </div>

            <motion.button
              onClick={handleUpdateReputation}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.96 }}
              className="w-full py-2.5 font-orbitron text-sm tracking-widest rounded-md bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker shadow-lg shadow-cyber-blue/30"
            >
              Update Reputation
            </motion.button>
          </motion.div>
        </motion.div>
      )}
    </div>
  );
};

export default AdminDashboard;

