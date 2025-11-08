# Email Verification Setup Guide

## Issue
Email verification links from Supabase currently redirect to the default Supabase domain instead of your custom domain.

## Solution
Configure the email redirect URL in your Supabase project dashboard.

### Steps:

1. **Go to Supabase Dashboard**
   - Navigate to https://supabase.com/dashboard
   - Select your project: `ueyprbyiceqwohhptgim`

2. **Update Authentication Settings**
   - Go to **Authentication** → **URL Configuration**
   
   - Find **Site URL** and set it to your production URL:
     ```
     https://projectclawnet.online
     ```
   - Or for local development:
     ```
     http://localhost:5175
     ```
     (Use whatever port Vite is running on)

3. **Configure Redirect URLs**
   - Under **Redirect URLs**, add ALL of these:
     ```
     https://projectclawnet.online/hub
     https://projectclawnet.online/*
     http://localhost:5173/hub
     http://localhost:5173/*
     http://localhost:5174/hub
     http://localhost:5174/*
     http://localhost:5175/hub
     http://localhost:5175/*
     ```
   
   **Why multiple ports?** Vite picks the next available port if one is in use.

4. **Update Email Templates**
   - Go to **Authentication** → **Email Templates**
   - Click on **"Confirm signup"** template
   - Make sure it contains `{{ .ConfirmationURL }}`
   - The URL will now automatically use your Site URL
   - **Important**: The redirect happens AFTER clicking the confirmation link

5. **Save Changes**
   - Click **Save** at the bottom of the page
   - Wait 1-2 minutes for changes to propagate

## Code Changes (Already Applied)

The signup flow now includes `emailRedirectTo` parameter:

```javascript
await signUp({
  email: sanitizedEmail,
  password: sanitizedPassword,
  options: {
    data: {
      username: sanitizedUsername,
    },
    emailRedirectTo: `${window.location.origin}/hub`,
  },
});
```

This ensures users land on your Community Hub after email verification.

## Testing

1. Create a new account
2. Check the verification email
3. Click the verification link
4. You should be redirected to your domain's `/hub` page

## Production Deployment

When deploying to Netlify/Vercel:
- Update the Site URL to your production domain
- Ensure all redirect URLs include your production domain
- Test the flow in production after deployment

