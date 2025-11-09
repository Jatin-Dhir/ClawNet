import React, { useState } from 'react';
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
    } catch (submitError) {
      setError(submitError.message ?? 'Unable to post right now.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-white/5 p-6 sm:p-7">
      <form onSubmit={handleSubmit} className="space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="font-orbitron text-sm uppercase tracking-[0.3em] text-white">Share intel</h2>
          <span className="rounded-md border border-white/20 px-3 py-1 text-[10px] font-orbitron uppercase tracking-[0.3em] text-gray-400">
            {disabled ? 'Read only' : session ? 'Authenticated' : 'Sign in required'}
          </span>
        </header>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-exo text-sm text-gray-200 placeholder-gray-500 focus:border-cyber-blue focus:outline-none"
          placeholder={session ? 'Drop your findings, playbooks, or telemetry…' : 'Authenticate to publish your findings…'}
          disabled={submitting || disabled}
        />
        {disabled ? (
          <p className="text-xs font-exo text-gray-500">{disabledMessage}</p>
        ) : (
          error && <p className="text-xs font-exo text-red-400">{error}</p>
        )}
        <motion.button
          type="submit"
          whileHover={{ scale: submitting || disabled ? 1 : 1.02 }}
          whileTap={{ scale: submitting || disabled ? 1 : 0.98 }}
          className="inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2 font-orbitron text-xs uppercase tracking-[0.3em] text-cyber-darker disabled:opacity-60"
          style={{
            background: `linear-gradient(90deg, ${accentColor ?? '#00e0ff'}, ${accentColor ?? '#00f5ff'})`,
            boxShadow: `0 0 18px ${(accentColor ?? '#00e0ff')}33`,
          }}
          disabled={submitting || disabled}
        >
          {disabled ? 'Replies Disabled' : submitting ? 'Posting…' : session ? 'Submit' : 'Authenticate'}
        </motion.button>
      </form>
    </section>
  );
};

export default MissionComposer;

