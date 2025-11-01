# ProjectClawNet

**Redefining digital protection through intelligence and automation.**

ProjectClawNet is an advanced cybersecurity platform that provides enterprise-grade security tools, threat intelligence, and a collaborative community hub. Built with modern web technologies, it offers real-time monitoring, secure file management, and a decentralized communication system.

## 🎯 What is ProjectClawNet?

ProjectClawNet is a comprehensive cybersecurity platform designed for security professionals, researchers, and organizations. It provides:

- **Enterprise Security Tools**: PortLock (USB access control), ClawNet Core (off-grid communication), and ClawView (threat visualization)
- **The Grid Community Hub**: A collaborative space for security researchers to share tools, ideas, and intelligence
- **Threat Intelligence**: Research papers and security insights
- **Secure File Management**: Platform-specific tool downloads with Supabase Storage integration

### Elevator Pitch

ProjectClawNet transforms how security teams protect critical infrastructure. By combining cutting-edge tools, real-time intelligence, and a collaborative community, we enable organizations to stay ahead of threats in an ever-evolving cyber landscape.

## 🛠️ Tech Stack

### Frontend

- **React 18** - Modern UI library
- **Vite** - Fast build tool and dev server
- **Framer Motion** - Smooth animations and transitions
- **Tailwind CSS** - Utility-first styling
- **React Router** - Client-side routing

### Backend & Services

- **Supabase** - Backend-as-a-Service
  - PostgreSQL database with Row Level Security (RLS)
  - Authentication & user management
  - Storage for file uploads/downloads
  - Real-time subscriptions

### Third-Party Services

- **Netlify** - Hosting and deployment
- **GitHub** - Version control and CI/CD

## 🏗️ Architecture

### High-Level Flow

```
User → Frontend (React/Vite)
    ↓
    Authentication (Supabase Auth)
    ↓
    ┌─────────────────┬─────────────────┬─────────────────┐
    │                 │                 │                 │
Community Hub    Tool Downloads   Research Papers   Terminal
    │                 │                 │                 │
    ↓                 ↓                 ↓                 ↓
Supabase DB    Supabase Storage   Static Content   Interactive CLI
```

### Key Modules

1. **Authentication System** (`src/contexts/AuthContext.jsx`)

   - User sign up/in with Supabase
   - Session management
   - Protected routes

2. **File Upload System** (`src/utils/fileStorage.js`)

   - Supabase Storage integration
   - Platform-specific file management
   - Download validation

3. **Community Grid** (`src/pages/CommunityHubPage.jsx`)

   - Post creation/editing/deletion
   - Code snippet sharing
   - Upvotes and comments

4. **Terminal Interface** (`src/components/terminal/ClawNetTerminal.jsx`)
   - Interactive command-line interface
   - Custom commands and effects

See [Module Documentation](./docs/) for detailed information on each module.

## 📋 System Requirements

- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher (or yarn/pnpm)
- **Modern Browser**: Chrome, Firefox, Safari, Edge (latest versions)

## 🚀 Quick Start

### Prerequisites

Ensure you have Node.js and npm installed:

```bash
node --version  # Should be v18+
npm --version   # Should be v9+
```

### Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/Jatin-Dhir/ClawNet.git
   cd ClawNet
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**
   Create a `.env` file in the root directory:

   ```env
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

4. **Start development server**

   ```bash
   npm run dev
   ```

5. **Open in browser**
   Navigate to `http://localhost:5173` (or the port shown in terminal)

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint

## 📁 Project Structure

```
ProjectClawNet/
├── src/
│   ├── components/        # React components
│   │   ├── admin/        # Admin components
│   │   ├── auth/         # Authentication
│   │   ├── community/    # Community features
│   │   ├── products/     # Product demos/downloads
│   │   └── terminal/     # Terminal interface
│   ├── contexts/         # React contexts (state management)
│   ├── pages/            # Page components
│   ├── utils/            # Utility functions
│   └── supabaseClient.js # Supabase configuration
├── supabase/
│   └── migrations/       # Database migrations
├── public/               # Static assets
├── docs/                 # Module documentation
└── README.md
```

## 📚 Documentation

- [File Upload Guide](./FILE_UPLOAD_GUIDE.md) - How to upload tool files
- [Deployment Guide](./DEPLOYMENT.md) - Production deployment instructions
- [GitHub Setup](./GITHUB_SETUP.md) - GitHub repository setup
- [Module Documentation](./docs/) - Detailed module documentation
- [Security Guidelines](./SECURITY.md) - Security best practices

## 🤝 Contributing

We welcome contributions! Please follow these guidelines:

### How to Contribute

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes**
   - Follow the code style (ESLint rules)
   - Write clear commit messages
   - Add tests if applicable
4. **Test your changes**
   ```bash
   npm run lint
   npm run build
   ```
5. **Submit a pull request**
   - Describe your changes clearly
   - Reference any related issues

### Code Style

- Use ESLint configuration provided
- Follow React best practices
- Use functional components with hooks
- Keep components small and focused
- Add comments for complex logic

### Reporting Bugs

Please open an issue with:

- Clear description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS information
- Screenshots if applicable

### Feature Requests

Open an issue with:

- Clear description of the feature
- Use case/justification
- Proposed implementation (if applicable)

## 🔒 Security

Security is paramount. Please review our [Security Guidelines](./SECURITY.md) before contributing.

### Important Security Notes

- Never commit secrets or API keys
- Always use environment variables for sensitive data
- Validate and sanitize all user inputs
- Follow the principle of least privilege
- Report security vulnerabilities responsibly

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## 🌐 Deployment

The application is deployed at: **https://projectclawnet.online**

For deployment instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## 📞 Contact

- **Email**: contact@projectclawnet.online
- **Website**: https://projectclawnet.online
- **GitHub**: https://github.com/Jatin-Dhir/ClawNet

## 🙏 Acknowledgments

Built with ❤️ by the ProjectClawNet team.

---

**© 2025 ClawNet Labs — Intelligence Unleashed.**
