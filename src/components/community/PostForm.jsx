import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Loader, Send } from 'lucide-react';
import { supabase } from '../../supabaseClient';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';
import { sanitizeInput, validateURL } from '../../utils/security';

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

    // Sanitize and validate inputs
    const sanitizedTitle = sanitizeInput(title).slice(0, 200); // Max 200 chars
    const sanitizedContent = sanitizeInput(content).slice(0, 10000); // Max 10k chars
    const sanitizedCodeSnippet = codeSnippet ? sanitizeInput(codeSnippet).slice(0, 50000) : null; // Max 50k chars for code

    // Validate title length
    if (!sanitizedTitle || sanitizedTitle.length < 3) {
      toast.error('Title must be at least 3 characters long.');
      setLoading(false);
      return;
    }

    // Validate content length
    if (!sanitizedContent || sanitizedContent.length < 10) {
      toast.error('Content must be at least 10 characters long.');
      setLoading(false);
      return;
    }

    // Validate category
    const validCategories = ['discussion', 'tool', 'research', 'project'];
    if (!validCategories.includes(category)) {
      toast.error('Invalid category selected.');
      setLoading(false);
      return;
    }

    // Validate and sanitize URL if provided
    let validatedLink = null;
    if (link) {
      const urlValidation = validateURL(link);
      if (!urlValidation.valid) {
        toast.error(urlValidation.error || 'Invalid URL format.');
        setLoading(false);
        return;
      }
      validatedLink = urlValidation.sanitized;
    }

    // Sanitize tags
    const sanitizedTags = tags
      .split(',')
      .map(tag => sanitizeInput(tag.trim()))
      .filter(tag => tag.length > 0 && tag.length <= 50)
      .slice(0, 10); // Max 10 tags

    const postData = {
      title: sanitizedTitle,
      content: sanitizedContent,
      link: validatedLink,
      category,
      tags: sanitizedTags,
      code_snippet: sanitizedCodeSnippet,
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
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 backdrop-blur-sm p-4 sm:items-center"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 24 }}
        transition={{ duration: 0.16 }}
        className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-[#04070f]/95 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute inset-0 pointer-events-none rounded-2xl border border-white/5" />
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-full border border-white/10 bg-white/5 p-2 text-gray-300 transition-colors hover:border-cyber-blue/60 hover:text-white"
          aria-label="Close create post"
        >
          <X size={18} />
        </button>

        <header className="mb-5 space-y-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-orbitron text-[10px] uppercase tracking-[0.35em] text-cyber-cyan">
            Grid Broadcast
          </span>
          <h2 className="font-orbitron text-xl text-white">
            {editPost ? 'Update your signal' : 'Share a new signal'}
          </h2>
          <p className="font-exo text-xs text-gray-400">
            Drop tooling notes, research drops, or rally operatives.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="font-orbitron text-[10px] uppercase tracking-[0.35em] text-gray-500">
              Title
            </label>
            <input
              type="text"
              placeholder="Give the signal a clear title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 font-exo text-sm text-white placeholder-gray-500 focus:border-cyber-blue focus:outline-none focus:ring-2 focus:ring-cyber-blue/30 transition-all"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="font-orbitron text-[10px] uppercase tracking-[0.35em] text-gray-500">
              Body
            </label>
            <textarea
              placeholder="Share context, findings, or collaboration asks…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="h-24 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 font-exo text-sm text-white placeholder-gray-500 focus:border-cyber-blue focus:outline-none focus:ring-2 focus:ring-cyber-blue/30 transition-all"
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="font-orbitron text-[10px] uppercase tracking-[0.35em] text-gray-500">
                External link
              </label>
              <input
                type="url"
                placeholder="https://github.com/…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 font-exo text-sm text-white placeholder-gray-500 focus:border-cyber-blue focus:outline-none focus:ring-2 focus:ring-cyber-blue/30 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="font-orbitron text-[10px] uppercase tracking-[0.35em] text-gray-500">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 font-exo text-sm text-white focus:border-cyber-blue focus:outline-none focus:ring-2 focus:ring-cyber-blue/30 transition-all"
              >
                <option value="discussion">Discussion</option>
                <option value="tool">Tool Showcase</option>
                <option value="research">Research</option>
                <option value="project">Project</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-gray-500 font-exo">
              <label className="font-orbitron uppercase tracking-[0.3em]">Code Snippet</label>
              <span>Optional • supports fenced code blocks</span>
            </div>
            <textarea
              placeholder="Paste code, gists, or command snippets…"
              value={codeSnippet}
              onChange={(e) => setCodeSnippet(e.target.value)}
              className="h-20 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 font-mono text-sm text-gray-200 placeholder-gray-500 focus:border-cyber-blue focus:outline-none focus:ring-2 focus:ring-cyber-blue/30 transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="font-orbitron text-[10px] uppercase tracking-[0.35em] text-gray-500">
              Tags
            </label>
            <input
              type="text"
              placeholder="comma-separated (e.g. blue-team, detection, automate)"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 font-exo text-sm text-white placeholder-gray-500 focus:border-cyber-blue focus:outline-none focus:ring-2 focus:ring-cyber-blue/30 transition-all"
            />
          </div>

          <motion.button
            type="submit"
            disabled={loading}
            whileHover={{ scale: loading ? 1 : 1.02 }}
            whileTap={{ scale: loading ? 1 : 0.98 }}
            className="mt-1 w-full rounded-lg bg-gradient-to-r from-cyber-blue via-cyber-cyan to-white px-5 py-2.5 font-orbitron text-[10px] uppercase tracking-[0.35em] text-cyber-darker shadow-lg shadow-cyber-blue/40 transition-all disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <Loader className="h-4 w-4 animate-spin" />
                Transmitting…
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <Send size={16} />
                {editPost ? 'Update Post' : 'Transmit to Grid'}
              </span>
            )}
          </motion.button>
        </form>
      </motion.div>
    </motion.div>
  );
};

export default PostForm;
