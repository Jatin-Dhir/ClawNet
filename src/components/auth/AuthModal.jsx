import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Loader, Mail, Github, Phone, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../supabaseClient';
import toast from 'react-hot-toast';
import { validateEmail, validatePassword, sanitizeInput } from '../../utils/security';

const AuthModal = ({ onClose }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { signIn, signUp } = useAuth();

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setLoading(true);

    const sanitizedEmail = sanitizeInput(email).toLowerCase();

    if (!validateEmail(sanitizedEmail)) {
      toast.error('Please enter a valid email address.');
      setLoading(false);
      return;
    }

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(sanitizedEmail, {
        redirectTo: `${window.location.origin}/hub`,
      });

      if (error) throw error;

      toast.success('Password reset email sent! Check your inbox.');
      setIsForgotPassword(false);
      setEmail('');
    } catch (error) {
      toast.error(error.message || 'Failed to send reset email');
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthSignIn = async (provider) => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: provider,
        options: {
          redirectTo: `${window.location.origin}/hub`,
        },
      });

      if (error) throw error;
    } catch (error) {
      toast.error(`Failed to sign in with ${provider}`);
      console.error('OAuth error:', error);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    // Sanitize inputs
    const sanitizedEmail = sanitizeInput(email).toLowerCase();
    const sanitizedUsername = sanitizeInput(username);
    const sanitizedPassword = password; // Don't sanitize password (might remove valid chars)

    // Validate email
    if (!validateEmail(sanitizedEmail)) {
      toast.error('Please enter a valid email address.');
      setLoading(false);
      return;
    }

    if (isLogin) {
      // Basic validation for login
      if (!sanitizedPassword || sanitizedPassword.length < 6) {
        toast.error('Password must be at least 6 characters long.');
        setLoading(false);
        return;
      }

      const { error } = await signIn({ email: sanitizedEmail, password: sanitizedPassword });
      if (error) {
        toast.error(error.message);
      } else {
        toast.success('Signed in successfully!');
        onClose();
      }
    } else {
      // Validation for signup
      if (sanitizedPassword !== confirmPassword) {
        toast.error('Passwords do not match.');
        setLoading(false);
        return;
      }

      if (!sanitizedUsername || sanitizedUsername.length < 3) {
        toast.error('Username must be at least 3 characters long.');
        setLoading(false);
        return;
      }

      // Enhanced password validation
      const passwordValidation = validatePassword(sanitizedPassword);
      if (!passwordValidation.valid) {
        toast.error(passwordValidation.errors[0] || 'Password does not meet requirements.');
        setLoading(false);
        return;
      }

      // Rate limiting check
      const rateLimitKey = `signup_${sanitizedEmail}`;
      // Simple rate limiting - max 3 signup attempts per hour per email
      const attempts = JSON.parse(localStorage.getItem(rateLimitKey) || '[]');
      const recentAttempts = attempts.filter(timestamp => Date.now() - timestamp < 3600000);
      if (recentAttempts.length >= 3) {
        toast.error('Too many signup attempts. Please try again later.');
        setLoading(false);
        return;
      }

      recentAttempts.push(Date.now());
      localStorage.setItem(rateLimitKey, JSON.stringify(recentAttempts));

      const { error } = await signUp({
        email: sanitizedEmail,
        password: sanitizedPassword,
        options: {
          data: {
            username: sanitizedUsername,
          },
          emailRedirectTo: `${window.location.origin}/hub`,
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

        {!isForgotPassword && (
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
        )}

        <h2 className="font-orbitron text-3xl font-bold text-center text-white mb-6">
          {isForgotPassword ? 'Reset Password' : isLogin ? 'Access the Hub' : 'Join The Grid'}
        </h2>

        {isForgotPassword && (
          <button
            onClick={() => {
              setIsForgotPassword(false);
              setEmail('');
            }}
            className="mb-4 text-sm font-exo text-cyber-blue hover:text-cyber-cyan transition-colors"
          >
            ← Back to Sign In
          </button>
        )}

        {isForgotPassword ? (
          <form onSubmit={handleForgotPassword} className="space-y-6" onClick={(e) => e.stopPropagation()}>
            <input
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
              required
            />
            <motion.button
              type="submit"
              disabled={loading}
              whileHover={{ scale: 1.03, boxShadow: '0 0 25px rgba(0, 224, 255, 0.5)' }}
              whileTap={{ scale: 0.98 }}
              className="w-full flex items-center justify-center gap-2 px-8 py-3 bg-gradient-to-r from-cyber-blue to-cyber-cyan text-cyber-black font-orbitron font-bold rounded-md transition-shadow duration-300 disabled:opacity-50"
            >
              {loading ? <Loader className="animate-spin" size={20} /> : 'Send Reset Link'}
            </motion.button>
          </form>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-6" onClick={(e) => e.stopPropagation()}>
              {!isLogin && (
                <input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
                  required
                />
              )}
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                className="w-full px-4 py-3 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
                required
              />
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="w-full px-4 py-3 pr-12 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-3 flex items-center text-gray-400 hover:text-white transition-colors"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {!isLogin && (
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    placeholder="Confirm Password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="w-full px-4 py-3 pr-12 bg-cyber-gray border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyber-blue transition-all"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                    className="absolute inset-y-0 right-3 flex items-center text-gray-400 hover:text-white transition-colors"
                  >
                    {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              )}

              {isLogin && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setIsForgotPassword(true)}
                    className="text-sm font-exo text-cyber-blue hover:text-cyber-cyan transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
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

            {/* OAuth Options */}
            <div className="mt-6">
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-cyber-blue/20"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-cyber-dark text-gray-400 font-exo">Or continue with</span>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-3">
                <motion.button
                  onClick={() => handleOAuthSignIn('google')}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="flex items-center justify-center gap-2 px-4 py-3 bg-white/10 border border-white/20 rounded-md text-white hover:bg-white/20 transition-all font-exo text-sm"
                >
                  <Mail size={18} />
                  Google
                </motion.button>
                <motion.button
                  onClick={() => handleOAuthSignIn('github')}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="flex items-center justify-center gap-2 px-4 py-3 bg-white/10 border border-white/20 rounded-md text-white hover:bg-white/20 transition-all font-exo text-sm"
                >
                  <Github size={18} />
                  GitHub
                </motion.button>
              </div>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
};

export default AuthModal;
