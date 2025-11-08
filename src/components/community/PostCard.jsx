import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Tag, Link as LinkIcon, MessageSquare, ArrowUp, Edit2, Trash2, Code, Flag } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../supabaseClient';
import toast from 'react-hot-toast';

const PostCard = ({ post, onEdit, onRefresh }) => {
  const { session } = useAuth();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [upvotes, setUpvotes] = useState(post.upvotes || 0);
  const [hasUpvoted, setHasUpvoted] = useState(false);
  const [isUpvoting, setIsUpvoting] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [commentCount, setCommentCount] = useState(post.comment_count || 0);
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

  const handleReport = async () => {
    if (!session) {
      toast.error('Please sign in to report content');
      return;
    }

    const reason = prompt('Why are you reporting this post?');
    if (!reason) return;

    const toastId = toast.loading('Submitting report...');
    try {
      const { error } = await supabase
        .from('flagged_content')
        .insert({
          content_type: 'post',
          content_id: post.id,
          reporter_id: session.user.id,
          reason: reason.trim()
        });

      if (error) throw error;

      toast.success('Report submitted. Admins will review it.', { id: toastId });
    } catch (error) {
      console.error('Error reporting post:', error);
      toast.error('Failed to submit report', { id: toastId });
    }
  };

  const handleUpvote = async () => {
    if (!session) {
      toast.error('Please sign in to upvote');
      return;
    }

    if (isUpvoting) return;

    setIsUpvoting(true);
    try {
      if (hasUpvoted) {
        // Remove upvote
        const { error } = await supabase
          .from('upvotes')
          .delete()
          .eq('post_id', post.id)
          .eq('user_id', session.user.id);

        if (error) throw error;

        setUpvotes(prev => prev - 1);
        setHasUpvoted(false);
        toast.success('Upvote removed');
      } else {
        // Add upvote
        const { error } = await supabase
          .from('upvotes')
          .insert({ post_id: post.id, user_id: session.user.id });

        if (error) throw error;

        setUpvotes(prev => prev + 1);
        setHasUpvoted(true);
        toast.success('Post upvoted!');
      }
    } catch (error) {
      console.error('Error toggling upvote:', error);
      toast.error('Failed to upvote');
    } finally {
      setIsUpvoting(false);
    }
  };

  // Check if user has upvoted on mount
  React.useEffect(() => {
    const checkUpvote = async () => {
      if (!session) return;

      const { data, error } = await supabase
        .from('upvotes')
        .select('*')
        .eq('post_id', post.id)
        .eq('user_id', session.user.id)
        .single();

      if (!error && data) {
        setHasUpvoted(true);
      }
    };

    checkUpvote();
  }, [session, post.id]);

  // Fetch comments when showComments is toggled
  React.useEffect(() => {
    const fetchComments = async () => {
      if (!showComments) return;

      const { data, error } = await supabase
        .from('comments')
        .select('*, profiles(username)')
        .eq('post_id', post.id)
        .order('created_at', { ascending: false });

      if (!error) {
        setComments(data || []);
      }
    };

    fetchComments();
  }, [showComments, post.id]);

  const handleSubmitComment = async (e) => {
    e.preventDefault();
    if (!session) {
      toast.error('Please sign in to comment');
      return;
    }

    if (!newComment.trim()) {
      toast.error('Comment cannot be empty');
      return;
    }

    setIsSubmittingComment(true);
    try {
      const { data, error } = await supabase
        .from('comments')
        .insert({
          post_id: post.id,
          user_id: session.user.id,
          content: newComment.trim()
        })
        .select('*, profiles(username)')
        .single();

      if (error) throw error;

      setComments(prev => [data, ...prev]);
      setCommentCount(prev => prev + 1);
      setNewComment('');
      toast.success('Comment posted!');
    } catch (error) {
      console.error('Error posting comment:', error);
      toast.error('Failed to post comment');
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const handleDeleteComment = async (commentId) => {
    if (!confirm('Delete this comment?')) return;

    try {
      const { error } = await supabase
        .from('comments')
        .delete()
        .eq('id', commentId);

      if (error) throw error;

      setComments(prev => prev.filter(c => c.id !== commentId));
      setCommentCount(prev => prev - 1);
      toast.success('Comment deleted');
    } catch (error) {
      console.error('Error deleting comment:', error);
      toast.error('Failed to delete comment');
    }
  };

  return (
    <motion.div
      whileHover={{ y: -5, boxShadow: '0 0 20px rgba(0, 224, 255, 0.1)' }}
      className="cyber-card p-4 md:p-6 flex flex-col md:flex-row gap-4 md:gap-6"
    >
      <div className="flex-shrink-0 flex flex-row md:flex-col items-center justify-between md:justify-start gap-3 md:gap-2 w-full md:w-20">
        <button 
          onClick={handleUpvote}
          disabled={isUpvoting}
          className={`w-10 h-10 md:w-12 md:h-12 flex flex-col items-center justify-center rounded-lg transition-colors touch-manipulation ${
            hasUpvoted 
              ? 'bg-cyber-blue/30 border border-cyber-blue/50' 
              : 'bg-cyber-gray/50 hover:bg-cyber-blue/20'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <ArrowUp className={hasUpvoted ? 'text-cyber-cyan' : 'text-cyber-blue'} size={18} />
          <span className="font-orbitron text-xs text-white">{upvotes}</span>
        </button>
        <button
          onClick={() => setShowComments(!showComments)}
          className="flex flex-row md:flex-col items-center gap-2 w-10 h-10 md:w-12 md:h-12 rounded-lg bg-cyber-gray/50 hover:bg-cyber-purple/20 transition-colors touch-manipulation"
        >
          <MessageSquare size={16} className={`${showComments ? 'text-cyber-purple' : 'text-gray-500'} md:w-[18px] md:h-[18px]`} />
          <span className="font-orbitron text-xs text-gray-400">{commentCount}</span>
        </button>
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
          {!isOwner && session && (
            <button
              onClick={handleReport}
              className="flex items-center gap-1 text-gray-500 hover:text-orange-400 text-xs font-exo transition-colors ml-auto"
              title="Report this post"
            >
              <Flag size={14} />
              <span>Report</span>
            </button>
          )}
        </div>

        {/* Comments Section */}
        <AnimatePresence>
          {showComments && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-4 pt-4 border-t border-cyber-blue/20"
            >
            {/* Comment Form */}
            {session && (
              <form onSubmit={handleSubmitComment} className="mb-4">
                <textarea
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Add a comment..."
                  rows={3}
                  className="w-full px-3 py-2 bg-cyber-black/60 border border-cyber-blue/30 rounded-md text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyber-cyan resize-none"
                />
                <div className="flex justify-end mt-2">
                  <motion.button
                    type="submit"
                    disabled={isSubmittingComment || !newComment.trim()}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="px-4 py-2 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker font-exo font-bold text-sm rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmittingComment ? 'Posting...' : 'Post Comment'}
                  </motion.button>
                </div>
              </form>
            )}

            {/* Comments List */}
            <div className="space-y-3">
              {comments.length > 0 ? (
                comments.map((comment) => (
                  <div key={comment.id} className="p-3 bg-cyber-black/40 border border-cyber-blue/10 rounded-md">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <User size={14} className="text-cyber-blue" />
                        <span className="font-exo text-sm font-bold text-white">{comment.profiles?.username || 'Unknown'}</span>
                        <span className="text-xs text-gray-500">
                          {new Date(comment.created_at).toLocaleString()}
                        </span>
                      </div>
                      {session?.user?.id === comment.user_id && (
                        <button
                          onClick={() => handleDeleteComment(comment.id)}
                          className="text-red-400 hover:text-red-500 transition-colors"
                          title="Delete comment"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    <p className="font-exo text-sm text-gray-300 whitespace-pre-wrap">{comment.content}</p>
                  </div>
                ))
              ) : (
                <p className="text-center text-gray-500 font-exo text-sm py-4">No comments yet. Be the first!</p>
              )}
            </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
};

export default PostCard;
