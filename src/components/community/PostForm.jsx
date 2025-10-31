import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Loader, Send } from 'lucide-react';
import { supabase } from '../../supabaseClient';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';

const PostForm = ({ onClose, onPostCreated, editPost = null }) => {
  const { session } = useAuth();
  const user = session?.user;
  const [title, setTitle] = useState(editPost?.title || '');
  const [content, setContent] = useState(editPost?.content || '');
  const [link, setLink] = useState(editPost?.link || '');
  const [category, setCategory] = useState(editPost?.category || 'discussion');
  const [tags, setTags] = useState(editPost?.tags?.join(', ') || '');
  const [codeSnippet, setCodeSnippet] = useState(editPost?.code_snippet || '');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!user && !editPost) {
      toast.error('You must be logged in to create a post');
      return;
    }
    setLoading(true);

    const postData = {
      title,
      content,
      link: link || null,
      category,
      tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag),
      code_snippet: codeSnippet || null,
      ...(editPost ? {} : { user_id: user.id }),
    };

    let error;
    if (editPost) {
      const result = await supabase.from('posts').update(postData).eq('id', editPost.id);
      error = result.error;
    } else {
      const result = await supabase.from('posts').insert([postData]);
      error = result.error;
    }

    setLoading(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(editPost ? 'Post updated successfully!' : 'Post created successfully!');
      onPostCreated();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-cyber-black/80 backdrop-blur-md flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 50 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 50 }}
        className="relative cyber-card w-full max-w-2xl p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-cyber-blue transition-colors">
          <X size={24} />
        </button>

        <h2 className="font-orbitron text-3xl font-bold text-center text-white mb-6">
          {editPost ? 'Edit Post' : 'Create a New Post'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-6">
          <input
            type="text"
            placeholder="Post Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
            required
          />
          <textarea
            placeholder="Share your idea, tool, or discussion topic..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all h-32 resize-none"
            required
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <input
              type="url"
              placeholder="Link (e.g., GitHub, Website)"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
            >
              <option value="discussion">Discussion</option>
              <option value="tool">Tool Showcase</option>
              <option value="research">Research</option>
              <option value="project">Project</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-exo text-gray-400 mb-2">Code Snippet (Optional)</label>
            <textarea
              placeholder="Paste your code here (supports GitHub gists, code blocks, etc.)"
              value={codeSnippet}
              onChange={(e) => setCodeSnippet(e.target.value)}
              className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all h-40 resize-none font-mono text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">You can paste code, GitHub links, or code snippets here</p>
          </div>
          <input
            type="text"
            placeholder="Tags (comma-separated, e.g., AI, NetworkDefense)"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
          />

          <motion.button
            type="submit"
            disabled={loading}
            whileHover={{ scale: 1.03, boxShadow: '0 0 25px rgba(0, 224, 255, 0.5)' }}
            whileTap={{ scale: 0.98 }}
            className="w-full flex items-center justify-center gap-2 px-8 py-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-darker font-orbitron font-bold rounded-md transition-shadow duration-300 disabled:opacity-50"
          >
            {loading ? <Loader className="animate-spin" size={20} /> : <><Send size={18} /> {editPost ? 'Update Post' : 'Post to The Grid'}</>}
          </motion.button>
        </form>
      </motion.div>
    </motion.div>
  );
};

export default PostForm;
