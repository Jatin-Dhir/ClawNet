# Authentication Module Documentation

## Overview

The Authentication module handles user registration, login, session management, and protected routes throughout the ProjectClawNet platform.

## Location

- **Context**: `src/contexts/AuthContext.jsx`
- **Components**: `src/components/auth/AuthModal.jsx`
- **Backend**: Supabase Authentication

## Architecture

```
User Action → AuthModal Component
    ↓
AuthContext (useAuth hook)
    ↓
Supabase Auth API
    ↓
Session Management
    ↓
Protected Routes / User Profile
```

## Key Features

1. **User Registration**

   - Email and password signup
   - Automatic profile creation
   - Email verification (if enabled)

2. **User Login**

   - Email/password authentication
   - Session persistence
   - Auto-login on page refresh

3. **Session Management**

   - Real-time session tracking
   - Automatic session refresh
   - Logout functionality

4. **Protected Routes**
   - Route-level authentication checks
   - Redirect to login when unauthorized

## Usage

### Basic Authentication

```jsx
import { useAuth } from '../contexts/AuthContext';

function MyComponent() {
  const { session, profile, signIn, signOut } = useAuth();

  if (!session) {
    return <div>Please log in</div>;
  }

  return (
    <div>
      <p>Welcome, {profile?.username || session.user.email}</p>
      <button onClick={signOut}>Sign Out</button>
    </div>
  );
}
```

### Sign Up

```jsx
const { signUp } = useAuth();

const handleSignUp = async () => {
  const { data, error } = await signUp({
    email: 'user@example.com',
    password: 'securepassword',
  });

  if (error) {
    console.error('Sign up error:', error);
  } else {
    console.log('User created:', data.user);
  }
};
```

### Sign In

```jsx
const { signIn } = useAuth();

const handleSignIn = async () => {
  const { data, error } = await signIn({
    email: 'user@example.com',
    password: 'securepassword',
  });

  if (error) {
    console.error('Sign in error:', error);
  } else {
    console.log('Signed in:', data.user);
  }
};
```

## API Reference

### AuthContext Methods

| Method    | Parameters            | Returns                  | Description           |
| --------- | --------------------- | ------------------------ | --------------------- |
| `signUp`  | `{ email, password }` | `Promise<{data, error}>` | Register new user     |
| `signIn`  | `{ email, password }` | `Promise<{data, error}>` | Authenticate user     |
| `signOut` | -                     | `Promise<void>`          | Sign out current user |

### AuthContext State

| Property  | Type              | Description          |
| --------- | ----------------- | -------------------- |
| `session` | `Session \| null` | Current user session |
| `profile` | `Profile \| null` | User profile data    |
| `loading` | `boolean`         | Loading state        |

## Database Schema

### Profiles Table

```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  username TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Security Considerations

1. **Password Security**

   - Passwords are hashed by Supabase
   - Minimum length enforced by Supabase
   - Never store plain text passwords

2. **Session Security**

   - Sessions are managed server-side
   - Tokens expire after configured time
   - Secure cookie handling

3. **Row Level Security (RLS)**
   - User data protected by RLS policies
   - Users can only access their own data
   - Admin-only endpoints protected

## Error Handling

Common errors and solutions:

| Error Code                | Meaning              | Solution              |
| ------------------------- | -------------------- | --------------------- |
| `invalid_credentials`     | Wrong email/password | Check credentials     |
| `email_not_confirmed`     | Email not verified   | Verify email          |
| `user_already_registered` | Email exists         | Use sign in instead   |
| `weak_password`           | Password too weak    | Use stronger password |

## Testing

### Manual Testing Checklist

- [ ] User can register with valid email/password
- [ ] User cannot register with duplicate email
- [ ] User can sign in with correct credentials
- [ ] User cannot sign in with wrong credentials
- [ ] Session persists across page refreshes
- [ ] User can sign out successfully
- [ ] Protected routes redirect when not authenticated

## Future Enhancements

- [ ] Social login (Google, GitHub)
- [ ] Two-factor authentication (2FA)
- [ ] Password reset flow
- [ ] Remember me functionality
- [ ] Account deletion
