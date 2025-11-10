import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../supabaseClient';

const formatTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
};

const MissionPostList = ({ posts }) => {
  const { session } = useAuth();
  const messagesEndRef = useRef(null);
  const [profiles, setProfiles] = useState({});

  useEffect(() => {
    const fetchProfiles = async () => {
      if (!posts?.length) return;
      // Filter to only valid UUIDs (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const userIds = [...new Set(posts.map((p) => p.created_by).filter(Boolean).filter((id) => uuidRegex.test(id)))];
      if (userIds.length === 0) return;

      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .in('id', userIds);

      if (data) {
        const profileMap = {};
        data.forEach((profile) => {
          profileMap[profile.id] = profile;
        });
        setProfiles(profileMap);
      }
    };

    fetchProfiles();
  }, [posts]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [posts]);

  const getAuthorInfo = (post) => {
    if (post.profiles) {
      return {
        name: post.profiles.display_name || post.profiles.username || 'Operative',
        avatar: post.profiles.avatar_url,
        id: post.profiles.id,
      };
    }
    if (post.created_by && profiles[post.created_by]) {
      const profile = profiles[post.created_by];
      return {
        name: profile.display_name || profile.username || 'Operative',
        avatar: profile.avatar_url,
        id: profile.id,
      };
    }
    return {
      name: post.author_display || 'Operative',
      avatar: null,
      id: post.created_by,
    };
  };

  const getAvatarInitial = (name) => {
    return name?.[0]?.toUpperCase() || '?';
  };

  if (!posts?.length) {
    return (
      <div className="flex items-center justify-center h-64 rounded-2xl border border-white/10 bg-white/[0.02]">
        <p className="text-sm font-exo text-gray-400">No messages yet. Start the conversation!</p>
      </div>
    );
  }

  const filteredPosts = posts?.filter((post) => !post.parent_id) ?? [];

  return (
    <div className="flex flex-col h-[calc(100vh-28rem)] min-h-[400px] max-h-[600px] rounded-2xl border border-white/10 bg-black/20 overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-cyber-blue/30 scrollbar-track-transparent">
        {filteredPosts.map((post, index) => {
            const author = getAuthorInfo(post);
            const isOwnMessage = session?.user?.id === post.created_by;
            const prevPost = index > 0 ? filteredPosts[index - 1] : null;
            const showAvatar = !prevPost || prevPost.created_by !== post.created_by || 
              new Date(post.created_at) - new Date(prevPost.created_at) > 5 * 60 * 1000;

            return (
              <motion.div
                key={post.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className={`flex gap-3 ${isOwnMessage ? 'flex-row-reverse' : ''}`}
              >
                {showAvatar ? (
                  <div className="flex-shrink-0">
                    {author.avatar ? (
                      <img
                        src={author.avatar}
                        alt={author.name}
                        className="w-10 h-10 rounded-full border border-white/10 bg-black/40 object-cover"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full border border-white/10 bg-gradient-to-br from-cyber-blue to-cyber-cyan flex items-center justify-center">
                        <span className="text-sm font-orbitron font-bold text-white">{getAvatarInitial(author.name)}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-10 flex-shrink-0" />
                )}
                <div className={`flex-1 ${isOwnMessage ? 'flex flex-col items-end' : ''}`}>
                  {showAvatar && (
                    <div className={`flex items-center gap-2 mb-1 ${isOwnMessage ? 'flex-row-reverse' : ''}`}>
                      <span className="text-xs font-exo font-semibold text-white">{author.name}</span>
                      <span className="text-[10px] font-exo text-gray-500">{formatTime(post.created_at)}</span>
                    </div>
                  )}
                  <div
                    className={`rounded-2xl px-4 py-2.5 max-w-[75%] ${
                      isOwnMessage
                        ? 'bg-cyber-blue/20 border border-cyber-blue/40 text-white'
                        : 'bg-white/[0.05] border border-white/10 text-gray-200'
                    }`}
                  >
                    <p className="text-sm font-exo leading-relaxed whitespace-pre-wrap break-words">{post.body}</p>
                    {post.attachment_url && (
                      <div className="mt-2 rounded-lg border border-white/10 bg-black/30 p-2 text-xs text-gray-400">
                        <a href={post.attachment_url} target="_blank" rel="noreferrer" className="text-cyber-cyan hover:text-white">
                          📎 Attachment
                        </a>
                      </div>
                    )}
                  </div>
                  {!showAvatar && (
                    <span className={`text-[10px] font-exo text-gray-500 mt-1 ${isOwnMessage ? 'text-right' : ''}`}>
                      {formatTime(post.created_at)}
                    </span>
                  )}
                </div>
              </motion.div>
            );
          })}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};

export default MissionPostList;

