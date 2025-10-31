import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Loader } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';

const AuthModal = ({ onClose }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn, signUp } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    if (isLogin) {
      const { error } = await signIn({ email, password });
      if (error) {
        toast.error(error.message);
      } else {
        toast.success('Signed in successfully!');
        onClose();
      }
    } else {
      if (password !== confirmPassword) {
        toast.error('Passwords do not match.');
        setLoading(false);
        return;
      }
      if (!username) {
        toast.error('Username is required.');
        setLoading(false);
        return;
      }
      const { error } = await signUp({
        email,
        password,
        options: {
          data: {
            username: username,
          },
        },
      });
      if (error) {
        toast.error(error.message);
      } else {
        toast.success('Account created! Please check your email to verify.');
        onClose();
      }
    }
    setLoading(false);
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
        className="relative cyber-card w-full max-w-md p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-cyber-blue transition-colors">
          <X size={24} />
        </button>

        <div className="flex justify-center mb-6 border-b border-cyber-blue/20">
          <button
            onClick={() => setIsLogin(true)}
            className={`px-6 py-2 font-orbitron text-lg transition-colors ${isLogin ? 'text-cyber-blue border-b-2 border-cyber-blue' : 'text-gray-500'}`}
          >
            Sign In
          </button>
          <button
            onClick={() => setIsLogin(false)}
            className={`px-6 py-2 font-orbitron text-lg transition-colors ${!isLogin ? 'text-cyber-blue border-b-2 border-cyber-blue' : 'text-gray-500'}`}
          >
            Sign Up
          </button>
        </div>

        <h2 className="font-orbitron text-3xl font-bold text-center text-white mb-6">
          {isLogin ? 'Access the Hub' : 'Join The Grid'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-6">
          {!isLogin && (
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
              required
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
            required
          />
          {!isLogin && (
            <input
              type="password"
              placeholder="Confirm Password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
              required
            />
          )}

          <motion.button
            type="submit"
            disabled={loading}
            whileHover={{ scale: 1.03, boxShadow: '0 0 25px rgba(0, 224, 255, 0.5)' }}
            whileTap={{ scale: 0.98 }}
            className="w-full flex items-center justify-center gap-2 px-8 py-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-black font-orbitron font-bold rounded-md transition-shadow duration-300 disabled:opacity-50"
          >
            {loading ? <Loader className="animate-spin" size={20} /> : (isLogin ? 'Sign In' : 'Create Account')}
          </motion.button>
        </form>
      </motion.div>
    </motion.div>
  );
};

export default AuthModal;
