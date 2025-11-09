-- Create missions_featured table for admin-managed mission slots
create table if not exists public.missions_featured (
    id uuid primary key default gen_random_uuid(),
    slot_type text not null check (slot_type in ('seasonal', 'weekly', 'daily', 'quick')),
    slot_position integer default 1 check (slot_position between 1 and 3),
    title text not null,
    slug text not null unique,
    band text,
    difficulty text,
    difficulty_color text,
    accent_glow text,
    status text,
    deadline timestamptz,
    category text,
    summary text,
    cover_image_url text,
    objectives jsonb default '[]'::jsonb,
    requirements jsonb default '[]'::jsonb,
    rewards_xp integer default 0,
    rewards_badge text,
    rewards_bonus text,
    hints jsonb default '[]'::jsonb,
    is_active boolean default true,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    updated_by uuid
);

create unique index missions_featured_unique_slot
on public.missions_featured (slot_type, slot_position)
where slot_type = 'quick';

create unique index missions_featured_unique_primary_slot
on public.missions_featured (slot_type)
where slot_type in ('seasonal', 'weekly', 'daily');

create trigger missions_featured_updated_at
before update on public.missions_featured
for each row
execute procedure supabase_functions.update_updated_at_column();

-- Seed initial missions to match current UI
insert into public.missions_featured
    (slot_type, slot_position, title, slug, band, difficulty, difficulty_color, accent_glow, status, deadline, category, summary,
     objectives, requirements, rewards_xp, rewards_badge, rewards_bonus, hints, cover_image_url)
values
    ('seasonal', 1, 'Vault Intrusion Ops', 'vault-intrusion', 'Seasonal Brief', 'Expert', '#ff6b6b', '#ff6b6b', 'Invite Only • Ends in 22d',
     '2025-12-01T23:59:59Z', 'Core Operation',
     'Collaborate with another team to simulate a full intrusion of the ClawNet Vault environment. Capture the hidden credential cache before the defenders shut you down.',
     '["Form a two-person cell and request attack surface brief.","Stage a lateral movement chain within 45 minutes.","Extract the “Specter” token and publish a sanitized after-action."]'::jsonb,
     '["Invite from a current mission lead or maintain 1,000+ Grid reputation.","Ability to operate both offensive and defensive tooling.","Strict adherence to the ClawNet simulation charter."]'::jsonb,
     600, 'Vault Specter', 'Access to closed beta tooling',
     '["The target environment resets hourly — document everything.","Watch for deceptive traps; defenders seeded fake creds in memory."]'::jsonb,
     null),
    ('weekly', 1, 'Beacon Hunt', 'grid-challenge-07', 'Weekly Assignment', 'Advanced', '#00e0ff', '#00e0ff', 'Live • Ends in 6d',
     '2025-11-15T23:59:59Z', 'Core Operation',
     'Track and neutralize a covert data exfiltration channel seeded inside the Community Grid. You will need to combine log sleuthing with payload analysis to find the embedded key.',
     '["Locate the hidden beacon signal embedded inside the community hub assets.","Reverse-engineer the obfuscated payload and extract the command sequence.","Publish a mitigation playbook for the community."]'::jsonb,
     '["Proficiency with traffic analysis (Wireshark, Zeek, or similar).","Understanding of modern steganography and encoding schemes.","Ability to document findings in the Grid with reproducible steps."]'::jsonb,
     400, 'Signal Interceptor', 'Private red-team drill invite',
     '["The beacon cycles every 11 minutes — watch for repeating entropy spikes.","Payload fragments append to legitimate asset requests; compare checksums."]'::jsonb,
     null),
    ('daily', 1, 'Signal Decode Sprint', 'signal-decode-sprint', 'Daily Run', 'Intermediate', '#00f5ff', '#00f5ff', 'Resets 24h',
     '2025-11-10T12:00:00Z', 'Core Operation',
     'Decode the latest ClawView anomaly bundle and classify the threat category. Your report feeds the production ML model used in ClawNet Core deployments.',
     '["Download the anomaly bundle from the missions repo.","Classify the attacker TTP based on traffic shape and metadata.","Submit a remediation snippet compatible with ClawView playbooks."]'::jsonb,
     '["Familiarity with MITRE ATT&CK mapping.","Ability to craft concise SOC recommendations.","Optional: experience with sigma/kql detection formats."]'::jsonb,
     250, 'Pattern Decoder', 'Featured slot in community briefing',
     '["Look for privilege escalation attempts disguised as analytics jobs.","Remember to normalize timestamps before running correlation pivot."]'::jsonb,
     null),
    ('quick', 1, 'Arcade Probe', 'arcade-probe', 'Weekend Warmup', 'Beginner', '#7c3aed', '#7c3aed', 'Live • Ends in 2d',
     '2025-11-11T18:00:00Z', 'Quick Task',
     'Trace the noisy credential stuffing wave hitting our arcade endpoints. Correlate IP clusters and recommend mitigation tiers.',
     '["Pull the weekend logs from the ClawNet Arcade proxy.","Group offending IPs by ASN and reputation.","Draft tiered rate-limit guidance for deployment."]'::jsonb,
     '["Comfort with log parsing (jq, pandas, or similar).","Ability to summarize findings clearly for engineers.","Understand basic credential stuffing behaviors."]'::jsonb,
     140, 'Arcade Sentinel', 'Invite to weekend anomaly debrief',
     '["Look for repeated user-agents that mimic outdated browsers.","ASN 20473 has several nodes rotating credentials every 8 minutes."]'::jsonb,
     null),
    ('quick', 2, 'Artifact Trace', 'artifact-trace', 'Quick Task', 'Beginner', '#14b8a6', '#14b8a6', 'Live • Ends in 12h',
     '2025-11-10T00:00:00Z', 'Quick Task',
     'Identify which community upload introduced the rogue DLL artefact last night and notify the submitter with remediation steps.',
     '["Review the last 24h of uploads in the sandbox queue.","Hash the rogue DLL and cross-reference the artifact cache.","Prepare a remediation note the submitter can follow."]'::jsonb,
     '["Basic familiarity with hashing tools.","Ability to write concise remediation instructions.","Comfort with Git or asset history tools."]'::jsonb,
     120, 'Artifact Analyst', 'Fast-track to Grid analyst interviews',
     '["The rogue DLL was bundled inside a compressed evidence pack.","Only uploads tagged with “sandbox-staging” need inspection."]'::jsonb,
     null),
    ('quick', 3, 'Perimeter Pulse', 'perimeter-pulse', 'Baseline Check', 'Beginner', '#f97316', '#f97316', 'Live • Ends in 18h',
     '2025-11-10T06:00:00Z', 'Quick Task',
     'Scan the community perimeter sensors for misconfigured TLS endpoints and raise tickets for the owners.',
     '["Pull the latest TLS scan results from the telemetry dashboard.","Flag endpoints with weak cipher suites or expired certificates.","Draft communication for each affected project lead."]'::jsonb,
     '["Knowledge of TLS versions and cipher strength basics.","Comfort creating tickets in the Grid issue system.","Attention to detail when validating hostnames."]'::jsonb,
     160, 'Pulse Responder', 'Priority access to infra hardening workshops',
     '["Pay attention to endpoints still advertising TLS 1.0.","Expired certificates cluster around the “legacy-tools” subdomain."]'::jsonb,
     null);

