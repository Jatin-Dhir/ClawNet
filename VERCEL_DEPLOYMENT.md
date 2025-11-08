# Vercel Deployment Guide for ClawNet

## Prerequisites

- GitHub repository (already done ✅)
- Vercel account (free tier works)
- Supabase project credentials

## Step-by-Step Deployment

### 1. Create Vercel Account

1. Go to https://vercel.com
2. Click "Sign Up"
3. Choose "Continue with GitHub" (recommended)
4. Authorize Vercel to access your GitHub repositories

### 2. Import Project

1. From Vercel dashboard, click **"Add New..."** → **"Project"**
2. Find your repository: `Jatin-Dhir/ClawNet`
3. Click **"Import"**

### 3. Configure Build Settings

Vercel should auto-detect Vite. Verify these settings:

**Framework Preset**: Vite
**Build Command**: `npm run build`
**Output Directory**: `dist`
**Install Command**: `npm install`

### 4. Add Environment Variables

Click **"Environment Variables"** and add:

```
VITE_SUPABASE_URL=https://ueyprbyiceqwohhptgim.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here
```

**Important**:

- Get your anon key from Supabase Dashboard → Settings → API
- Add these for **all environments** (Production, Preview, Development)

### 5. Deploy

1. Click **"Deploy"**
2. Wait 2-3 minutes for build to complete
3. You'll get a URL like: `https://clawnet.vercel.app`

### 6. Configure Custom Domain (Optional)

1. Go to Project Settings → **Domains**
2. Add your domain: `projectclawnet.online`
3. Follow DNS configuration instructions
4. Wait for DNS propagation (5-30 minutes)

### 7. Update Supabase Settings

After deployment, update Supabase:

1. Go to Supabase Dashboard → **Authentication** → **URL Configuration**
2. Update **Site URL**:

   ```
   https://clawnet.vercel.app
   ```

   (or your custom domain)

3. Add **Redirect URLs**:

   ```
   https://clawnet.vercel.app/hub
   https://clawnet.vercel.app/*
   https://projectclawnet.online/hub
   https://projectclawnet.online/*
   ```

4. Click **Save**

### 8. Configure Security Headers (Optional)

Create `vercel.json` in project root:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        },
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "X-XSS-Protection",
          "value": "1; mode=block"
        },
        {
          "key": "Referrer-Policy",
          "value": "strict-origin-when-cross-origin"
        },
        {
          "key": "Permissions-Policy",
          "value": "geolocation=(), microphone=(), camera=()"
        },
        {
          "key": "Strict-Transport-Security",
          "value": "max-age=31536000; includeSubDomains; preload"
        }
      ]
    }
  ],
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```

Then commit and push:

```bash
git add vercel.json
git commit -m "chore: add Vercel configuration with security headers"
git push origin main
```

Vercel will auto-deploy on every push to main.

## Automatic Deployments

Vercel automatically:

- ✅ Deploys on every push to `main`
- ✅ Creates preview deployments for pull requests
- ✅ Provides deployment URLs
- ✅ Handles SSL certificates
- ✅ Serves via global CDN

## Environment Variables Management

### To Update Env Vars:

1. Go to Project Settings → **Environment Variables**
2. Edit or add new variables
3. Click **Save**
4. **Redeploy** (Settings → Deployments → click "..." → Redeploy)

### For Multiple Environments:

- **Production**: Main branch deployments
- **Preview**: Pull request deployments
- **Development**: Local development

You can set different values for each environment.

## Troubleshooting

### Build Fails

- Check build logs in Vercel dashboard
- Verify all dependencies are in `package.json`
- Ensure environment variables are set

### Blank Page After Deploy

- Check browser console for errors
- Verify Supabase credentials are correct
- Check that `VITE_` prefix is used (required for Vite)

### 404 on Routes

- Vercel should auto-configure SPA routing
- If not, the `vercel.json` rewrite rule fixes it

### Email Verification Not Working

- Update Supabase Site URL to your Vercel domain
- Add all redirect URLs in Supabase dashboard

## Monitoring & Analytics

### Vercel Dashboard Shows:

- Deployment status
- Build logs
- Function logs (if using serverless)
- Analytics (page views, performance)
- Error tracking

### Check Deployment:

```bash
vercel --prod
```

## Rollback (if needed)

1. Go to Deployments tab
2. Find a previous successful deployment
3. Click "..." → **"Promote to Production"**

## Cost

**Free Tier Includes**:

- Unlimited deployments
- 100GB bandwidth/month
- Automatic HTTPS
- Preview deployments
- Custom domains (1 per project)

**Pro Tier** ($20/month):

- Unlimited bandwidth
- Advanced analytics
- Team collaboration

## Comparison: Netlify vs Vercel

| Feature       | Netlify (Current) | Vercel    |
| ------------- | ----------------- | --------- |
| Build Time    | ~2-3 min          | ~2-3 min  |
| CDN           | ✅ Global         | ✅ Global |
| Auto Deploy   | ✅                | ✅        |
| Custom Domain | ✅                | ✅        |
| Free SSL      | ✅                | ✅        |
| Functions     | ✅                | ✅ Better |
| Analytics     | Basic             | Advanced  |
| Preview URLs  | ✅                | ✅        |

**Recommendation**: Both work great. Vercel has better Next.js integration, but for Vite/React, they're equivalent.

## Quick Deploy (One Command)

If you have Vercel CLI installed:

```bash
npm i -g vercel
vercel login
vercel --prod
```

Follow prompts and you're live!

## Post-Deployment Checklist

- [ ] Site loads correctly
- [ ] All routes work (/, /hub, /about, /admin, /team, etc.)
- [ ] Sign up/login works
- [ ] Email verification redirects to your domain
- [ ] Admin panel accessible
- [ ] Community features work (upvote, comment)
- [ ] Terminal opens (Ctrl+`)
- [ ] All images/assets load
- [ ] Mobile responsive
- [ ] Security headers active (check with securityheaders.com)

## Support

- Vercel Docs: https://vercel.com/docs
- Vercel Discord: https://vercel.com/discord
- GitHub Issues: Report bugs in your repo

---

**Ready to deploy?** Just follow steps 1-5 above and you'll be live in minutes! 🚀
