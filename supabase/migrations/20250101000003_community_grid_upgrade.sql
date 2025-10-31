/*
# [Operation Name]
Community Hub "The Grid" Feature Upgrade

## Query Description: [This script upgrades the 'posts' table to support new community features. It adds a column for code snippets and implements Row Level Security (RLS) policies to allow users to edit and delete their own posts. This operation is non-destructive to existing data but adds new capabilities and security rules.]

## Metadata:
- Schema-Category: ["Structural", "Safe"]
- Impact-Level: ["Low"]
- Requires-Backup: false
- Reversible: true

## Structure Details:
- Adds column `code_snippet` (text) to `public.posts`.
- Creates `UPDATE` policy on `public.posts` for post owners.
- Creates `DELETE` policy on `public.posts` for post owners.

## Security Implications:
- RLS Status: Enabled
- Policy Changes: Yes. Adds policies to allow users to manage their own content, which is a standard and safe practice.
- Auth Requirements: Users must be authenticated to edit or delete their own posts.

## Performance Impact:
- Indexes: None
- Triggers: None
- Estimated Impact: Negligible performance impact.
*/

-- Add a column to store code snippets in posts
ALTER TABLE public.posts
ADD COLUMN IF NOT EXISTS code_snippet TEXT;

-- Add a policy to allow users to UPDATE their own posts
CREATE POLICY "Allow individual update access"
ON public.posts
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add a policy to allow users to DELETE their own posts
CREATE POLICY "Allow individual delete access"
ON public.posts
FOR DELETE
USING (auth.uid() = user_id);
