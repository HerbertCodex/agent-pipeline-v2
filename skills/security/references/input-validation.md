> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Input Validation

> **Note:** Examples use Node.js/Express syntax. Apply the same security principles with your project's language and framework.

---

### SQL Injection
Never concatenate user input into SQL queries.
Always use parameterized queries or an ORM.

```ts
// ❌ Vulnerable — attacker can input: ' OR '1'='1
const query = `SELECT * FROM users WHERE email = '${email}'`
db.query(query)

// ✅ Parameterized query — input is never interpreted as SQL
db.query('SELECT * FROM users WHERE email = $1', [email])

// ✅ ORM — parameterization is handled automatically
await User.findOne({ where: { email } })
```

---

### XSS — Cross-Site Scripting
Never inject raw user input into the DOM.
Always escape output or use framework-provided safe rendering.

```ts
// ❌ Vulnerable — attacker inputs: <script>document.cookie</script>
element.innerHTML = userInput

// ✅ textContent never interprets HTML
element.textContent = userInput

// ✅ In React — JSX escapes by default
return <div>{userInput}</div>

// ❌ Bypasses React's protection explicitly
return <div dangerouslySetInnerHTML={{ __html: userInput }} />

// ✅ If HTML input is required — sanitize with a library first
import DOMPurify from 'dompurify'
return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userInput) }} />
```

---

### Validate on the server — always
Frontend validation is UX. Backend validation is security.
Assume every request was crafted manually with curl or Postman.

```ts
// Use a schema library to validate all incoming data at the boundary
import { z } from 'zod'

const CreateUserSchema = z.object({
  email:    z.string().email(),
  age:      z.number().int().min(0).max(120),
  role:     z.enum(['customer', 'editor']),  // never accept 'admin' from user input
  website:  z.string().url().optional(),
})

app.post('/users', (req, res) => {
  const result = CreateUserSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ errors: result.error.flatten() })
  }
  // result.data is now fully typed and validated
  await createUser(result.data)
})
```

---

### Mass assignment
Never spread user input directly onto a model or database object.
Allowlist the fields you accept explicitly.

```ts
// ❌ Attacker can send { role: 'admin', isVerified: true }
await User.create({ ...req.body })

// ✅ Only pick the fields you explicitly allow
const { email, name, password } = req.body
await User.create({ email, name, password })

// ✅ Or use a validated schema (preferred — combines validation + allowlisting)
const data = CreateUserSchema.parse(req.body)
await User.create(data)
```

---

### Path traversal — file operations
Never use user input directly in file paths.

```ts
// ❌ Attacker inputs: ../../etc/passwd
const filePath = path.join(__dirname, 'uploads', req.params.filename)
fs.readFile(filePath, ...)

// ✅ Resolve the path and verify it stays within the expected directory
const uploadsDir = path.resolve(__dirname, 'uploads')
const filePath   = path.resolve(uploadsDir, req.params.filename)

if (!filePath.startsWith(uploadsDir)) {
  return res.status(403).json({ error: 'Access denied' })
}
fs.readFile(filePath, ...)
```

---

### CSRF — Cross-Site Request Forgery
CSRF tricks an authenticated user's browser into making an unwanted request
to your server. The server sees a valid session cookie and executes the action.

```
Attack flow:
1. User is logged in to bank.com (session cookie stored in browser)
2. User visits evil.com
3. evil.com silently submits a form to bank.com/transfer?to=attacker&amount=1000
4. Browser attaches the bank.com session cookie automatically
5. Bank executes the transfer — it looks like a legitimate request
```

**Protection 1 — `sameSite` cookie attribute (primary defense):**
```ts
// sameSite: 'lax'    → blocks CSRF from cross-site POST (good default)
// sameSite: 'strict' → blocks all cross-site requests (breaks OAuth flows)
// sameSite: 'none'   → no protection (only for intentional cross-origin APIs with Secure flag)

app.use(session({
  cookie: {
    sameSite: 'lax', // prevents cookie from being sent in cross-site POST requests
    httpOnly: true,
    secure: true,
  }
}))
```

**Protection 2 — CSRF tokens (defense in depth for state-changing endpoints):**
```ts
import csrf from 'csurf'

const csrfProtection = csrf({ cookie: true })

// Generate token — include in every form or page
app.get('/transfer', csrfProtection, (req, res) => {
  res.render('transfer', { csrfToken: req.csrfToken() })
})

// Validate token — on every state-changing request
app.post('/transfer', csrfProtection, (req, res) => {
  // csurf automatically validates req.body._csrf or X-CSRF-Token header
  // rejects the request if token is missing or invalid
  processTransfer(req.body)
})
```

```html
<!-- Include token in every form -->
<form action="/transfer" method="POST">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  ...
</form>
```

**For SPAs (token in header):**
```ts
// Fetch the token once on page load
const { csrfToken } = await fetch('/csrf-token').then(r => r.json())

// Include in every state-changing request
await fetch('/api/transfer', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,   // server validates this header
  },
  body: JSON.stringify(payload),
})
```

**Agent quick-check — does this app need CSRF tokens?**
```
□ Stateful session cookie (not token-only API)         → CSRF risk exists
□ Modern browser + sameSite: 'lax' + not public API   → often sufficient
□ High-stakes operations (payments, delete account)   → add tokens too
□ Single-page app with separate backend               → use Double Submit Cookie or header-based token
□ Stateless JWT in Authorization header               → no CSRF risk, tokens not needed
```

If the app is a stateless JWT API where the client sends `Authorization: Bearer <token>`,
CSRF does not apply. The attacker cannot craft a cross-origin request that includes
a custom header the browser doesn't send automatically.

---

### File upload security
File uploads are a high-risk surface — an attacker can upload malware,
overwrite existing files, or execute server-side code if not handled correctly.

**Validate type, size, and name — never trust the client:**
```ts
import path from 'path'
import crypto from 'crypto'
import multer from 'multer'
import { fromBuffer } from 'file-type'

// Example allowlist — define based on your application's requirements
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
// Configure based on your application's needs
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 // 5MB

const upload = multer({
  storage: multer.memoryStorage(), // process in memory before saving
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
})

app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ error: 'No file provided' })

  // ❌ Never trust the MIME type from the request — it's user-controlled
  // req.file.mimetype === 'image/jpeg' can be faked

  // ✅ Detect the real type from the file's magic bytes
  const detected = await fromBuffer(file.buffer)
  if (!detected || !ALLOWED_MIME_TYPES.includes(detected.mime)) {
    return res.status(400).json({ error: 'File type not allowed' })
  }

  // ✅ Never use the original filename — sanitize or replace entirely
  // ❌ path.join(uploadsDir, file.originalname) — path traversal + overwrite risk
  const safeFilename = `${crypto.randomUUID()}.${detected.ext}`

  // ✅ Store outside the webroot in an environment-configured path — not in /public or any served directory
  const uploadPath = path.join(process.env.UPLOAD_DIR || '/var/app/uploads', safeFilename)
  await fs.writeFile(uploadPath, file.buffer)

  // Return only a reference — never the real path
  res.json({ fileId: safeFilename })
})
```

**Serve uploaded files safely:**
```ts
// ❌ Serving uploads from a public directory allows direct URL access
// express.static('/var/app/uploads') — anyone can access any file by name

// ✅ Serve through a controller — check auth before streaming
app.get('/files/:fileId', requireAuth, async (req, res) => {
  // Validate fileId format — prevent path traversal
  if (!/^[\w-]+\.(jpg|jpeg|png|webp|pdf)$/.test(req.params.fileId)) {
    return res.status(400).json({ error: 'Invalid file reference' })
  }

  // Check the user has permission to access this file
  const record = await db.findFile(req.params.fileId)
  if (!record || record.ownerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const filePath = path.join(process.env.UPLOAD_DIR || '/var/app/uploads', record.filename)
  res.setHeader('Content-Type', record.mimeType)
  res.setHeader('Content-Disposition', 'attachment') // force download, never inline execute
  res.sendFile(filePath)
})
```

**Key rules summary:**

| Rule | Why |
|---|---|
| Detect MIME from magic bytes, not extension or header | Client-controlled values can be faked |
| Replace original filename with a random UUID | Prevents path traversal and file overwrite |
| Store outside the webroot | Prevents direct URL execution |
| Enforce max file size at the server | Prevents DoS via large uploads |
| Serve through a controller with auth check | Prevents unauthorized access |
| Set `Content-Disposition: attachment` | Prevents browser from executing the file inline |

---

### Rate limiting
Apply rate limiting to all public endpoints, especially auth routes.

```ts
import rateLimit from 'express-rate-limit'

// Strict limit on login — prevents brute force
// Example values — adjust based on your application's usage patterns
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per window
  message: { error: 'Too many login attempts, please try again later' },
})

// General API limit — example values — adjust based on your application's usage patterns
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
})

app.post('/auth/login', loginLimiter, handleLogin)
app.use('/api', apiLimiter)
```