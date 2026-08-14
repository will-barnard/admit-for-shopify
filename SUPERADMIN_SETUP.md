# SuperAdmin Role Setup - Production Commands

After deploying the updated code to production, run these commands:

## Option 1: Using the Migration Scripts (RECOMMENDED)

SSH into your NAS and run these commands:

```bash
# Add the superadmin role to the database
docker exec -it convention-backend node src/migrations/add-superadmin-role.js

# Create the superadmin user
docker exec -it convention-backend node src/migrations/seed-superadmin.js
```

## Option 2: Manual SQL Commands

If you prefer to run SQL directly, connect to your PostgreSQL database and run:

### Step 1: Update the role constraint

```sql
-- Drop the existing constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS valid_role;

-- Add new constraint with superadmin included
ALTER TABLE users ADD CONSTRAINT valid_role CHECK (role IN ('admin', 'verifier', 'superadmin'));
```

### Step 2: Create the SuperAdmin user

You'll need to generate a bcrypt hash. From your backend container:

```bash
docker exec -it convention-backend node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('superadmin123', 10).then(hash => console.log(hash));"
```

Then use the output hash in this SQL:

```sql
INSERT INTO users (username, password, role) 
VALUES ('superadmin', '<PASTE_HASH_HERE>', 'superadmin');
```

## Verification

Check that the changes were applied:

```sql
-- Verify the constraint includes superadmin
SELECT constraint_name, check_clause 
FROM information_schema.check_constraints 
WHERE constraint_name = 'valid_role';

-- Verify the superadmin user was created
SELECT id, username, role, created_at 
FROM users 
WHERE username = 'superadmin';
```

## Default Credentials

- **Username:** superadmin
- **Password:** superadmin123
- **⚠️ IMPORTANT:** Change this password immediately after first login!

## What's Different for SuperAdmin

The SuperAdmin role has been created with infrastructure for future enhanced controls. You can now:

1. Use the `superAdminMiddleware` on routes that should only be accessible to superadmin
2. Check `user.role === 'superadmin'` in frontend to show/hide certain UI elements
3. Implement additional superadmin-only features as needed

## Example Usage in Backend

```javascript
const superAdminMiddleware = require('../middleware/superadmin');

// SuperAdmin-only route
router.delete('/users/:id', superAdminMiddleware, async (req, res) => {
  // Only superadmin can access this
});
```

## Example Usage in Frontend

```vue
<template>
  <div v-if="authStore.user?.role === 'superadmin'">
    <!-- SuperAdmin-only controls -->
  </div>
</template>
```
