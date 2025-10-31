/*
# [Community Hub Schema Creation]
This script sets up the necessary tables and security policies for the ClawNet Community Hub. It corrects a previous typo and adds robust features.

## Query Description: 
This operation will create new tables for user profiles, posts, comments, and upvotes. It also configures Row Level Security to ensure users can only manage their own data. This is a structural change and is safe to run on a new setup. No existing data will be affected.

## Metadata:
- Schema-Category: "Structural"
- Impact-Level: "Low"
- Requires-Backup: false
- Reversible: true (by dropping tables)

## Structure Details:
- Tables created: public.profiles, public.posts, public.comments, public.upvotes
- Columns: Defines structure for user profiles, community posts, comments, and voting.
- Foreign Keys: Links posts, comments, and upvotes to user profiles.
- Triggers: Adds a trigger to automatically create a user profile when a new user signs up in Supabase Auth.

## Security Implications:
- RLS Status: Enabled on all new tables.
- Policy Changes: Yes, new policies are created to restrict data access.
- Auth Requirements: Policies are tied to `auth.uid()`, integrating with Supabase Authentication.

## Performance Impact:
- Indexes: Primary and foreign key indexes are automatically created.
- Triggers: A single trigger is added to the `auth.users` table.
- Estimated Impact: Low impact on a new system.
*/

-- 1. PROFILES TABLE
-- Stores public user data, linked to authentication.
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  reputation INT DEFAULT 0,
  CONSTRAINT username_length CHECK (char_length(username) >= 3)
);
COMMENT ON TABLE public.profiles IS 'Public user profiles, linked to Supabase auth users.';

-- 2. POSTS TABLE
-- Stores community posts (tools, discussions, etc.).
CREATE TABLE public.posts (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT NOT NULL,
  link TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE public.posts IS 'Community posts, such as tools and discussions.';

-- 3. COMMENTS TABLE
-- Stores comments on posts.
CREATE TABLE public.comments (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  post_id BIGINT NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE public.comments IS 'Comments made by users on posts.';

-- 4. UPVOTES TABLE
-- Tracks user upvotes on posts.
CREATE TABLE public.upvotes (
  post_id BIGINT NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
COMMENT ON TABLE public.upvotes IS 'Tracks which user has upvoted which post.';


-- 5. ROW LEVEL SECURITY (RLS)
-- Enable RLS for all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upvotes ENABLE ROW LEVEL SECURITY;

-- RLS Policies for profiles
CREATE POLICY "Public profiles are viewable by everyone." ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users can insert their own profile." ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update their own profile." ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- RLS Policies for posts
CREATE POLICY "Posts are viewable by everyone." ON public.posts FOR SELECT USING (true);
CREATE POLICY "Users can insert their own posts." ON public.posts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own posts." ON public.posts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own posts." ON public.posts FOR DELETE USING (auth.uid() = user_id);

-- RLS Policies for comments
CREATE POLICY "Comments are viewable by everyone." ON public.comments FOR SELECT USING (true);
CREATE POLICY "Users can insert their own comments." ON public.comments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own comments." ON public.comments FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own comments." ON public.comments FOR DELETE USING (auth.uid() = user_id);

-- RLS Policies for upvotes
CREATE POLICY "Upvotes are viewable by everyone." ON public.upvotes FOR SELECT USING (true);
CREATE POLICY "Users can insert/delete their own upvotes." ON public.upvotes FOR ALL USING (auth.uid() = user_id);

-- 6. AUTOMATIC PROFILE CREATION
-- Function and Trigger to create a profile when a new user signs up.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (new.id, new.raw_user_meta_data->>'username');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to execute the function on new user creation
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 7. TIMESTAMP UPDATES
-- Function to update 'updated_at' column
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for 'updated_at'
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE PROCEDURE public.update_updated_at_column();

CREATE TRIGGER update_posts_updated_at
  BEFORE UPDATE ON public.posts
  FOR EACH ROW
  EXECUTE PROCEDURE public.update_updated_at_column();
