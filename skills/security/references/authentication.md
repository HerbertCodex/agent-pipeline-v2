> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Authentication

> **Note:** Examples use Node.js/Express syntax. Apply the same security principles with your project's language and framework.

---

### Passwords — always hash with bcrypt / argon2
Never store plain text passwords. Never use MD5, SHA1, or SHA256 for passwords
— they are too fast and vulnerable to brute force. Use bcrypt, argon2, or scrypt, PBKDF2 — use your platform's recommended password hashing algorithm.

```ts
import bcrypt from 'bcrypt'

// Use a work factor appropriate for your hardware — 10-12 is typical for bcrypt
// in 2025, but benchmark on your deployment target
const SALT_ROUNDS = 12

// On registration — hash before storing
async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS)
}

// On login — compare without exposing timing differences
async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash) // constant-time comparison — no timing attack
}

// ❌ Never do this
const hash = crypto.createHash('md5').update(password).digest('hex')
const hash = sha256(password) // fast hash = brute-forceable
const stored = password       // plain text
```

---

### JWT — sign, verify, and expire correctly

```ts
import jwt from 'jsonwebtoken'

const ACCESS_TOKEN_SECRET  = process.env.JWT_ACCESS_SECRET
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET
if (!ACCESS_TOKEN_SECRET)  throw new Error('JWT_ACCESS_SECRET env var is required')
if (!REFRESH_TOKEN_SECRET) throw new Error('JWT_REFRESH_SECRET env var is required')

// ✅ Short-lived access token + long-lived refresh token
function generateTokens(userId: number) {
  const accessToken = jwt.sign(
    { sub: userId, type: 'access' },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '15m' }   // configure based on your security requirements — shorter access tokens are more secure
  )
  const refreshToken = jwt.sign(
    { sub: userId, type: 'refresh' },
    REFRESH_TOKEN_SECRET,
    { expiresIn: '7d' }    // configure based on your security requirements — longer refresh tokens improve UX
  )
  return { accessToken, refreshToken }
}

// ✅ Always verify — never decode without verifying
function verifyAccessToken(token: string) {
  return jwt.verify(token, ACCESS_TOKEN_SECRET) // throws if invalid or expired
}

// ❌ decode() skips signature verification — never use for auth decisions
const payload = jwt.decode(token) // NEVER for security checks
```

**JWT Gotchas:**
- Avoid storing tokens in localStorage for browser apps vulnerable to XSS — httpOnly cookies are generally safer for web apps
- Store refresh tokens in `httpOnly` cookies (not accessible to JS)
- Use separate secrets for access and refresh tokens
- Rotate refresh tokens on every use (refresh token rotation)

---

### Sessions
For server-rendered apps, use signed, `httpOnly`, `secure` sessions.

```ts
import session from 'express-session'
import RedisStore from 'connect-redis'

app.use(session({
  store: new RedisStore({ client: redisClient }), // never store sessions in memory in production
  secret: process.env.SESSION_SECRET ?? (() => { throw new Error('SESSION_SECRET env var is required') })(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,   // not accessible via JS — prevents XSS theft
    secure: true,     // HTTPS only
    sameSite: 'lax',  // CSRF protection
    maxAge: 1000 * 60 * 60 * 24, // 24 hours — adjust based on your security requirements
  },
}))
```

---

### Cookie security attributes

| Attribute | Purpose |
|---|---|
| `httpOnly` | Prevents JS access — blocks XSS token theft |
| `secure` | HTTPS only — prevents interception |
| `sameSite: 'lax'` | Blocks CSRF in most cases |
| `sameSite: 'strict'` | Stronger CSRF protection — may break some flows |
| `maxAge` | Explicit expiry — never leave sessions open-ended |

---

### Login — prevent user enumeration
Don't reveal whether an email exists in the system.

```ts
// ❌ Reveals that the email exists
if (!user) return res.status(404).json({ error: 'Email not found' })
if (!match) return res.status(401).json({ error: 'Wrong password' })

// ✅ Same message for both cases
if (!user || !(await verifyPassword(plain, user.passwordHash))) {
  return res.status(401).json({ error: 'Invalid email or password' })
}

// ✅ But still run bcrypt even when user is not found — prevent timing attacks
const dummyHash = '$2b$12$invalidhashfortimingprotection'
const hash = user?.passwordHash ?? dummyHash
await bcrypt.compare(plain, hash) // same time whether user exists or not
```

> **Why the dummy hash works:** bcrypt's compare function takes the same
> amount of time regardless of whether the hash is valid. By always running
> `bcrypt.compare`, an attacker cannot measure the response time to guess
> whether an email is registered. The dummy hash must look like a real
> bcrypt hash (starts with `$2b$12$`) but must never match a real password.

**Even simpler approach:** return the same generic message and run bcrypt on
a dummy hash before returning, without branching the response based on user
existence. The example above combines both checks to keep the code minimal.

---

### Password reset
```ts
// ✅ Secure reset flow
// 1. Generate a cryptographically random token
import crypto from 'crypto'
const token = crypto.randomBytes(32).toString('hex')

// 2. Store the HASH of the token (not the token itself)
const hashedToken = crypto.createHash('sha256').update(token).digest('hex')
await db.saveResetToken(userId, hashedToken, expiresAt)

// 3. Send the raw token in the email link
// /reset-password?token=<raw token>

// 4. On reset — hash the incoming token and compare
const incoming = crypto.createHash('sha256').update(req.query.token).digest('hex')
const record = await db.findResetToken(incoming)
if (!record || record.expiresAt < Date.now()) {
  return res.status(400).json({ error: 'Invalid or expired token' })
}
```