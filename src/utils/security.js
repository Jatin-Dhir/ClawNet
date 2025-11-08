/**
 * Security utilities for input validation, sanitization, and security checks
 */

/**
 * Sanitize user input to prevent XSS attacks
 * @param {string} input - User input to sanitize
 * @returns {string} - Sanitized input
 */
export const sanitizeInput = (input) => {
  if (typeof input !== 'string') {
    return String(input);
  }

  // Remove potentially dangerous characters and HTML tags
  return input
    .replace(/[<>]/g, '') // Remove < and >
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers (onclick, onload, etc.)
    .replace(/data:/gi, '') // Remove data: protocol
    .trim();
};

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} - True if valid email
 */
export const validateEmail = (email) => {
  if (typeof email !== 'string') return false;
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 254; // RFC 5321 max length
};

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {{valid: boolean, errors: string[]}} - Validation result
 */
export const validatePassword = (password) => {
  const errors = [];
  
  if (!password || typeof password !== 'string') {
    errors.push('Password is required');
    return { valid: false, errors };
  }

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

/**
 * Validate and sanitize URL
 * @param {string} url - URL to validate
 * @returns {{valid: boolean, sanitized: string | null, error?: string}} - Validation result
 */
export const validateURL = (url) => {
  if (!url || typeof url !== 'string') {
    return { valid: false, sanitized: null, error: 'URL is required' };
  }

  try {
    const urlObj = new URL(url);
    
    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return { 
        valid: false, 
        sanitized: null, 
        error: 'Only HTTP and HTTPS protocols are allowed' 
      };
    }

    return { valid: true, sanitized: urlObj.toString() };
  } catch (error) {
    return { valid: false, sanitized: null, error: 'Invalid URL format' };
  }
};

/**
 * Validate file type by extension
 * @param {string} filename - File name
 * @param {string[]} allowedExtensions - Array of allowed extensions (e.g., ['jpg', 'png', 'pdf'])
 * @returns {boolean} - True if file type is allowed
 */
export const validateFileType = (filename, allowedExtensions) => {
  if (!filename || typeof filename !== 'string') return false;

  const extension = filename.split('.').pop()?.toLowerCase();
  if (!extension) return false;

  return allowedExtensions.includes(extension);
};

/**
 * Validate file size
 * @param {number} size - File size in bytes
 * @param {number} maxSize - Maximum size in bytes
 * @returns {{valid: boolean, error?: string}} - Validation result
 */
export const validateFileSize = (size, maxSize) => {
  if (typeof size !== 'number' || size < 0) {
    return { valid: false, error: 'Invalid file size' };
  }

  if (size > maxSize) {
    const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(2);
    return { 
      valid: false, 
      error: `File size exceeds maximum limit of ${maxSizeMB}MB` 
    };
  }

  return { valid: true };
};

/**
 * Sanitize filename to prevent directory traversal and other attacks
 * @param {string} filename - Original filename
 * @returns {string} - Sanitized filename
 */
export const sanitizeFilename = (filename) => {
  if (typeof filename !== 'string') return 'file';

  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace invalid chars with underscore
    .replace(/\.\./g, '_') // Prevent directory traversal
    .replace(/^\.+/, '') // Remove leading dots
    .slice(0, 255); // Limit length to 255 characters
};

/**
 * Validate CSRF token (placeholder for future implementation)
 * @param {string} token - CSRF token to validate
 * @returns {boolean} - True if token is valid
 */
export const validateCSRFToken = (token) => {
  // TODO: Implement CSRF token validation when backend is ready
  // For now, Supabase handles CSRF automatically
  return true;
};

/**
 * Rate limiting helper (client-side, basic)
 * @param {string} key - Unique key for rate limiting
 * @param {number} maxRequests - Maximum requests allowed
 * @param {number} windowMs - Time window in milliseconds
 * @returns {boolean} - True if request is allowed
 */
export const checkRateLimit = (key, maxRequests = 10, windowMs = 60000) => {
  const storageKey = `ratelimit_${key}`;
  const now = Date.now();
  
  try {
    const data = localStorage.getItem(storageKey);
    let requests = [];

    if (data) {
      requests = JSON.parse(data);
      // Remove requests outside the time window
      requests = requests.filter((timestamp) => now - timestamp < windowMs);
    }

    if (requests.length >= maxRequests) {
      return false; // Rate limit exceeded
    }

    // Add current request
    requests.push(now);
    localStorage.setItem(storageKey, JSON.stringify(requests));
    
    return true; // Request allowed
  } catch (error) {
    console.error('Rate limit check failed:', error);
    return true; // Allow request on error (fail open)
  }
};

/**
 * Content Security Policy helper for generating meta tags
 * @returns {string} - CSP string
 */
export const generateCSP = () => {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ');
};

/**
 * Secure headers configuration
 * @returns {object} - Headers object for Netlify/response
 */
export const getSecurityHeaders = () => {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': generateCSP(),
  };
};

