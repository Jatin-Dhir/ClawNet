# Deployment Guide for projectclawnet.online

## Environment Variables Required

Before deploying, ensure you have these environment variables set:

- `VITE_SUPABASE_URL` - Your Supabase project URL
- `VITE_SUPABASE_ANON_KEY` - Your Supabase anonymous/public key

## Option 1: Netlify Deployment (Recommended)

### Step 1: Push to GitHub/GitLab

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

### Step 2: Connect to Netlify

1. Go to [Netlify](https://app.netlify.com)
2. Click "Add new site" → "Import an existing project"
3. Connect your Git repository
4. Build settings:
   - **Build command:** `npm install && npm run build`
   - **Publish directory:** `dist`
   - **Node version:** 18

### Step 3: Add Environment Variables

In Netlify Dashboard → Site settings → Environment variables, add:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### Step 4: Configure Custom Domain

1. Go to Site settings → Domain management
2. Click "Add custom domain"
3. Enter `projectclawnet.online`
4. Follow Netlify's DNS configuration instructions:
   - Add an A record pointing to Netlify's IP
   - Or add a CNAME record pointing to your Netlify subdomain

## Option 2: Vercel Deployment

### Step 1: Install Vercel CLI

```bash
npm i -g vercel
```

### Step 2: Deploy

```bash
vercel
```

Follow the prompts and add environment variables when asked.

### Step 3: Configure Domain

1. Go to Vercel Dashboard → Your Project → Settings → Domains
2. Add `projectclawnet.online`
3. Follow DNS configuration instructions

## Option 3: Other Hosting Providers

### Build the project:

```bash
npm install
npm run build
```

The `dist` folder contains the production build. Upload this to your hosting provider.

### Required Environment Variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## DNS Configuration for projectclawnet.online

### If using Netlify:

- **A Record:** Point to Netlify's IP (check Netlify dashboard for current IPs)
- **CNAME Record:** Point to `your-site-name.netlify.app`

### If using Vercel:

- **CNAME Record:** Point to `cname.vercel-dns.com`

### If using other providers:

Follow your hosting provider's DNS configuration guide.

## Build Verification

Test the build locally before deploying:

```bash
npm run build
npm run preview
```

Visit the preview URL to ensure everything works correctly.

## Troubleshooting

1. **Build fails:** Check Node version (should be 18+)
2. **Supabase errors:** Verify environment variables are set correctly
3. **Routing issues:** Ensure your hosting provider supports SPA routing (all routes should redirect to index.html)
