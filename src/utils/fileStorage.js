import { supabase } from '../supabaseClient';

const BUCKET_NAME = 'clawnet-downloads';

/**
 * Initialize the storage bucket (run this once in Supabase dashboard or via migration)
 * You need to create a bucket called 'clawnet-downloads' in Supabase Storage
 */
export const initializeBucket = async () => {
  try {
    // Check if bucket exists
    const { data, error } = await supabase.storage.listBuckets();
    if (error) throw error;
    
    const bucketExists = data.some(bucket => bucket.name === BUCKET_NAME);
    if (!bucketExists) {
      console.warn(`Bucket '${BUCKET_NAME}' does not exist. Create it in Supabase Dashboard > Storage.`);
    }
  } catch (error) {
    console.error('Error checking buckets:', error);
  }
};

/**
 * Validate file before upload
 * @param {File} file - The file to validate
 * @param {string} platform - Platform (windows, macos, linux)
 * @returns {{valid: boolean, error?: string}}
 */
const validateFile = (file, platform) => {
  // File size limit: 50MB for free tier
  const MAX_SIZE = 50 * 1024 * 1024; // 50MB
  
  if (file.size > MAX_SIZE) {
    return { valid: false, error: 'File size exceeds 50MB limit' };
  }
  
  // Allowed file types
  const allowedTypes = {
    windows: ['exe', 'msi'],
    macos: ['dmg', 'pkg'],
    linux: ['tar.gz', 'tar', 'deb', 'rpm']
  };
  
  const fileExtension = file.name.split('.').pop()?.toLowerCase();
  const allowedExtensions = allowedTypes[platform] || [];
  
  if (!fileExtension || !allowedExtensions.includes(fileExtension)) {
    return { 
      valid: false, 
      error: `Invalid file type. Allowed types for ${platform}: ${allowedExtensions.join(', ')}` 
    };
  }
  
  return { valid: true };
};

/**
 * Sanitize filename to prevent directory traversal and other attacks
 * @param {string} filename - The filename to sanitize
 * @returns {string} - Sanitized filename
 */
const sanitizeFilename = (filename) => {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace invalid chars
    .replace(/\.\./g, '_') // Prevent directory traversal
    .slice(0, 255); // Limit length
};

/**
 * Upload a file to Supabase Storage
 * @param {File} file - The file to upload
 * @param {string} toolName - Name of the tool (e.g., "PortLock")
 * @param {string} platform - Platform (windows, macos, linux)
 * @param {string} version - Version number (e.g., "v1.2.3")
 * @returns {Promise<{data: any, error: any}>}
 */
export const uploadFile = async (file, toolName, platform, version) => {
  try {
    // Validate file
    const validation = validateFile(file, platform);
    if (!validation.valid) {
      return { data: null, error: new Error(validation.error) };
    }
    
    // Sanitize inputs
    const toolSlug = toolName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const sanitizedVersion = sanitizeFilename(version);
    let extension;
    
    if (platform === 'windows') extension = 'exe';
    else if (platform === 'macos') extension = 'dmg';
    else extension = 'tar.gz';
    
    // Validate platform
    const validPlatforms = ['windows', 'macos', 'linux'];
    if (!validPlatforms.includes(platform)) {
      return { data: null, error: new Error('Invalid platform') };
    }
    
    const filePath = `${toolSlug}/${platform}/${toolSlug}-${sanitizedVersion}-${platform}.${extension}`;
    
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true, // Replace if file exists
        contentType: 'application/octet-stream'
      });
    
    if (error) throw error;
    
    return { data, error: null };
  } catch (error) {
    console.error('Error uploading file:', error);
    return { data: null, error };
  }
};

/**
 * Get the download URL for a file
 * @param {string} toolName - Name of the tool
 * @param {string} platform - Platform (windows, macos, linux)
 * @param {string} version - Version number
 * @returns {Promise<{url: string | null, error: any}>}
 */
export const getDownloadUrl = async (toolName, platform, version) => {
  try {
    const toolSlug = toolName.toLowerCase().replace(/\s+/g, '-');
    let extension;
    
    if (platform === 'windows') extension = 'exe';
    else if (platform === 'macos') extension = 'dmg';
    else extension = 'tar.gz';
    
    const filePath = `${toolSlug}/${platform}/${toolSlug}-${version}-${platform}.${extension}`;
    
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(filePath, 3600); // URL valid for 1 hour
    
    if (error) throw error;
    
    return { url: data.signedUrl, error: null };
  } catch (error) {
    // File doesn't exist, return null (will use sample file)
    return { url: null, error };
  }
};

/**
 * Download file directly (redirects to Supabase signed URL)
 * @param {string} toolName - Name of the tool
 * @param {string} platform - Platform
 * @param {string} version - Version number
 * @returns {Promise<boolean>} - Returns true if file was found and download initiated
 */
export const downloadFile = async (toolName, platform, version) => {
  try {
    const { url, error } = await getDownloadUrl(toolName, platform, version);
    
    if (url && !error) {
      // Create a link element and trigger download
      const link = document.createElement('a');
      link.href = url;
      link.download = ''; // Let browser handle filename
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error in downloadFile:', error);
    return false;
  }
};

/**
 * List all files for a tool
 * @param {string} toolName - Name of the tool
 * @returns {Promise<{data: any[], error: any}>}
 */
export const listToolFiles = async (toolName) => {
  try {
    const toolSlug = toolName.toLowerCase().replace(/\s+/g, '-');
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .list(toolSlug);
    
    if (error) throw error;
    
    return { data: data || [], error: null };
  } catch (error) {
    console.error('Error listing files:', error);
    return { data: [], error };
  }
};

/**
 * Delete a file
 * @param {string} toolName - Name of the tool
 * @param {string} platform - Platform
 * @param {string} version - Version number
 * @returns {Promise<{data: any, error: any}>}
 */
export const deleteFile = async (toolName, platform, version) => {
  try {
    const toolSlug = toolName.toLowerCase().replace(/\s+/g, '-');
    let extension;
    
    if (platform === 'windows') extension = 'exe';
    else if (platform === 'macos') extension = 'dmg';
    else extension = 'tar.gz';
    
    const filePath = `${toolSlug}/${platform}/${toolSlug}-${version}-${platform}.${extension}`;
    
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([filePath]);
    
    if (error) throw error;
    
    return { data, error: null };
  } catch (error) {
    console.error('Error deleting file:', error);
    return { data: null, error };
  }
};

