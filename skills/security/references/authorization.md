> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Authorization

---

### Always check authorization server-side
Never rely on the UI to hide protected actions.
Every API endpoint must check permissions independently.

```ts
// ❌ Frontend hides the "Delete" button for non-admins
// but the endpoint has no check — attacker calls it directly
app.delete('/posts/:id', async (req, res) => {
  await Post.delete(req.params.id) // ← no auth check
})

// ✅ Every endpoint enforces its own permission
app.delete('/posts/:id', requireAuth, async (req, res) => {
  const post = await Post.findById(req.params.id)
  if (!post) return res.status(404).json({ error: 'Not found' })

  if (req.user.role !== 'admin' && post.authorId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  await post.delete()
  res.status(204).send()
})
```

> **404 vs 403 ordering:** the example returns 404 first if the post does not
> exist at all, then 403 if it exists but the user cannot access it. For public
> resources this can leak existence. For resources tied to a user, return 404 if
> the resource is not owned by the caller (combine the existence and ownership
> checks in the query). Use 403 only when you want to confirm the resource exists
> but deny access — which is itself a leak. Choose intentionally per endpoint.


---

### IDOR — Insecure Direct Object Reference
Always verify that the authenticated user owns or has access to the resource
they are requesting — don't trust IDs from the request alone.

```ts
// ❌ Any authenticated user can read any order by guessing the ID
app.get('/orders/:id', requireAuth, async (req, res) => {
  const order = await Order.findById(req.params.id)
  return res.json(order) // ← no ownership check
})

// ✅ Scope the query to the authenticated user
app.get('/orders/:id', requireAuth, async (req, res) => {
  const order = await Order.findOne({
    where: {
      id: req.params.id,
      customerId: req.user.id, // ← ownership enforced at query level
    }
  })
  if (!order) return res.status(404).json({ error: 'Not found' })
  return res.json(order)
})
```

---

### RBAC — Role-Based Access Control
Define roles and permissions explicitly. Centralize permission checks.

```ts
// Define permissions per role in one place
const PERMISSIONS = {
  customer: ['orders:read:own', 'profile:read:own', 'profile:update:own'],
  editor:   ['posts:create', 'posts:update:own', 'posts:read'],
  admin:    ['posts:delete', 'users:manage', 'orders:read:all'],
} as const

type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS][number]

// Centralized check — not scattered across endpoints
function hasPermission(user: User, permission: Permission): boolean {
  return PERMISSIONS[user.role]?.includes(permission) ?? false
}

// Reusable middleware
function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    next()
  }
}

// Usage
app.delete('/posts/:id', requireAuth, requirePermission('posts:delete'), handleDeletePost)
app.get('/orders',       requireAuth, requirePermission('orders:read:all'), handleGetAllOrders)
```

---

### Least privilege — at every level

**Database users:**
```sql
-- ❌ App connects as root or a superuser
-- ✅ Create a dedicated user with only the permissions it needs
CREATE USER app_user WITH PASSWORD '...';
GRANT SELECT, INSERT, UPDATE ON orders, users, products TO app_user;
-- No DROP, no TRUNCATE, no access to audit_logs
```

**API keys and service accounts:**
```ts
// ❌ One master API key for everything
// ✅ Scoped keys per service and environment
const stripeKey = process.env.STRIPE_SECRET_KEY    // payments only
const sendgridKey = process.env.SENDGRID_API_KEY   // email only
// Each key is rotatable independently
```

---

### 403 vs 404 — don't leak resource existence
Return 403 consistently for authorization failures, even if the resource exists.
Returning 404 for unauthorized access reveals that the resource doesn't exist
for the attacker (user enumeration / resource enumeration).

```ts
// ❌ Reveals that post 42 exists but the user can't access it
if (!canAccess) return res.status(404).json({ error: 'Not found' })

// ✅ Use 403 — access denied, existence not confirmed
if (!canAccess) return res.status(403).json({ error: 'Forbidden' })
```

Exception: when the resource truly doesn't exist, return 404.
The rule is: don't use 404 *as a substitute* for 403.