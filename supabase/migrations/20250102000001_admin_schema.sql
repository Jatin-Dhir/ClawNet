-- Admin Schema for ProjectClawNet
-- This creates tables for tracking analytics, user activity, service requests, and admin operations

-- 1. ADMIN USERS TABLE
-- Track which users have admin privileges
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_profiles_is_admin ON public.profiles(is_admin);

-- 2. ANALYTICS TABLE
-- Track page views, downloads, and other metrics
CREATE TABLE IF NOT EXISTS public.analytics (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL, -- 'page_view', 'download', 'service_view', etc.
  entity_type TEXT, -- 'user', 'post', 'tool', 'service'
  entity_id TEXT, -- ID of the entity
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  metadata JSONB, -- Additional event data
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_analytics_event_type ON public.analytics(event_type);
CREATE INDEX idx_analytics_created_at ON public.analytics(created_at);
CREATE INDEX idx_analytics_user_id ON public.analytics(user_id);

COMMENT ON TABLE public.analytics IS 'Tracks user interactions and events across the platform';

-- 3. SERVICE REQUESTS TABLE
-- Track service consultation requests
CREATE TABLE IF NOT EXISTS public.service_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL,
  service_type TEXT NOT NULL, -- 'vapt', 'web-application-security', etc.
  service_name TEXT NOT NULL,
  message TEXT,
  status TEXT DEFAULT 'pending', -- 'pending', 'contacted', 'in_progress', 'completed'
  admin_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_service_requests_status ON public.service_requests(status);
CREATE INDEX idx_service_requests_service_type ON public.service_requests(service_type);
CREATE INDEX idx_service_requests_created_at ON public.service_requests(created_at);

COMMENT ON TABLE public.service_requests IS 'Tracks service consultation requests from clients';

-- 4. ADMIN ACTIONS LOG
-- Track all admin actions for audit trail
CREATE TABLE IF NOT EXISTS public.admin_actions (
  id BIGSERIAL PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL, -- 'delete_post', 'ban_user', 'update_config', etc.
  target_type TEXT NOT NULL, -- 'post', 'user', 'comment', etc.
  target_id TEXT NOT NULL,
  details JSONB, -- Additional action details
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_admin_actions_admin_id ON public.admin_actions(admin_id);
CREATE INDEX idx_admin_actions_created_at ON public.admin_actions(created_at);
CREATE INDEX idx_admin_actions_action_type ON public.admin_actions(action_type);

COMMENT ON TABLE public.admin_actions IS 'Audit log of all admin actions';

-- 5. DOWNLOAD STATS TABLE
-- Track tool downloads
CREATE TABLE IF NOT EXISTS public.download_stats (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  platform TEXT NOT NULL, -- 'windows', 'macos', 'linux'
  version TEXT,
  file_path TEXT NOT NULL,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_download_stats_tool_name ON public.download_stats(tool_name);
CREATE INDEX idx_download_stats_created_at ON public.download_stats(created_at);
CREATE INDEX idx_download_stats_user_id ON public.download_stats(user_id);

COMMENT ON TABLE public.download_stats IS 'Tracks all tool downloads';

-- 6. BANNED USERS TABLE
-- Track banned users
CREATE TABLE IF NOT EXISTS public.banned_users (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  admin_id UUID NOT NULL REFERENCES public.profiles(id),
  reason TEXT,
  banned_at TIMESTAMPTZ DEFAULT NOW(),
  unbanned_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(user_id)
);

CREATE INDEX idx_banned_users_user_id ON public.banned_users(user_id);
CREATE INDEX idx_banned_users_admin_id ON public.banned_users(admin_id);
CREATE INDEX idx_banned_users_is_active ON public.banned_users(is_active);

COMMENT ON TABLE public.banned_users IS 'Tracks banned users and ban history';

-- Enable RLS
ALTER TABLE public.analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.download_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banned_users ENABLE ROW LEVEL SECURITY;

-- RLS Policies for analytics
CREATE POLICY "Analytics are viewable by all" ON public.analytics FOR SELECT USING (true);
CREATE POLICY "Anyone can insert analytics" ON public.analytics FOR INSERT WITH CHECK (true);
CREATE POLICY "Admins can delete analytics" ON public.analytics FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- RLS Policies for service_requests
CREATE POLICY "Service requests are viewable by creators and admins" ON public.service_requests FOR SELECT USING (
  auth.uid() = user_id OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);
CREATE POLICY "Anyone can create service requests" ON public.service_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "Admins can update service requests" ON public.service_requests FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- RLS Policies for admin_actions
CREATE POLICY "Admin actions are viewable by admins only" ON public.admin_actions FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);
CREATE POLICY "Admins can insert actions" ON public.admin_actions FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- RLS Policies for download_stats
CREATE POLICY "Download stats are viewable by all" ON public.download_stats FOR SELECT USING (true);
CREATE POLICY "Anyone can track downloads" ON public.download_stats FOR INSERT WITH CHECK (true);
CREATE POLICY "Admins can delete download stats" ON public.download_stats FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- RLS Policies for banned_users
CREATE POLICY "Banned users are viewable by admins" ON public.banned_users FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);
CREATE POLICY "Admins can insert banned users" ON public.banned_users FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);
CREATE POLICY "Admins can update banned users" ON public.banned_users FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = TRUE)
);

-- Function to update updated_at
CREATE OR REPLACE FUNCTION update_service_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_service_requests_updated_at
  BEFORE UPDATE ON public.service_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_service_requests_updated_at();

