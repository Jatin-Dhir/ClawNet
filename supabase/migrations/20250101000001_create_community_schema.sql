/*
          # [Operation Name]
          Create Community Hub Schema

          [This script establishes the database structure for the ClawNet Community Hub. It creates tables for user profiles, posts, and comments, and sets up security policies to ensure data integrity and proper user access.]

          ## Query Description: [This operation will create new tables and enable Row Level Security (RLS) to support a full-featured community platform. It is designed to integrate with Supabase Authentication. No existing data will be lost as this only adds new structures. It is safe to run on your existing project.]
          
          ## Metadata:
          - Schema-Category: ["Structural"]
          - Impact-Level: ["Low"]
          - Requires-Backup: [false]
          - Reversible: [false]
          
          ## Structure Details:
          - Tables Created: `profiles`, `posts`, `post_types` (enum), `comments`
          - Triggers Created: `on_auth_user_created` to automatically create user profiles.
          - RLS Policies: Policies for SELECT, INSERT, UPDATE, DELETE on all new tables.
          
          ## Security Implications:
          - RLS Status: [Enabled]
          - Policy Changes: [Yes]
          - Auth Requirements: [Integrates with Supabase Auth (`auth.users`)]
          
          ## Performance Impact:
          - Indexes: [Primary keys and foreign keys are indexed by default.]
          - Triggers: [Adds one trigger on user creation.]
          - Estimated Impact: [Low performance impact. The structure is optimized for common community platform queries.]
          */

-- 1. Create Profiles Table
-- This table stores public user data, extending the built-in auth.users table.
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  avatar_url TEXT,
  reputation INT DEFAULT 0 NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  
  CONSTRAINT username_length CHECK (char_length(username) >= 3)
);
COMMENT ON TABLE public.profiles IS 'Public profile information for each user.';

-- 2. Create Post Type Enum
-- Defines the categories for community posts.
CREATE TYPE public.post_type AS ENUM ('Tool', 'Discussion', 'Research');

-- 3. Create Posts Table
-- This table stores all community posts, such as tools and discussions.
CREATE TABLE public.posts (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  link TEXT,
  tags TEXT[],
  type public.post_type NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
COMMENT ON TABLE public.posts IS 'Stores all posts created by users in the community hub.';

-- 4. Create Comments Table
-- This table stores comments made by users on posts.
CREATE TABLE public.comments (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  post_id BIGINT NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
COMMENT ON TABLE public.comments IS 'Stores comments on posts.';

-- 5. Create Profile Trigger
-- This function automatically creates a user profile when a new user signs up.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (new.id, new.raw_user_meta_data->>'username');
  RETURN new;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 6. Enable Row Level Security (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

-- 7. Create RLS Policies for Profiles
CREATE POLICY "Public profiles are viewable by everyone."
  ON public.profiles FOR SELECT
  USING ( true );

CREATE POLICY "Users can insert their own profile."
  ON public.profiles FOR INSERT
  WITH CHECK ( auth.uid() = id );

CREATE POLICY "Users can update their own profile."
  ON publicprofiles FOR UPDATE
  USING ( auth.uid() = id );

-- 8. Create RLS Policies for Posts
CREATE POLICY "Posts are viewable by everyone."
  ON public.posts FOR SELECT
  USING ( true );

CREATE POLICY "Users can create posts."
  ON public.posts FOR INSERT
  WITH CHECK ( auth.uid() = user_id );

CREATE POLICY "Users can update their own posts."
  ON public.posts FOR UPDATE
  USING ( auth.uid() = user_id );

CREATE POLICY "Users can delete their own posts."
  ON public.posts FOR DELETE
  USING ( auth.uid() = user_id );

-- 9. Create RLS Policies for Comments
CREATE POLICY "Comments are viewable by everyone."
  ON public.comments FOR SELECT
  USING ( true );

CREATE POLICY "Users can create comments."
  ON public.comments FOR INSERT
  WITH CHECK ( auth.uid() = user_id );

CREATE POLICY "Users can update their own comments."
  ON public.comments FOR UPDATE
  USING ( auth.uid() = user_id );

CREATE POLICY "Users can delete their own comments."
  ON public.comments FOR DELETE
  USING ( auth.uid() = user_id );
