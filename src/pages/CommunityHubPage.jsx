import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '../supabaseClient';
import { useAuth } from '../contexts/AuthContext';
import PostCard from '../components/community/PostCard';
import PostForm from '../components/community/PostForm';
import { Plus, MessageSquare, Wrench, BrainCircuit, Rocket, Filter, Search, Ban, Loader } from 'lucide-react';
import toast from 'react-hot-toast';

const CommunityHubPage = () => {
  const { profile } = useAuth();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isPostModalOpen, setIsPostModalOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const [filter, setFilter] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [checkingBan, setCheckingBan] = useState(true);
  const [isBanned, setIsBanned] = useState(false);
  const [banInfo, setBanInfo] = useState(null);

  const tabs = [
    { name: 'All', icon: Filter },
    { name: 'Tools Showcase', icon: Wrench, category: 'tool' },
    { name: 'Discussions', icon: MessageSquare, category: 'discussion' },
    { name: 'Research', icon: BrainCircuit, category: 'research' },
    { name: 'Projects', icon: Rocket, category: 'project' },
  ];

  const fetchPosts = async () => {
    setLoading(true);
    let query = supabase
      .from('posts')
      .select(`
        *,
        profiles:posts_user_id_fkey (
          username
        ),
        upvotes:upvotes(count)
      `)
      .order('created_at', { ascending: false });

    if (filter !== 'All') {
      const selectedTab = tabs.find(t => t.name === filter);
      if (selectedTab) {
        query = query.eq('category', selectedTab.category);
      }
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching posts:', error);
      toast.error('Could not fetch posts.');
    } else {
      // Process upvote counts
      const postsWithUpvotes = data.map(post => ({
        ...post,
        upvotes: post.upvotes?.[0]?.count || 0
      }));
      setPosts(postsWithUpvotes);
    }
    setLoading(false);
  };

  useEffect(() => {
    const checkBanStatus = async () => {
      if (!profile?.id) {
        setIsBanned(false);
        setBanInfo(null);
        setCheckingBan(false);
        return;
      }

      setCheckingBan(true);

      try {
        const { data, error } = await supabase
          .from('banned_users')
          .select('reason, banned_at, admin_profiles:admin_id(username)')
          .eq('user_id', profile.id)
          .eq('is_active', true)
          .maybeSingle();

        if (error) {
          // maybeSingle only throws when more than one row matches
          if (error.code !== 'PGRST116') {
            throw error;
          }
        }

        if (data) {
          setIsBanned(true);
          setBanInfo(data);
        } else {
          setIsBanned(false);
          setBanInfo(null);
        }
      } catch (error) {
        console.error('Error checking ban status:', error);
        toast.error('Unable to verify your hub access. Please try again.');
        setIsBanned(false);
        setBanInfo(null);
      } finally {
        setCheckingBan(false);
      }
    };

    checkBanStatus();
  }, [profile?.id]);

  useEffect(() => {
    if (checkingBan) return;

    if (isBanned) {
      setPosts([]);
      setLoading(false);
      return;
    }

    fetchPosts();
  }, [filter, checkingBan, isBanned]);

  const handlePostCreated = () => {
    fetchPosts();
    setIsPostModalOpen(false);
    setEditingPost(null);
  };

  const handleEditPost = (post) => {
    setEditingPost(post);
    setIsPostModalOpen(true);
  };

  const filteredPosts = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return posts;
    return posts.filter((post) => {
      const tags = Array.isArray(post.tags) ? post.tags.join(' ') : '';
      const haystack = [
        post.title,
        post.content,
        tags,
        post.profiles?.username,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [posts, searchTerm]);

  if (checkingBan) {
    return (
      <div className="min-h-screen pt-24 pb-12 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-gray-400">
          <Loader className="w-10 h-10 animate-spin text-cyber-blue" />
          <p className="font-exo text-sm uppercase tracking-[0.3em]">AUTHORIZING ACCESS…</p>
        </div>
      </div>
    );
  }

  if (isBanned) {
    return (
      <div className="min-h-screen pt-24 pb-12 flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-xl w-full cyber-card text-center space-y-6"
        >
          <div className="flex justify-center">
            <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/40 flex items-center justify-center">
              <Ban className="w-10 h-10 text-red-400" />
            </div>
          </div>
          <div className="space-y-3">
            <h1 className="font-orbitron text-3xl text-white tracking-wide">Access Restricted</h1>
            <p className="font-exo text-gray-400 leading-relaxed">
              Your account is currently banned from the Community Hub. You won’t be able to view or
              interact with content until an administrator lifts the ban.
            </p>
          </div>
          {banInfo?.reason && (
            <div className="bg-red-500/5 border border-red-500/30 rounded-lg p-4 text-left">
              <p className="font-exo text-sm text-red-300 uppercase tracking-[0.2em] mb-1">Reason</p>
              <p className="font-exo text-gray-300">{banInfo.reason}</p>
            </div>
          )}
          <div className="space-y-2 font-exo text-sm text-gray-500">
            {banInfo?.banned_at && (
              <p>
                Banned on{' '}
                <span className="text-gray-300">
                  {new Date(banInfo.banned_at).toLocaleString()}
                </span>
              </p>
            )}
            {banInfo?.admin_profiles?.username && (
              <p>
                Issued by{' '}
                <span className="text-gray-300">{banInfo.admin_profiles.username}</span>
              </p>
            )}
          </div>
          <div className="pt-2">
            <a
              href="mailto:team@projectclawnet.online"
              className="inline-flex items-center gap-2 px-5 py-3 bg-cyber-blue/20 border border-cyber-blue/40 rounded-md text-cyber-cyan font-orbitron text-sm tracking-widest hover:bg-cyber-blue/30 transition-colors"
            >
              Contact Support
            </a>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-24 pb-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12"
        >
          <div>
            <h1 className="section-title mb-2">The Grid</h1>
            <p className="font-exo text-lg text-gray-400">Welcome, <span className="font-bold text-cyber-cyan">{profile?.username}</span>. Where innovation meets intelligence.</p>
          </div>
          <motion.button
            onClick={() => setIsPostModalOpen(true)}
            whileHover={{ scale: 1.05, boxShadow: '0 0 25px rgba(0, 224, 255, 0.5)' }}
            whileTap={{ scale: 0.95 }}
            className="mt-4 md:mt-0 w-full md:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker font-orbitron font-bold rounded-md transition-shadow duration-300 text-sm md:text-base"
          >
            <Plus size={18} className="md:w-5 md:h-5" />
            <span className="hidden sm:inline">Post a Tool or Idea</span>
            <span className="sm:hidden">New Post</span>
          </motion.button>
        </motion.div>

        <div className="mb-8 space-y-4">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-cyber-blue w-4 h-4" />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search posts, tags, or authors..."
              className="w-full bg-cyber-gray/30 border border-cyber-blue/20 rounded-md py-3 pl-10 pr-4 font-exo text-sm text-gray-200 placeholder-gray-500 outline-none focus:border-cyber-cyan transition-colors"
            />
          </div>
          <div className="bg-cyber-gray/20 backdrop-blur-sm border border-cyber-blue/10 rounded-lg p-2 overflow-x-auto scrollbar-hide">
            <div className="flex gap-2 min-w-max md:inline-flex">
              {tabs.map(tab => (
                <motion.button
                  key={tab.name}
                  onClick={() => setFilter(tab.name)}
                  className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-md font-orbitron text-xs md:text-sm font-semibold whitespace-nowrap transition-all ${
                    filter === tab.name
                      ? 'bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker shadow-lg shadow-cyber-blue/30'
                      : 'text-gray-400'
                  }`}
                >
                  <tab.icon size={16} className="md:w-[18px] md:h-[18px]" />
                  <span className="hidden sm:inline">{tab.name}</span>
                  <span className="sm:hidden">
                    {tab.name === 'Tools Showcase' ? 'Tools' : 
                     tab.name === 'All' ? 'All' : 
                     tab.name.split(' ')[0]}
                  </span>
                </motion.button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-16">
            <motion.div
              className="inline-block w-12 h-12 border-4 border-cyber-blue border-t-transparent rounded-full"
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            />
            <p className="mt-4 font-exo text-gray-400">Loading The Grid...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
            {filteredPosts.length > 0 ? (
              filteredPosts.map((post, index) => (
                <motion.div
                  key={post.id}
                  initial={{ opacity: 0, y: 30, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ 
                    duration: 0.5, 
                    delay: index * 0.08,
                    ease: [0.4, 0, 0.2, 1]
                  }}
                >
                  <PostCard 
                    post={post} 
                    onEdit={handleEditPost}
                    onRefresh={fetchPosts}
                  />
                </motion.div>
              ))
            ) : (
              <div className="col-span-2 text-center py-16 cyber-card">
                <h3 className="font-orbitron text-2xl text-gray-400 mb-2">
                  {searchTerm.trim() ? 'No posts match your search.' : 'No posts found in this category.'}
                </h3>
                <p className="font-exo text-gray-500">
                  {searchTerm.trim() ? 'Try different keywords or clear the search box.' : 'Be the first to contribute!'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      <AnimatePresence>
        {isPostModalOpen && (
          <PostForm
            onClose={() => {
              setIsPostModalOpen(false);
              setEditingPost(null);
            }}
            onPostCreated={handlePostCreated}
            editPost={editingPost}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default CommunityHubPage;
