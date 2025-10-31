# How to Push Your Code to GitHub

## Step 1: Create a GitHub Repository

1. Go to [github.com](https://github.com) and sign in
2. Click the **"+"** icon in the top right → **"New repository"**
3. Fill in:
   - **Repository name:** `ProjectClawNet` (or any name you prefer)
   - **Description:** (optional) "ClawNet Cybersecurity Platform"
   - **Visibility:** Choose Public or Private
   - **DO NOT** check "Initialize with README" (we already have code)
4. Click **"Create repository"**
5. **Copy the repository URL** (it will look like: `https://github.com/yourusername/ProjectClawNet.git`)

## Step 2: Initialize Git in Your Project

Open your terminal in the project folder and run:

```bash
# Initialize git repository
git init

# Add all files to staging
git add .

# Create your first commit
git commit -m "Initial commit: ClawNet project"
```

## Step 3: Connect to GitHub and Push

```bash
# Add your GitHub repository as remote (replace with YOUR repository URL)
git remote add origin https://github.com/yourusername/ProjectClawNet.git

# Rename branch to main (if needed)
git branch -M main

# Push your code to GitHub
git push -u origin main
```

**Note:** If this is your first time, GitHub will ask you to authenticate. You can:

- Use GitHub Desktop (easier for beginners)
- Use a Personal Access Token
- Use GitHub CLI

## Step 4: Verify

Go back to your GitHub repository page and refresh - you should see all your files!

## Troubleshooting

### If you get authentication errors:

- **Option 1:** Use [GitHub Desktop](https://desktop.github.com/) (graphical interface)
- **Option 2:** Generate a Personal Access Token:
  1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
  2. Generate new token
  3. Use the token as your password when pushing

### If you get "branch name" errors:

```bash
git branch -M main
```

### If you need to update later:

```bash
git add .
git commit -m "Your commit message"
git push
```

## Next Steps

After pushing to GitHub:

1. Go to Netlify and import your repository
2. Add your environment variables in Netlify settings
3. Configure your custom domain
