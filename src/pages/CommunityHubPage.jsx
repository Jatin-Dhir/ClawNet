import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../contexts/AuthContext';
import PostCard from '../components/community/PostCard';
import PostForm from '../components/community/PostForm';
import { Plus, MessageSquare, Wrench, BrainCircuit, Rocket, Filter } from 'lucide-react';
import toast from 'react-hot-toast';

const CommunityHubPage = () => {
  const { profile } = useAuth();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isPostModalOpen, setIsPostModalOpen] = useState(false);
  const [editingPost, setEditingPost] = useState(null);
  const [filter, setFilter] = useState('All');

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
        )
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
      setPosts(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchPosts();
  }, [filter]);

  const handlePostCreated = () => {
    fetchPosts();
    setIsPostModalOpen(false);
    setEditingPost(null);
  };

  const handleEditPost = (post) => {
    setEditingPost(post);
    setIsPostModalOpen(true);
  };

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
            className="mt-4 md:mt-0 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker font-orbitron font-bold rounded-md transition-shadow duration-300"
          >
            <Plus size={20} />
            Post a Tool or Idea
          </motion.button>
        </motion.div>

        <div className="mb-8">
          <div className="bg-cyber-gray/20 backdrop-blur-sm border border-cyber-blue/10 rounded-lg p-2 inline-flex gap-2">
            {tabs.map(tab => (
              <motion.button
                key={tab.name}
                onClick={() => setFilter(tab.name)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-md font-orbitron text-sm font-semibold whitespace-nowrap transition-all ${
                  filter === tab.name
                    ? 'bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker shadow-lg shadow-cyber-blue/30'
                    : 'text-gray-400 hover:text-white hover:bg-cyber-gray/30'
                }`}
              >
                <tab.icon size={18} />
                {tab.name}
              </motion.button>
            ))}
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
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {posts.length > 0 ? (
              posts.map((post, index) => (
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
                <h3 className="font-orbitron text-2xl text-gray-400 mb-2">No posts found in this category.</h3>
                <p className="font-exo text-gray-500">Be the first to contribute!</p>
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
