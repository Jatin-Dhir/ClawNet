import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '../../supabaseClient';

const MissionComposer = ({
  threadId,
  session,
  onRequireAuth,
  onPostCreated,
  accentColor,
  disabled = false,
  disabledMessage = 'Mission thread is read-only while we prep the live feed.',
}) => {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 128)}px`;
    }
  }, [body]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (disabled) return;
    if (!session) {
      onRequireAuth?.();
      return;
    }
    if (!body.trim()) {
      setError('Add intel or findings before submitting.');
      return;
    }

    // Validate threadId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!threadId || !uuidRegex.test(threadId)) {
      setError('Invalid thread ID. Please refresh the page.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { data, error: insertError } = await supabase
        .from('mission_posts')
        .insert({
          thread_id: threadId,
          body: body.trim(),
          created_by: session.user.id,
        })
        .select('*')
        .maybeSingle();

      if (insertError) {
        throw insertError;
      }

      onPostCreated?.(data);
      setBody('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } catch (submitError) {
      setError(submitError.message ?? 'Unable to post right now.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-lg p-4">
      <form onSubmit={handleSubmit} className="flex items-end gap-3">
        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!disabled && session && body.trim()) {
                  handleSubmit(e);
                }
              }
            }}
            rows={1}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-exo text-sm text-gray-200 placeholder-gray-500 focus:border-cyber-blue focus:outline-none focus:ring-1 focus:ring-cyber-blue/30 transition resize-none overflow-y-auto"
            placeholder={disabled ? disabledMessage : session ? 'Type your message... (Enter to send, Shift+Enter for new line)' : 'Sign in to send messages…'}
            disabled={submitting || disabled}
            style={{ minHeight: '44px', maxHeight: '128px' }}
          />
          {error && !disabled && (
            <p className="mt-2 text-xs font-exo text-red-400">{error}</p>
          )}
        </div>
        <motion.button
          type="submit"
          whileHover={{ scale: submitting || disabled ? 1 : 1.05 }}
          whileTap={{ scale: submitting || disabled ? 1 : 0.95 }}
          className="flex-shrink-0 rounded-xl px-5 py-3 font-exo text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition"
          style={{
            background: disabled 
              ? 'rgba(255,255,255,0.1)' 
              : `linear-gradient(135deg, ${accentColor ?? '#00e0ff'}, ${accentColor ?? '#00f5ff'})`,
            boxShadow: disabled ? 'none' : `0 4px 12px ${(accentColor ?? '#00e0ff')}40`,
          }}
          disabled={submitting || disabled || !body.trim()}
        >
          {submitting ? 'Sending...' : 'Send'}
        </motion.button>
      </form>
    </section>
  );
};

export default MissionComposer;

