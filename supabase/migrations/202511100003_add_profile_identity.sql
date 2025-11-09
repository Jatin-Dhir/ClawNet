-- Ensure profiles table matches new identity fields
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS pronouns TEXT,
  ADD COLUMN IF NOT EXISTS banner_url TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS badges JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0 NOT NULL;

-- Update trigger to backfill display name when creating from auth metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  username TEXT;
  display_name TEXT;
BEGIN
  username := COALESCE(
    new.raw_user_meta_data->>'username',
    new.raw_user_meta_data->>'user_name',
    split_part(new.email, '@', 1),
    'user-' || LEFT(new.id::TEXT, 6)
  );

  display_name := COALESCE(
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'name',
    initcap(split_part(new.email, '@', 1)),
    username
  );

  INSERT INTO public.profiles (id, username, display_name, avatar_url)
  VALUES (new.id, username, display_name, new.raw_user_meta_data->>'avatar_url')
  ON CONFLICT (id) DO NOTHING;

  RETURN new;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS 'Ensures a profile row is created when a new auth user signs up, populating username/display name.';

