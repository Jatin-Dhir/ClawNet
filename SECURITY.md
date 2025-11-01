# Security Guidelines

This document outlines security best practices for ProjectClawNet development and deployment.

## 🔐 Security Checklist

Before deploying or contributing:

- [ ] Run `npm audit` after installation
- [ ] Ensure all environment variables are stored securely
- [ ] Never commit secrets or API keys
- [ ] Verify Supabase RLS policies are enabled
- [ ] Validate all user inputs
- [ ] Sanitize file uploads
- [ ] Use HTTPS in production
- [ ] Keep dependencies up to date

## 🔑 Environment Variables

### Required Variables

```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Security Notes

- **Public Keys Only**: Only `VITE_SUPABASE_ANON_KEY` should be in frontend code
- **Never Commit**: Add `.env` to `.gitignore`
- **Separate Keys**: Use different keys for development and production
- **Rotation**: Rotate keys regularly, especially if exposed

### Supabase Key Types

- **Anon Key**: Public, safe for client-side use (with RLS)
- **Service Role Key**: Secret, server-side only (NEVER in frontend)

## 🛡️ Input Validation

### User Inputs

**All inputs are now validated and sanitized using `src/utils/security.js`**

```javascript
import { sanitizeInput, validateEmail, validatePassword } from '../utils/security';

// Good: Validate and sanitize input
const sanitizedInput = sanitizeInput(userInput).slice(0, 1000);
const isValidEmail = validateEmail(email);
const passwordCheck = validatePassword(password);

// Bad: Direct usage
const badCode = userInput => {
  return userInput; // Unsafe!
};
```

### Implementation Status

✅ **Authentication Forms**: Email and password validation implemented
✅ **Post Creation**: All fields sanitized and validated
✅ **File Uploads**: Type, size, and filename validation
✅ **URL Validation**: Only HTTP/HTTPS allowed
✅ **Rate Limiting**: Signup rate limiting implemented

See [SECURITY_IMPROVEMENTS.md](./SECURITY_IMPROVEMENTS.md) for detailed implementation.

### File Uploads

File uploads require strict validation:

```javascript
// Validate file type
const allowedTypes = ['exe', 'dmg', 'tar.gz'];
const fileExtension = file.name.split('.').pop();

if (!allowedTypes.includes(fileExtension)) {
  throw new Error('Invalid file type');
}

// Validate file size (50MB limit for free tier)
const maxSize = 50 * 1024 * 1024; // 50MB
if (file.size > maxSize) {
  throw new Error('File too large');
}

// Scan for malicious content (consider using antivirus API)
```

## 🔒 Row Level Security (RLS)

All Supabase tables must have RLS enabled:

### Example Policy

```sql
-- Enable RLS
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- Users can only access their own posts
CREATE POLICY "Users can access own posts"
ON posts FOR SELECT
USING (auth.uid() = user_id);

-- Public can read, but only owners can write
CREATE POLICY "Public read, owner write"
ON posts FOR ALL
USING (
  true OR auth.uid() = user_id
)
WITH CHECK (
  auth.uid() = user_id
);
```

### Verify RLS

```bash
# In Supabase Dashboard
# Go to Authentication > Policies
# Ensure all tables have appropriate policies
```

## 🚨 Common Vulnerabilities

### 1. XSS (Cross-Site Scripting)

**Prevention:**

- React automatically escapes content
- Use `dangerouslySetInnerHTML` sparingly
- Sanitize user-generated content
- Validate all inputs

### 2. SQL Injection

**Prevention:**

- Use Supabase client (prevents SQL injection)
- Never construct SQL queries with string concatenation
- Use parameterized queries if using raw SQL

### 3. CSRF (Cross-Site Request Forgery)

**Prevention:**

- Supabase handles CSRF tokens automatically
- Use same-site cookies
- Verify origin headers

### 4. Insecure Dependencies

**Prevention:**

```bash
# Regular audit
npm audit

# Fix vulnerabilities
npm audit fix

# Check for outdated packages
npm outdated
```

## 🔐 Authentication Security

### Password Requirements

- Minimum 8 characters (enforced by Supabase)
- Recommended: 12+ characters with mix of types
- Use password managers

### Session Management

- Sessions expire after configured time
- Tokens stored securely in httpOnly cookies
- Logout invalidates sessions

### Admin Access

- Protect admin routes with authentication checks
- Use role-based access control (RBAC)
- Log all admin actions

## 📁 File Upload Security

### Validation Checklist

- [ ] File type validation (whitelist approach)
- [ ] File size limits (50MB max for free tier)
- [ ] Filename sanitization
- [ ] Virus scanning (consider integration)
- [ ] Content validation (verify file structure)

### Implementation

See `src/utils/fileStorage.js` for upload validation.

## 🌐 Network Security

### HTTPS

- Always use HTTPS in production
- Enable HSTS headers
- Use secure cookies

### CORS

- Configure CORS properly in Supabase
- Restrict origins in production
- Avoid wildcard `*` in production

## 📊 Security Monitoring

### Logging

- Log authentication attempts
- Log file uploads
- Log admin actions
- Monitor for suspicious patterns

### Supabase Dashboard

- Monitor API usage
- Review error logs
- Check for unusual activity

## 🐛 Reporting Security Issues

**DO NOT** open a public issue for security vulnerabilities.

Instead, email: **contact@projectclawnet.online**

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if applicable)

## 🔄 Security Updates

- Subscribe to security advisories
- Update dependencies regularly
- Review and update this document quarterly
- Conduct security audits annually

## 📚 Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Supabase Security Guide](https://supabase.com/docs/guides/auth/security)
- [React Security](https://reactjs.org/docs/dom-elements.html#dangerouslysetinnerhtml)
- [npm Security](https://docs.npmjs.com/about-security-policies)

## ✅ Pre-Deployment Checklist

Before deploying to production:

- [ ] All environment variables configured
- [ ] RLS policies verified
- [ ] Dependencies updated (`npm audit`)
- [ ] File upload validation tested
- [ ] Authentication flows tested
- [ ] HTTPS enabled
- [ ] CORS configured correctly
- [ ] Error logging enabled
- [ ] Backup strategy in place

---

**Remember**: Security is an ongoing process, not a one-time setup.
