# Technical Notes

## Languages

- JavaScript (ESNext + JSX) for React SPA logic.
- CSS/Tailwind utility classes for layout, theming, and responsiveness.
- SQL for Supabase/PostgreSQL migrations in `supabase/migrations/`.
- JSON/YAML-style configs driving tooling (`package.json`, `tailwind.config.js`, `netlify.toml`, `vercel.json`).

## Frontend Stack (`src/`)

- React 18 with functional components, hooks, and context state (`AuthContext.jsx`).
- Vite 7 as dev server/build orchestrator (`vite.config.js`).
- React Router v7 handling routes (`App.jsx`, `pages/`).
- Framer Motion powering hero sequences, modals, and scroll-triggered animations.
- Tailwind CSS customized via `tailwind.config.js` and `src/index.css`.
- Iconography: `lucide-react`.
- Notifications: `react-hot-toast`.

## Modules & Components

- Landing flow composed of `Hero`, `About`, `TeamPreview`, `Products`, `Blog`, `Stats`, `CommunityIntro`.
- Product demos (`ClawNetCoreDemo.jsx`, `ClawViewDemo.jsx`, `PortlockDemo.jsx`) animate SVGs and status indicators.
- Community Grid (`docs/COMMUNITY_GRID_MODULE.md`, `src/components/community/*`) manages posts, comments, upvotes, and moderation with Supabase subscriptions.
- Admin dashboard (`src/pages/AdminDashboard.jsx`) splits functionality into Overview, Moderation, Users, Analytics, Settings.
- Terminal (`ClawNetTerminal.jsx`) exposes interactive commands and themed transitions.

## Backend-as-a-Service: Supabase

- `supabaseClient.js` instantiates Supabase with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- PostgreSQL tables defined via migrations for posts, comments, upvotes, analytics, service requests, admin actions, download stats, banned users, flagged content.
- Auth: email/password with verification redirect to `/hub`; session state managed by `AuthContext`.
- Storage: `src/utils/fileStorage.js` handles uploads, signed URLs, and deletions in `clawnet-downloads` bucket.
- Security utilities in `src/utils/security.js` sanitize inputs and enforce constraints.

## Tooling & Quality

- ESLint (`eslint.config.js`) with React, Hooks, and React Refresh plugins.
- Prettier configuration `.prettierrc.json`; scripts for `format` and `format:check`.
- Husky git hooks bootstrapped via `npm run prepare`.
- NPM scripts: `dev`, `build`, `preview`, `lint`, `lint:fix`, `format`, `security:audit`.
- Tests pending (`npm run test` placeholder exiting successfully for CI continuity).

## Deployment & Infrastructure

- Netlify primary host (`netlify.toml` defines redirects, headers, CSP).
- Alternate Vercel configuration (`vercel.json`).
- Production assets generated in `dist/` (Vite build output, bundled JS/CSS, sitemap, robots).
- Environment variables supplied per environment (development and production).

## Security Considerations

- CSP hardened (no `unsafe-eval`), strict script-src definitions.
- Input validation across forms (email, URLs, passwords).
- Rate limiting for auth flows; RLS policies across all Supabase tables.
- Storage downloads delivered via short-lived signed URLs; file type/size validation for uploads.
- Admin actions logged to `admin_actions` for full audit trail; banned users and admin roles stored in dedicated tables.

## Ecosystem & Future Enhancements

- Supporting docs: `AUTH_MODULE.md`, `FILE_UPLOAD_MODULE.md`, `EMAIL_VERIFICATION_SETUP.md`, `SEO_SETUP.md`, `SECURITY.md`.
- Tools/clawview desktop artifacts under `tools/clawview/`.
- Planned upgrades: social/OAuth login, 2FA, markdown-rich posts, image uploads, virus scanning before storage, CDN-backed download distribution, automated test harness.



