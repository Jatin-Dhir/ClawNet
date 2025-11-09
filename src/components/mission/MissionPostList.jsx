import React from 'react';
import { motion } from 'framer-motion';

const formatRelativeTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'moments ago';

  const diffMs = Date.now() - date.getTime();
  const units = [
    { label: 'year', ms: 1000 * 60 * 60 * 24 * 365 },
    { label: 'month', ms: 1000 * 60 * 60 * 24 * 30 },
    { label: 'day', ms: 1000 * 60 * 60 * 24 },
    { label: 'hour', ms: 1000 * 60 * 60 },
    { label: 'minute', ms: 1000 * 60 },
    { label: 'second', ms: 1000 },
  ];

  for (const unit of units) {
    if (Math.abs(diffMs) >= unit.ms || unit.label === 'second') {
      const count = Math.round(diffMs / unit.ms);
      const plural = Math.abs(count) === 1 ? unit.label : `${unit.label}s`;
      return `${Math.abs(count)} ${plural} ago`;
    }
  }
  return 'moments ago';
};

const MissionPostList = ({ posts }) => {
  if (!posts?.length) {
    return (
      <div className="rounded-3xl border border-white/10 bg-white/5 p-6 text-center text-sm font-exo text-gray-400">
        No posts yet. Be the first to share intel from this mission.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {posts
        .filter((post) => !post.parent_id)
        .map((post) => (
          <motion.div
            key={post.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="rounded-3xl border border-white/10 bg-white/5 p-5 sm:p-6 space-y-3"
          >
            <header className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-gray-400">
                <span className="font-orbitron text-white">{post.author_display ?? 'Operative'}</span>
                <span>•</span>
                <span>{formatRelativeTime(post.created_at)}</span>
              </div>
              {post.status === 'flagged' && (
                <span className="rounded-md border border-yellow-500/40 px-3 py-1 text-[10px] font-orbitron uppercase tracking-[0.3em] text-yellow-400">
                  Under Review
                </span>
              )}
            </header>
            <p className="font-exo text-sm text-gray-200 leading-relaxed whitespace-pre-line">{post.body}</p>
            {post.attachment_url && (
              <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-gray-400">
                Attachment: <a href={post.attachment_url} target="_blank" rel="noreferrer" className="text-cyber-cyan hover:text-white">
                  {post.attachment_url}
                </a>
              </div>
            )}
          </motion.div>
        ))}
    </div>
  );
};

export default MissionPostList;

