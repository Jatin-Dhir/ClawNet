import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Upload, Check, X, Loader, AlertCircle } from 'lucide-react';
import { uploadFile } from '../../utils/fileStorage';
import toast from 'react-hot-toast';

const FileUploader = () => {
  const [toolName, setToolName] = useState('');
  const [platform, setPlatform] = useState('windows');
  const [version, setVersion] = useState('');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setUploaded(false);
    }
  };

  const handleUpload = async () => {
    if (!toolName || !version || !file) {
      toast.error('Please fill in all fields and select a file');
      return;
    }

    setUploading(true);
    setUploaded(false);

    try {
      const { data, error } = await uploadFile(file, toolName, platform, version);
      
      if (error) {
        toast.error(`Upload failed: ${error.message}`);
        setUploaded(false);
      } else {
        toast.success('File uploaded successfully!');
        setUploaded(true);
        // Reset form
        setToolName('');
        setVersion('');
        setFile(null);
        // Reset file input
        const fileInput = document.getElementById('file-input');
        if (fileInput) fileInput.value = '';
      }
    } catch (error) {
      toast.error(`Upload failed: ${error.message}`);
      setUploaded(false);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="cyber-card p-6 max-w-2xl mx-auto">
      <h2 className="font-orbitron text-2xl font-bold text-white mb-6 text-center">
        Upload Tool Files
      </h2>
      
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-exo text-gray-300 mb-2">
            Tool Name
          </label>
          <input
            type="text"
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            placeholder="e.g., PortLock"
            className="w-full px-4 py-2 bg-cyber-dark border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:border-cyber-blue focus:ring-1 focus:ring-cyber-blue"
          />
        </div>

        <div>
          <label className="block text-sm font-exo text-gray-300 mb-2">
            Platform
          </label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="w-full px-4 py-2 bg-cyber-dark border border-cyber-blue/30 rounded-md text-white focus:outline-none focus:border-cyber-blue focus:ring-1 focus:ring-cyber-blue"
          >
            <option value="windows">Windows</option>
            <option value="macos">macOS</option>
            <option value="linux">Linux</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-exo text-gray-300 mb-2">
            Version
          </label>
          <input
            type="text"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="e.g., v1.2.3"
            className="w-full px-4 py-2 bg-cyber-dark border border-cyber-blue/30 rounded-md text-white placeholder-gray-500 focus:outline-none focus:border-cyber-blue focus:ring-1 focus:ring-cyber-blue"
          />
        </div>

        <div>
          <label className="block text-sm font-exo text-gray-300 mb-2">
            File
          </label>
          <div className="relative">
            <input
              id="file-input"
              type="file"
              onChange={handleFileChange}
              className="w-full px-4 py-2 bg-cyber-dark border border-cyber-blue/30 rounded-md text-white file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-exo file:bg-cyber-blue file:text-cyber-darker file:cursor-pointer hover:file:bg-cyber-cyan focus:outline-none focus:border-cyber-blue focus:ring-1 focus:ring-cyber-blue"
            />
          </div>
          {file && (
            <p className="mt-2 text-sm text-gray-400 font-exo">
              Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
            </p>
          )}
        </div>

        <motion.button
          onClick={handleUpload}
          disabled={uploading || !toolName || !version || !file}
          whileHover={{ scale: uploading ? 1 : 1.02 }}
          whileTap={{ scale: uploading ? 1 : 0.98 }}
          className="w-full mt-6 flex items-center justify-center gap-2 px-6 py-3 bg-cyber-blue/80 text-cyber-darker font-orbitron font-bold rounded-md transition-all duration-300 hover:bg-cyber-blue disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uploading ? (
            <>
              <Loader className="w-5 h-5 animate-spin" />
              Uploading...
            </>
          ) : uploaded ? (
            <>
              <Check className="w-5 h-5" />
              Uploaded!
            </>
          ) : (
            <>
              <Upload className="w-5 h-5" />
              Upload File
            </>
          )}
        </motion.button>

        <div className="mt-6 p-4 bg-cyber-dark/50 border border-cyber-blue/20 rounded-md">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-cyber-blue flex-shrink-0 mt-0.5" />
            <div className="text-sm text-gray-400 font-exo">
              <p className="font-semibold text-cyber-blue mb-1">Setup Required:</p>
              <p>1. Go to Supabase Dashboard → Storage</p>
              <p>2. Create a bucket named: <code className="text-cyber-cyan">clawnet-downloads</code></p>
              <p>3. Set bucket to public (or configure RLS policies for downloads)</p>
              <p>4. Files will be organized as: <code className="text-cyber-cyan">tool-name/platform/filename</code></p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FileUploader;

