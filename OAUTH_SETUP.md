# OAuth Setup Guide for ClawNet

## Overview
ClawNet now supports multiple sign-in options:
- ✅ Email/Password (default)
- ✅ Google OAuth
- ✅ GitHub OAuth
- ✅ Password Reset

## Enable OAuth Providers in Supabase

### 1. Google OAuth Setup

#### A. Create Google OAuth Credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Go to **APIs & Services** → **Credentials**
4. Click **"Create Credentials"** → **"OAuth 2.0 Client ID"**
5. Configure consent screen if prompted
6. Application type: **Web application**
7. Add Authorized redirect URIs:
   ```
   https://ueyprbyiceqwohhptgim.supabase.co/auth/v1/callback
   ```
8. Copy **Client ID** and **Client Secret**

#### B. Configure in Supabase
1. Go to Supabase Dashboard → **Authentication** → **Providers**
2. Find **Google** and toggle it ON
3. Paste your **Client ID** and **Client Secret**
4. Click **Save**

### 2. GitHub OAuth Setup

#### A. Create GitHub OAuth App
1. Go to [GitHub Settings](https://github.com/settings/developers)
2. Click **OAuth Apps** → **New OAuth App**
3. Fill in:
   - **Application name**: ClawNet
   - **Homepage URL**: `https://projectclawnet.online`
   - **Authorization callback URL**: 
     ```
     https://ueyprbyiceqwohhptgim.supabase.co/auth/v1/callback
     ```
4. Click **Register application**
5. Copy **Client ID**
6. Generate a **Client Secret** and copy it

#### B. Configure in Supabase
1. Go to Supabase Dashboard → **Authentication** → **Providers**
2. Find **GitHub** and toggle it ON
3. Paste your **Client ID** and **Client Secret**
4. Click **Save**

### 3. Phone Authentication (Optional)

#### A. Enable Phone Provider
1. Go to Supabase Dashboard → **Authentication** → **Providers**
2. Find **Phone** and toggle it ON
3. Choose SMS provider:
   - **Twilio** (recommended)
   - **MessageBird**
   - **Vonage**

#### B. Configure Twilio (Example)
1. Sign up at https://www.twilio.com
2. Get your:
   - Account SID
   - Auth Token
   - Phone Number
3. Enter in Supabase Phone provider settings
4. Click **Save**

**Note**: Phone auth requires paid Twilio account for production.

## Testing OAuth Locally

### Important: OAuth Redirect URLs

For OAuth to work locally, you need to:

1. **Update Supabase Site URL**:
   - Go to **Authentication** → **URL Configuration**
   - Set Site URL to: `http://localhost:5175` (or your dev port)

2. **Add Redirect URLs**:
   ```
   http://localhost:5173/hub
   http://localhost:5174/hub
   http://localhost:5175/hub
   https://projectclawnet.online/hub
   ```

### Testing Steps:
1. Start dev server: `npm run dev`
2. Open sign-in modal
3. Click "Google" or "GitHub" button
4. Complete OAuth flow
5. You should be redirected back to `/hub`

## Code Implementation (Already Done)

### OAuth Sign-In Handler
```javascript
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
  }
};
```

### Password Reset Handler
```javascript
const handleForgotPassword = async (e) => {
  e.preventDefault();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/hub`,
  });
  if (error) throw error;
  toast.success('Password reset email sent!');
};
```

## UI Features Added

### Auth Modal Now Includes:
1. **Forgot Password Link**: Appears on sign-in form
2. **Password Reset Form**: Separate view with email input
3. **OAuth Buttons**: Google and GitHub sign-in buttons
4. **Back Navigation**: Easy return from forgot password view

## Security Considerations

### OAuth Tokens
- Supabase handles token storage securely
- Tokens are httpOnly cookies
- Automatic token refresh

### Password Reset
- Reset links expire after 1 hour
- One-time use only
- Requires email verification

### Rate Limiting
- OAuth attempts are rate-limited by provider
- Password reset: 1 email per 60 seconds per address

## Production Deployment

### Update Redirect URLs for Production:
1. Replace localhost URLs with production domain
2. Update OAuth app settings (Google/GitHub) with production callback URL
3. Test OAuth flow in production

### Callback URL Format:
```
https://YOUR_SUPABASE_PROJECT.supabase.co/auth/v1/callback
```

## Troubleshooting

### "OAuth Error: redirect_uri_mismatch"
- Check that callback URL in Google/GitHub matches Supabase exactly
- Must include `/auth/v1/callback` path

### "User not redirected after OAuth"
- Verify Site URL is set in Supabase
- Check redirect URLs include your domain
- Clear browser cache and try again

### "Password reset email not received"
- Check spam folder
- Verify email in Supabase → Authentication → Users
- Check Supabase email rate limits

### OAuth Button Does Nothing
- Open browser console for errors
- Verify provider is enabled in Supabase
- Check that credentials are saved

## Admin Panel Updates

### Adding Admins Now Works
The admin panel now uses the `user_emails` table to look up users by email:

1. Go to Admin Panel → Settings → Manage Admins
2. Enter user's email address
3. Click "Add"
4. User will see admin button after refresh

### Ban/Unban Users
Fixed the unique constraint issue:
- Users can now be banned multiple times
- Ban history is preserved
- Unban functionality works correctly

## Testing Checklist

- [ ] Email/password sign up works
- [ ] Email/password sign in works
- [ ] Forgot password sends email
- [ ] Password reset link works
- [ ] Google OAuth redirects correctly
- [ ] GitHub OAuth redirects correctly
- [ ] Admin can add new admins by email
- [ ] Admin can ban users
- [ ] Admin can unban users
- [ ] New admins see admin button after refresh

## Next Steps

1. Enable Google OAuth in Supabase (5 minutes)
2. Enable GitHub OAuth in Supabase (5 minutes)
3. Test locally
4. Deploy to production
5. Update production OAuth callback URLs
6. Test in production

---

**Need help?** Check Supabase docs: https://supabase.com/docs/guides/auth/social-login

