import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Tag, Link as LinkIcon, MessageSquare, ArrowUp, Edit2, Trash2, Code } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../supabaseClient';
import toast from 'react-hot-toast';

const PostCard = ({ post, onEdit, onRefresh }) => {
  const { session } = useAuth();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const isOwner = session?.user && post.user_id === session.user.id;
  const categoryColors = {
    tool: 'border-cyber-blue text-cyber-blue',
    discussion: 'border-cyber-purple text-cyber-purple',
    research: 'border-cyber-cyan text-cyber-cyan',
    project: 'border-pink-500 text-pink-500',
  };

  const categoryText = {
    tool: 'Tool Showcase',
    discussion: 'Discussion',
    research: 'Research',
    project: 'Project',
  };

  const timeAgo = (date) => {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + " years ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + " months ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + " days ago";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + " hours ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + " minutes ago";
    return Math.floor(seconds) + " seconds ago";
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this post?')) return;
    
    setIsDeleting(true);
    const { error } = await supabase.from('posts').delete().eq('id', post.id);
    
    setIsDeleting(false);
    if (error) {
      toast.error('Failed to delete post');
    } else {
      toast.success('Post deleted successfully');
      if (onRefresh) onRefresh();
    }
  };

  const handleEdit = () => {
    if (onEdit) onEdit(post);
  };

  return (
    <motion.div
      whileHover={{ y: -5, boxShadow: '0 0 20px rgba(0, 224, 255, 0.1)' }}
      className="cyber-card p-4 md:p-6 flex flex-col md:flex-row gap-4 md:gap-6"
    >
      <div className="flex-shrink-0 flex flex-row md:flex-col items-center justify-between md:justify-start gap-3 md:gap-2 w-full md:w-20">
        <button className="w-10 h-10 md:w-12 md:h-12 flex flex-col items-center justify-center rounded-lg bg-cyber-gray/50 hover:bg-cyber-blue/20 transition-colors touch-manipulation">
          <ArrowUp className="text-cyber-blue" size={18} />
          <span className="font-orbitron text-xs text-white">{post.upvotes || 0}</span>
        </button>
        <div className="flex flex-row md:flex-col items-center gap-2">
            <MessageSquare size={16} className="text-gray-500 md:w-[18px] md:h-[18px]" />
            <span className="font-orbitron text-xs text-gray-400">{post.comment_count || 0}</span>
        </div>
      </div>
      <div className="flex-grow min-w-0">
        <div className="flex flex-wrap items-center gap-2 md:gap-4 mb-3">
          <div className={`border px-2 py-0.5 rounded-full text-xs font-orbitron ${categoryColors[post.category] || 'border-gray-500 text-gray-500'}`}>
            {categoryText[post.category] || post.category}
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <User size={14} />
            <span>{post.profiles?.username || 'Anonymous'}</span>
          </div>
          <span className="text-xs text-gray-500">{timeAgo(post.created_at)}</span>
          {isOwner && (
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={handleEdit}
                className="p-2 md:p-1.5 text-cyber-blue hover:text-cyber-cyan hover:bg-cyber-blue/10 rounded transition-colors touch-manipulation"
                title="Edit post"
              >
                <Edit2 size={18} className="md:w-4 md:h-4" />
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="p-2 md:p-1.5 text-red-400 hover:text-red-500 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50 touch-manipulation"
                title="Delete post"
              >
                <Trash2 size={18} className="md:w-4 md:h-4" />
              </button>
            </div>
          )}
        </div>
        <h3 className="font-orbitron text-xl md:text-2xl font-bold text-white mb-2 md:mb-3 break-words">{post.title}</h3>
        <p className="font-exo text-sm md:text-base text-gray-300 mb-4 whitespace-pre-wrap break-words">{post.content}</p>
        
        {post.code_snippet && (
          <div className="mb-4">
            <button
              onClick={() => setShowCode(!showCode)}
              className="flex items-center gap-2 text-cyber-cyan hover:text-cyber-blue transition-colors mb-2"
            >
              <Code size={16} />
              <span className="text-sm font-exo font-semibold">{showCode ? 'Hide' : 'Show'} Code Snippet</span>
            </button>
            {showCode && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <pre className="bg-cyber-black border border-cyber-blue/30 rounded-md p-4 text-green-400 font-mono text-sm overflow-x-auto">
                  <code>{post.code_snippet}</code>
                </pre>
              </motion.div>
            )}
          </div>
        )}
        
        <div className="flex flex-wrap items-center gap-4">
          {post.link && (
            <a
              href={post.link}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-cyber-cyan hover:text-white text-sm font-semibold transition-colors group"
            >
              <LinkIcon size={16} />
              <span>View Link / Source</span>
              <span className="w-0 h-0.5 bg-cyber-cyan group-hover:w-full transition-all duration-300" />
            </a>
          )}
          {post.tags && post.tags.length > 0 && (
            <div className="flex items-center gap-2">
              <Tag size={16} className="text-gray-500" />
              {post.tags.map(tag => (
                <span key={tag} className="text-xs bg-cyber-gray px-2 py-1 rounded-md text-gray-400">#{tag}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default PostCard;
