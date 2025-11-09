# Developer Notes

## Origin Story & Mission

- Sparked as a perimeter-defense assignment in the PCTE labs, ClawNet matured into a production-grade platform through nightly scrums, mentor-led architecture reviews, and telemetry from early adopters.
- Mission: merge automation, human judgment, and real-world attack data so organizations stay resilient against persistent threats.
- Ethos shaped by faculty governance councils that still stress-test releases, ensuring the platform aligns with enterprise and regulatory expectations.

## Problem & Solution

- Fragmented tooling, reactive postures, and siloed knowledge left defenders behind adversaries.
- ClawNet responds with an integrated ecosystem:
  - PortLock for USB/device control.
  - ClawNet Core for encrypted mesh communications.
  - ClawView for network telemetry and threat visualization.
  - Community Grid Hub for moderated collaboration and intelligence sharing.
- Result: proactive detection, shared playbooks, and unified command surfaces for analysts and mentors.

## Services, Community & Governance

- Six managed service lines: VAPT, Web Application Security, Network Security, Cloud Security Review, Incident Response, Custom Solutions.
- Delivery cadence blends architecture audits, manual testing, remediation guidance, and executive-ready reporting.
- Community Grid offers posts, code snippets, upvotes, comments, and reporting; backed by Supabase RLS and moderation workflows.
- Admin dashboard centralizes oversight with tabs for Overview, Moderation, Users, Analytics, and Settings; all actions logged to `admin_actions`.

## Architecture & Experience

- SPA driven by `App.jsx`, routing visitors across landing, hub, services, research, tools, admin, and about experiences.
- `Layout` integrates `Navbar`, animated `ParticleBackground`, `Footer`, and the reactive `ClawNetTerminal` (Ctrl+` shortcut).
- Dedicated About page chronicles the PCTE origin story, mentor council, and mission pillars.
- Products module showcases PortLock, ClawNet Core, and ClawView with animated demos and deep-linking detail pages.

## Security & Compliance

- Supabase credentials sourced from environment variables; build halts if missing.
- Content Security Policy tightened via `netlify.toml`; inputs sanitized; rate limiting applied to forms.
- Storage uploads validate file type/size and serve through signed URLs; download telemetry captured in analytics tables.
- Admin tooling enforces audit trails, reputation management, and bulk moderation with RLS-backed safeguards.

## Deployment Footprint

- Primary deployment flows through Netlify (`netlify.toml`), with optional Vercel config.
- Release pipeline: `npm run build` (Vite) → deploy; environment variables for Supabase set per environment.
- Documentation suite: `docs/` (module deep-dives), `FILE_UPLOAD_GUIDE.md`, `EMAIL_VERIFICATION_SETUP.md`, `SECURITY.md`, and `FEATURE_UPDATES.md`.

## Future Trajectory

- Roadmap targets richer markdown/rich-text posts, media uploads, social login, 2FA, virus scanning, CDN acceleration, and expanded analytics dashboards.
- Community telemetry lays groundwork for model-assisted threat detection and collaborative research initiatives.



