# Community Grid Module Documentation

## Overview

The Community Grid (also known as "The Grid") is a collaborative hub where security professionals can share tools, ideas, code snippets, and engage in discussions.

## Location

- **Main Page**: `src/pages/CommunityHubPage.jsx`
- **Post Display**: `src/components/community/PostCard.jsx`
- **Post Creation**: `src/components/community/PostForm.jsx`
- **Database**: Supabase PostgreSQL

## Architecture

```
Community Hub Page
    ↓
Post List (Filtered by Category)
    ↓
PostCard Components
    ├── Post Content
    ├── Code Snippets
    ├── Edit/Delete Actions
    └── Comments & Upvotes
```

## Key Features

1. **Post Management**

   - Create posts with title, content, code snippets
   - Edit your own posts
   - Delete your own posts
   - Category filtering (All, Discussion, Tools Showcase, Research)

2. **Code Sharing**

   - Syntax-highlighted code snippets
   - Collapsible code sections
   - Multiple code blocks per post

3. **Engagement**

   - Upvote posts
   - Comment on posts
   - View post author and timestamp

4. **Real-time Updates**
   - Supabase real-time subscriptions
   - Automatic UI updates

## Usage

### Viewing Posts

Posts are automatically fetched and displayed:

```jsx
import CommunityHubPage from './pages/CommunityHubPage';

// Accessible at /hub route
<Route path="hub" element={<CommunityHubPage />} />;
```

### Creating a Post

```jsx
const handleCreatePost = async postData => {
  const { data, error } = await supabase.from('posts').insert([
    {
      user_id: session.user.id,
      title: postData.title,
      content: postData.content,
      category: postData.category,
      code_snippet: postData.codeSnippet,
      tags: postData.tags,
    },
  ]);
};
```

### Editing a Post

```jsx
const handleEditPost = async (postId, updatedData) => {
  const { error } = await supabase
    .from('posts')
    .update(updatedData)
    .eq('id', postId)
    .eq('user_id', session.user.id); // Only owner can edit
};
```

## Database Schema

### Posts Table

```sql
CREATE TABLE posts (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id UUID NOT NULL REFERENCES profiles(id),
  title TEXT NOT NULL,
  content TEXT,
  category TEXT NOT NULL,
  link TEXT,
  tags TEXT[],
  code_snippet TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Comments Table

```sql
CREATE TABLE comments (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  post_id BIGINT NOT NULL REFERENCES posts(id),
  user_id UUID NOT NULL REFERENCES profiles(id),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Upvotes Table

```sql
CREATE TABLE upvotes (
  post_id BIGINT NOT NULL REFERENCES posts(id),
  user_id UUID NOT NULL REFERENCES profiles(id),
  PRIMARY KEY (post_id, user_id)
);
```

## API Endpoints

All operations use Supabase client:

### Read Posts

```javascript
const { data, error } = await supabase
  .from('posts')
  .select('*, profiles(username), comments(count), upvotes(count)')
  .order('created_at', { ascending: false });
```

### Create Post

```javascript
const { data, error } = await supabase.from('posts').insert([
  {
    user_id: userId,
    title: 'My Security Tool',
    content: 'Description...',
    category: 'tools-showcase',
    code_snippet: 'function example() {}',
  },
]);
```

### Update Post

```javascript
const { error } = await supabase
  .from('posts')
  .update({ title: 'Updated Title' })
  .eq('id', postId)
  .eq('user_id', userId);
```

### Delete Post

```javascript
const { error } = await supabase.from('posts').delete().eq('id', postId).eq('user_id', userId);
```

## Row Level Security (RLS)

### Posts Policies

```sql
-- Anyone can read posts
CREATE POLICY "Posts are viewable by everyone"
ON posts FOR SELECT USING (true);

-- Users can only insert their own posts
CREATE POLICY "Users can insert their own posts"
ON posts FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can only update their own posts
CREATE POLICY "Users can update their own posts"
ON posts FOR UPDATE USING (auth.uid() = user_id);

-- Users can only delete their own posts
CREATE POLICY "Users can delete their own posts"
ON posts FOR DELETE USING (auth.uid() = user_id);
```

## Categories

- **All** - Shows all posts
- **Discussion** - General discussions and questions
- **Tools Showcase** - Share security tools
- **Research** - Research papers and findings

## Code Snippet Formatting

Code snippets are displayed using:

```jsx
<pre className="bg-cyber-dark p-4 rounded-md overflow-x-auto">
  <code>{post.code_snippet}</code>
</pre>
```

## Real-time Subscriptions

Posts update in real-time using Supabase subscriptions:

```javascript
useEffect(() => {
  const subscription = supabase
    .channel('posts')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'posts',
      },
      payload => {
        // Handle real-time updates
        refreshPosts();
      }
    )
    .subscribe();

  return () => {
    subscription.unsubscribe();
  };
}, []);
```

## Security Considerations

1. **Authorization**

   - Only post owners can edit/delete
   - RLS policies enforce data access

2. **Input Validation**

   - Sanitize user input
   - Limit content length
   - Validate category values

3. **XSS Prevention**
   - React automatically escapes content
   - Code snippets displayed as plain text initially

## Testing

### Manual Testing Checklist

- [ ] Can create a post when logged in
- [ ] Cannot create post when not logged in
- [ ] Can edit own posts
- [ ] Cannot edit others' posts
- [ ] Can delete own posts
- [ ] Cannot delete others' posts
- [ ] Posts filter by category correctly
- [ ] Code snippets display correctly
- [ ] Upvotes work correctly
- [ ] Comments work correctly

## Future Enhancements

- [ ] Rich text editor for posts
- [ ] Image uploads
- [ ] Post search functionality
- [ ] Post tagging system
- [ ] Post templates
- [ ] Markdown support
- [ ] Post reactions (beyond upvotes)
