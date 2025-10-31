# File Upload Guide for ClawNet Tools

This guide explains how to upload actual tool files to replace the sample download files.

## Method 1: Using Supabase Dashboard (Recommended for Initial Setup)

### Step 1: Create Storage Bucket

1. Go to your [Supabase Dashboard](https://supabase.com/dashboard)
2. Navigate to **Storage** in the left sidebar
3. Click **"New bucket"**
4. Name it: `clawnet-downloads`
5. Make it **Public** (or configure RLS policies if you prefer private)
6. Click **"Create bucket"**

### Step 2: Upload Files via Dashboard

1. Click on the `clawnet-downloads` bucket
2. Create folders for each tool following this structure:

   ```
   clawnet-downloads/
   ├── portlock/
   │   ├── windows/
   │   │   └── portlock-v1.2.3-windows.exe
   │   ├── macos/
   │   │   └── portlock-v1.2.3-macos.dmg
   │   └── linux/
   │       └── portlock-v1.2.3-linux.tar.gz
   ├── clawnet-core/
   │   ├── windows/
   │   ├── macos/
   │   └── linux/
   └── clawview/
       ├── windows/
       ├── macos/
       └── linux/
   ```

3. Upload files by:
   - Clicking the folder for the tool (e.g., `portlock`)
   - Clicking the platform folder (e.g., `windows`)
   - Clicking **"Upload file"** and selecting your file
   - Rename the file to match the pattern: `{tool-slug}-{version}-{platform}.{extension}`
     - Example: `portlock-v1.2.3-windows.exe`

### File Naming Convention

- **Tool slug**:\*\* Lowercase with hyphens (e.g., `portlock`, `clawnet-core`, `clawview`)
- **Version:** As defined in `ToolDetailPage.jsx` (e.g., `v1.2.3`)
- **Platform:** `windows`, `macos`, or `linux`
- **Extension:**
  - Windows: `.exe`
  - macOS: `.dmg`
  - Linux: `.tar.gz`

### Example File Paths:

- `portlock/windows/portlock-v1.2.3-windows.exe`
- `clawnet-core/linux/clawnet-core-v0.8.1-linux.tar.gz`
- `clawview/macos/clawview-v2.1.0-macos.dmg`

## Method 2: Using the Admin Upload Component

### Step 1: Add File Uploader to Admin Page

1. Create an admin page or add to existing admin section
2. Import the `FileUploader` component:

```jsx
import FileUploader from "../components/admin/FileUploader";

// In your admin page
<FileUploader />;
```

### Step 2: Upload Files

1. Enter the tool name (e.g., "PortLock")
2. Select the platform
3. Enter the version (e.g., "v1.2.3")
4. Choose the file
5. Click "Upload File"

The component will automatically:

- Generate the correct file path
- Upload to Supabase Storage
- Handle errors and show success messages

## Method 3: Programmatic Upload (For Automation)

You can use the `uploadFile` function directly:

```javascript
import { uploadFile } from "./utils/fileStorage";

const file = document.querySelector('input[type="file"]').files[0];
const { data, error } = await uploadFile(
  file,
  "PortLock", // tool name
  "windows", // platform
  "v1.2.3" // version
);

if (error) {
  console.error("Upload failed:", error);
} else {
  console.log("Upload successful:", data);
}
```

## Storage Permissions

### Option 1: Public Bucket (Easiest)

Make the bucket public so anyone can download files:

1. Go to Storage → `clawnet-downloads` → Settings
2. Toggle **"Public bucket"** to ON
3. Files will be accessible without authentication

### Option 2: RLS Policies (More Secure)

If you want to control access, create RLS policies:

```sql
-- Allow public reads for downloads
CREATE POLICY "Public downloads are viewable by everyone"
ON storage.objects FOR SELECT
USING (bucket_id = 'clawnet-downloads');

-- Allow authenticated admins to upload
CREATE POLICY "Admins can upload files"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'clawnet-downloads'
  AND auth.role() = 'authenticated'
  -- Add your admin check here
);
```

## How Downloads Work

1. When a user clicks "Download":

   - The app first checks Supabase Storage for the actual file
   - If found, downloads from Supabase
   - If not found, generates a sample file as fallback

2. File paths are automatically generated based on:
   - Tool name → slug (e.g., "PortLock" → "portlock")
   - Platform → folder name
   - Version → from `compatibility` object in `ToolDetailPage.jsx`

## Updating Files

To update a file:

1. Upload a new file with the same path (it will replace the old one)
2. Or delete the old file and upload a new one
3. Make sure the version matches what's in your code

## Troubleshooting

### Files not downloading?

- Check that the bucket name is exactly `clawnet-downloads`
- Verify file paths match the naming convention
- Check bucket permissions (should be public or have RLS policies)

### Upload errors?

- Make sure you're authenticated (for RLS-protected buckets)
- Check file size limits (Supabase free tier: 50MB per file)
- Verify bucket exists and is accessible

### Version mismatch?

- Update the version in `src/pages/ToolDetailPage.jsx` to match your file name
- Or rename your uploaded file to match the version in code

## File Size Limits

- **Supabase Free Tier:** 50MB per file
- **Supabase Pro Tier:** 5GB per file
- Consider compressing large files or using external CDN for very large downloads
