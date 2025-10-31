import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Users, Code, Zap, Lock } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

const CodeCollaborationArena = ({ postId, codeSnippet }) => {
  const [isActive, setIsActive] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [code, setCode] = useState(codeSnippet || '');
  const [cursor, setCursor] = useState(0);
  const [isDuelMode, setIsDuelMode] = useState(false);
  const { session, profile } = useAuth();
  const textareaRef = useRef(null);

  useEffect(() => {
    if (isActive && session) {
      setParticipants([{ id: session.user.id, username: profile?.username || 'You', color: '#00e0ff' }]);
    }
  }, [isActive, session, profile]);

  const handleCodeChange = (e) => {
    setCode(e.target.value);
    setCursor(e.target.selectionStart);
  };

  const highlightSyntax = (text) => {
    const patterns = {
      keyword: /\b(const|let|var|function|return|if|else|for|while|class|import|export|async|await)\b/g,
      string: /(['"`])(?:(?=(\\?))\2.)*?\1/g,
      comment: /\/\/.*|\/\*[\s\S]*?\*\//g,
      number: /\b\d+\.?\d*\b/g,
    };

    let highlighted = text;
    highlighted = highlighted.replace(patterns.keyword, '<span class="text-cyber-blue">$&</span>');
    highlighted = highlighted.replace(patterns.string, '<span class="text-green-400">$&</span>');
    highlighted = highlighted.replace(patterns.comment, '<span class="text-gray-500">$&</span>');
    highlighted = highlighted.replace(patterns.number, '<span class="text-cyber-cyan">$&</span>');

    return highlighted;
  };

  if (!codeSnippet) {
    return (
      <div className="cyber-card p-6 text-center">
        <Code className="mx-auto text-gray-500 mb-2" size={32} />
        <p className="text-gray-400">No code snippet available for collaboration</p>
      </div>
    );
  }

  return (
    <div className="cyber-card p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Code className="text-cyber-blue" size={24} />
          <h3 className="font-orbitron text-xl text-white">Live Code Collaboration</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsActive(!isActive)}
            className={`px-4 py-2 rounded-md font-exo text-sm transition-colors ${
              isActive
                ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                : 'bg-cyber-blue/10 text-cyber-blue border border-cyber-blue/30'
            }`}
          >
            {isActive ? <Lock size={16} className="inline mr-2" /> : <Users size={16} className="inline mr-2" />}
            {isActive ? 'Active' : 'Join Session'}
          </button>
          {isActive && (
            <button
              onClick={() => setIsDuelMode(!isDuelMode)}
              className={`px-3 py-2 rounded-md font-exo text-xs transition-colors ${
                isDuelMode
                  ? 'bg-red-500/20 text-red-400 border border-red-500/50'
                  : 'bg-gray-700/30 text-gray-400 border border-gray-600/30'
              }`}
            >
              <Zap size={14} className="inline mr-1" />
              Duel Mode
            </button>
          )}
        </div>
      </div>

      {isActive && participants.length > 0 && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">Collaborators:</span>
          {participants.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2 px-2 py-1 rounded bg-cyber-gray/50 border border-cyber-blue/20"
            >
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }}></div>
              <span className="text-xs text-white">{p.username}</span>
            </div>
          ))}
        </div>
      )}

      {isDuelMode && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-md"
        >
          <div className="flex items-center gap-2 text-red-400 mb-2">
            <Zap size={16} />
            <span className="font-orbitron text-sm">Hacker Duel Mode Active</span>
          </div>
          <p className="text-xs text-gray-400">Challenge another user to solve a code challenge side-by-side!</p>
        </motion.div>
      )}

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={code}
          onChange={handleCodeChange}
          onSelect={(e) => setCursor(e.target.selectionStart)}
          className="w-full h-64 p-4 bg-cyber-black border border-cyber-blue/30 rounded-md text-green-400 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-cyber-blue"
          placeholder="Start coding..."
          disabled={!isActive}
        />
        <div className="absolute top-4 left-4 pointer-events-none font-mono text-sm whitespace-pre-wrap opacity-50">
          {code.split('').map((char, index) => {
            const isKeyword = /^(const|let|var|function|return|if|else|for|while|class|import|export|async|await)$/.test(char);
            return (
              <span
                key={index}
                className={
                  index === cursor
                    ? 'bg-cyber-blue/30'
                    : isKeyword
                    ? 'text-cyber-blue'
                    : /['"`]/.test(char)
                    ? 'text-green-400'
                    : /\/\//.test(char)
                    ? 'text-gray-500'
                    : ''
                }
              >
                {char}
              </span>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-gray-500">
        <span>Syntax highlighting enabled</span>
        {isActive && <span className="text-green-400">● Live</span>}
      </div>
    </div>
  );
};

export default CodeCollaborationArena;

