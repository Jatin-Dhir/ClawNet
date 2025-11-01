# File Upload Module Documentation

## Overview

The File Upload module handles secure file uploads and downloads for ProjectClawNet tools. It integrates with Supabase Storage to manage platform-specific tool installers.

## Location

- **Utility**: `src/utils/fileStorage.js`
- **Upload Component**: `src/components/admin/FileUploader.jsx`
- **Download Component**: `src/components/products/DownloadSection.jsx`
- **Backend**: Supabase Storage (bucket: `clawnet-downloads`)

## Architecture

```
File Upload Flow:
User → FileUploader Component
    ↓
File Validation
    ↓
Supabase Storage Upload
    ↓
Storage Bucket (clawnet-downloads)

Download Flow:
User → DownloadSection Component
    ↓
Generate File Path
    ↓
Check Supabase Storage
    ↓
Signed URL Generation
    ↓
File Download
```

## Key Features

1. **File Upload**

   - Platform-specific file management
   - Automatic path generation
   - File validation (size, type)
   - Error handling

2. **File Download**

   - Secure signed URLs
   - Automatic fallback handling
   - Progress tracking
   - Error notifications

3. **File Management**
   - List files for a tool
   - Delete files
   - Version management

## Usage

### Uploading a File

```jsx
import { uploadFile } from '../utils/fileStorage';

const handleUpload = async (file, toolName, platform, version) => {
  const { data, error } = await uploadFile(
    file,
    'PortLock', // Tool name
    'windows', // Platform
    'v1.2.3' // Version
  );

  if (error) {
    console.error('Upload failed:', error);
  } else {
    console.log('Upload successful:', data);
  }
};
```

### Downloading a File

```jsx
import { downloadFile } from '../utils/fileStorage';

const handleDownload = async () => {
  const success = await downloadFile('PortLock', 'windows', 'v1.2.3');

  if (!success) {
    // File not found - show error
    console.error('File not available');
  }
};
```

### Getting Download URL

```jsx
import { getDownloadUrl } from '../utils/fileStorage';

const { url, error } = await getDownloadUrl('PortLock', 'windows', 'v1.2.3');

if (url) {
  window.open(url, '_blank');
}
```

## File Path Structure

Files are organized in Supabase Storage as:

```
clawnet-downloads/
├── {tool-slug}/
│   ├── windows/
│   │   └── {tool-slug}-{version}-windows.exe
│   ├── macos/
│   │   └── {tool-slug}-{version}-macos.dmg
│   └── linux/
│       └── {tool-slug}-{version}-linux.tar.gz
```

### Path Generation

```javascript
// Tool name: "PortLock" → slug: "portlock"
// Platform: "windows"
// Version: "v1.2.3"
// Result: "portlock/windows/portlock-v1.2.3-windows.exe"
```

## API Reference

### uploadFile(file, toolName, platform, version)

Uploads a file to Supabase Storage.

**Parameters:**

- `file` (File): The file to upload
- `toolName` (string): Name of the tool (e.g., "PortLock")
- `platform` (string): Platform ("windows", "macos", "linux")
- `version` (string): Version number (e.g., "v1.2.3")

**Returns:** `Promise<{data: any, error: any}>`

### downloadFile(toolName, platform, version)

Downloads a file from Supabase Storage.

**Parameters:**

- `toolName` (string): Name of the tool
- `platform` (string): Platform
- `version` (string): Version number

**Returns:** `Promise<boolean>` - True if download successful

### getDownloadUrl(toolName, platform, version)

Gets a signed URL for file download.

**Parameters:**

- `toolName` (string): Name of the tool
- `platform` (string): Platform
- `version` (string): Version number

**Returns:** `Promise<{url: string | null, error: any}>`

### listToolFiles(toolName)

Lists all files for a specific tool.

**Parameters:**

- `toolName` (string): Name of the tool

**Returns:** `Promise<{data: any[], error: any}>`

### deleteFile(toolName, platform, version)

Deletes a file from storage.

**Parameters:**

- `toolName` (string): Name of the tool
- `platform` (string): Platform
- `version` (string): Version number

**Returns:** `Promise<{data: any, error: any}>`

## File Validation

### Current Validation

- File type checking (by extension)
- File size limits (50MB for free tier)
- Filename sanitization

### Recommended Enhancements

```javascript
// File type validation
const ALLOWED_TYPES = {
  windows: ['exe', 'msi'],
  macos: ['dmg', 'pkg'],
  linux: ['tar.gz', 'deb', 'rpm'],
};

// File size validation
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

// Virus scanning (future)
// Consider integrating with ClamAV or similar
```

## Security Considerations

1. **Access Control**

   - Upload requires authentication
   - Downloads are public (via signed URLs)
   - RLS policies protect storage

2. **File Validation**

   - Always validate file type
   - Check file size limits
   - Sanitize filenames
   - Scan for malicious content (future)

3. **URL Expiration**
   - Signed URLs expire after 1 hour
   - Regenerate URLs as needed

## Error Handling

Common errors and solutions:

| Error                      | Meaning                | Solution                  |
| -------------------------- | ---------------------- | ------------------------- |
| `Storage object not found` | File doesn't exist     | Upload file first         |
| `Payload too large`        | File too big           | Reduce file size          |
| `Invalid file type`        | Wrong extension        | Use correct file type     |
| `Bucket not found`         | Storage bucket missing | Create bucket in Supabase |

## Storage Bucket Setup

1. Go to Supabase Dashboard → Storage
2. Create bucket: `clawnet-downloads`
3. Set to Public (or configure RLS)
4. Configure policies if needed

## Testing

### Manual Testing Checklist

- [ ] Can upload file when authenticated
- [ ] Cannot upload file when not authenticated
- [ ] File downloads correctly
- [ ] Error shown when file not found
- [ ] File path generated correctly
- [ ] File type validation works
- [ ] File size limit enforced

## Future Enhancements

- [ ] Progress tracking for uploads
- [ ] Resume interrupted uploads
- [ ] Virus scanning integration
- [ ] File versioning system
- [ ] Download analytics
- [ ] CDN integration for faster downloads
- [ ] File checksum verification

## Related Documentation

- [File Upload Guide](../FILE_UPLOAD_GUIDE.md) - Step-by-step upload instructions
- [Security Guidelines](../SECURITY.md) - Security best practices
