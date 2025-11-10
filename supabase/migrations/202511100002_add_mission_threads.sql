-- Table: mission_threads
create table if not exists public.mission_threads (
    id uuid primary key default gen_random_uuid(),
    mission_id uuid not null references public.missions_featured(id) on delete cascade,
    title text not null,
    summary text,
    status text,
    last_activity_at timestamptz default now(),
    is_locked boolean default false,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    created_by uuid
);

create trigger mission_threads_updated_at
before update on public.mission_threads
for each row
execute procedure supabase_functions.update_updated_at_column();

-- Table: mission_posts
create table if not exists public.mission_posts (
    id uuid primary key default gen_random_uuid(),
    thread_id uuid not null references public.mission_threads(id) on delete cascade,
    parent_id uuid references public.mission_posts(id) on delete cascade,
    body text not null,
    attachment_url text,
    status text default 'visible',
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    created_by uuid
);

create trigger mission_posts_updated_at
before update on public.mission_posts
for each row
execute procedure supabase_functions.update_updated_at_column();

-- Maintain last activity timestamp when posts are created
create or replace function public.set_thread_last_activity()
returns trigger as $$
begin
  update public.mission_threads
  set last_activity_at = now()
  where id = NEW.thread_id;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger mission_posts_activity
after insert on public.mission_posts
for each row execute procedure public.set_thread_last_activity();

-- Seed curated threads aligned with existing missions
insert into public.mission_threads (mission_id, title, summary, status, created_by, is_locked)
select id, 'Beacon Hunt • Thread', 'Weekly ops focusing on beacon detection hardening. Share telemetry packs, Sigma rules, and mitigation playbooks.', 'Live – ends in 6d', null, false
from public.missions_featured
where slug = 'grid-challenge-07'
on conflict do nothing;

insert into public.mission_threads (mission_id, title, summary, status, created_by, is_locked)
select id, 'Vault Intrusion Ops • Thread', 'Seasonal simulation thread. Coordinate offensive / defensive cells, document Specter token extraction strategies.', 'Invite only', null, true
from public.missions_featured
where slug = 'vault-intrusion'
on conflict do nothing;

insert into public.mission_threads (mission_id, title, summary, status, created_by, is_locked)
select id, 'Signal Decode Sprint • Thread', 'Daily anomaly decoding stand-up. Drop classifier insights, ML feature tweaks, and remediation snippets.', 'Resets 24h', null, false
from public.missions_featured
where slug = 'signal-decode-sprint'
on conflict do nothing;

-- Seed starter posts
insert into public.mission_posts (thread_id, body, created_by, attachment_url)
select
  mt.id,
  'Telemetry pack uploaded to the shared bucket. Beacon rotates ports every 11 minutes – match on entropy spikes rather than static IOC.',
  null,
  null
from public.mission_threads mt
join public.missions_featured mf on mf.id = mt.mission_id
where mf.slug = 'grid-challenge-07'
and not exists (
  select 1 from public.mission_posts mp where mp.thread_id = mt.id
);

insert into public.mission_posts (thread_id, body, created_by, attachment_url)
select
  mt.id,
  'Latest anomaly bundle flagged DNS over HTTPS pivot. Added feature weighting to highlight anomalous JA3 fingerprints.',
  null,
  null
from public.mission_threads mt
join public.missions_featured mf on mf.id = mt.mission_id
where mf.slug = 'signal-decode-sprint'
and not exists (
  select 1 from public.mission_posts mp where mp.thread_id = mt.id
);

insert into public.mission_posts (thread_id, body, created_by, attachment_url)
select
  mt.id,
  'Offensive cell Alpha reporting successful lateral chain using patched JuicyPotato exploit. Token located in memory snapshot #14.',
  null,
  null
from public.mission_threads mt
join public.missions_featured mf on mf.id = mt.mission_id
where mf.slug = 'vault-intrusion'
and not exists (
  select 1 from public.mission_posts mp where mp.thread_id = mt.id
);

