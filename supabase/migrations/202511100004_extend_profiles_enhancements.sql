-- Ensure extended profile metadata exists for profile customization features
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists banner_url text;
alter table public.profiles add column if not exists location text;
alter table public.profiles add column if not exists website text;
alter table public.profiles add column if not exists pronouns text;
alter table public.profiles add column if not exists xp integer default 0;
alter table public.profiles add column if not exists badges jsonb default '[]'::jsonb;
alter table public.profiles add column if not exists reputation integer default 0;
alter table public.profiles add column if not exists preferences jsonb default '{}'::jsonb;
alter table public.profiles add column if not exists badge_showcase_order jsonb default '[]'::jsonb;

comment on column public.profiles.preferences is 'Operative notification and interface preferences';
comment on column public.profiles.badge_showcase_order is 'Ordered array of badge slugs highlighted in the profile spotlight';

update public.profiles
set
  preferences = coalesce(preferences, '{}'::jsonb),
  badge_showcase_order = coalesce(badge_showcase_order, '[]'::jsonb);

