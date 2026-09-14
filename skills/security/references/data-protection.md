> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Data Protection

> **Note:** Examples use Node.js/Express syntax. Apply the same security principles with your project's language and framework.

---

### Secrets — never in source code
Never commit API keys, passwords, tokens, or connection strings to source control.
Use environment variables, and always add secret files to `.gitignore`.

```ts
// ❌ Hardcoded secrets — visible to everyone with repo access
const stripe = new Stripe('sk_live_abc123...')
const db = new Pool({ password: 'mysecretpassword' })

// ✅ Loaded from environment — fail fast if missing (see "Validate env vars" below)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY env var is required')
const stripe = new Stripe(STRIPE_SECRET_KEY)

const DB_PASSWORD = process.env.DB_PASSWORD
if (!DB_PASSWORD) throw new Error('DB_PASSWORD env var is required')
const db = new Pool({ password: DB_PASSWORD })
```

```bash
# .env — never commit this file
STRIPE_SECRET_KEY=sk_live_abc123...
DB_PASSWORD=mysecretpassword
JWT_SECRET=...
```

```bash
# .gitignore — always include
.env
.env.local
.env.production
*.pem
*.key
```

Use a secrets manager in production (AWS Secrets Manager, HashiCorp Vault,
Doppler) instead of `.env` files on servers.

---

### Validate environment variables at startup
Fail fast if a required secret is missing — don't let the app start silently broken.

```ts
import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL:       z.string().url(),
  JWT_ACCESS_SECRET:  z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  STRIPE_SECRET_KEY:  z.string().startsWith('sk_'),
  NODE_ENV:           z.enum(['development', 'test', 'production']),
})

// Throws at startup if any variable is missing or invalid
export const env = EnvSchema.parse(process.env)
```

---

### Sensitive data — never log it
Logs are often stored, forwarded, and accessible to many people.
Never log passwords, tokens, full credit card numbers, SSNs, or raw PII.

```ts
// ❌ Password and token in logs
logger.info('Login attempt', { email, password, token })
logger.error('Payment failed', { cardNumber, cvv })

// ✅ Log only what's needed for debugging
logger.info('Login attempt', { email })
logger.error('Payment failed', { userId, last4: cardNumber.slice(-4), errorCode })
```

---

### Encryption at rest — sensitive fields
Encrypt sensitive fields before storing them in the database.
Hashing (bcrypt) is for passwords — use reversible encryption for fields you need to read back.

> **Use authenticated encryption.** CBC mode (used in the example below) provides
> confidentiality but not integrity — an attacker can tamper with ciphertext.
> Prefer **AES-256-GCM** or **ChaCha20-Poly1305**, which authenticate the data
> and detect tampering. The CBC example is shown for environments with limited
> crypto support; modern runtimes should default to GCM.

```ts
import crypto from 'crypto'

const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY
if (!ENCRYPTION_KEY_HEX) throw new Error('ENCRYPTION_KEY env var is required')
const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, 'hex') // 32 bytes
const IV_LENGTH = 16

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

function decrypt(text: string): string {
  const [ivHex, encryptedHex] = text.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString()
}

// Store encrypted, read decrypted
await db.save({ ssn: encrypt(user.ssn) })
const ssn = decrypt(storedUser.ssn)
```

**Modern GCM example (preferred if your runtime supports it):**
```ts
import crypto from 'crypto'

const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY
if (!ENCRYPTION_KEY_HEX) throw new Error('ENCRYPTION_KEY env var is required')
const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, 'hex')
const IV_LENGTH = 16
const TAG_LENGTH = 16

function encryptGcm(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function decryptGcm(payload: string): string {
  const [ivHex, tagHex, encryptedHex] = payload.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
```

---

### Never expose error details in production
Stack traces, file paths, library versions, and DB error messages
are a roadmap for attackers. Never send them to the client in production.

```ts
// ❌ Leaks internal structure to the client
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({
    error: err.message,  // e.g. "relation 'users' does not exist" — reveals DB schema
    stack: err.stack,    // reveals file paths, library versions, line numbers
  })
})

// ✅ Generic message to client, full details to server logs only
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  // Log everything server-side for debugging
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    userId: req.user?.id,
  })

  // Send only what the client needs
  // Adapt environment detection to your framework (e.g., NODE_ENV, RAILS_ENV, etc.)
  // Detailed messages and stack traces are for LOCAL development only — never
  // for staging or production-like environments that might be reachable externally.
  const isProd = process.env.NODE_ENV === 'production'
  res.status(500).json({
    error: isProd ? 'An unexpected error occurred' : err.message,
    ...(isProd ? {} : { stack: err.stack }), // stack only in dev
  })
})
```

Differentiate between operational errors (expected, safe to describe)
and programmer errors (unexpected, hide from client):

```ts
// ✅ Operational errors — safe to describe to the client
class NotFoundError extends Error {
  statusCode = 404
  constructor(resource: string) {
    super(`${resource} not found`)
  }
}
class ValidationError extends Error {
  statusCode = 400
  constructor(message: string) { super(message) }
}

// ✅ Central error handler — operational vs unexpected
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err.statusCode) {
    // Operational — message is safe to expose
    return res.status(err.statusCode).json({ error: err.message })
  }
  // Unexpected — log fully, hide details
  logger.error('Unexpected error', { err, url: req.url })
  res.status(500).json({ error: 'An unexpected error occurred' })
})
```

Also check:
- API responses don't include internal field names from the DB (`password_hash`, `internal_id`)
- Error responses don't reveal which fields exist in the schema
- `X-Powered-By` header removed (helmet does this automatically)

```ts
// ✅ Scrub sensitive fields before sending responses
const { passwordHash, internalId, ...safeUser } = user
res.json(safeUser)
```

---

### HTTPS and security headers
Always serve over HTTPS. Add security headers to every response.

```ts
import helmet from 'helmet'

// helmet sets secure defaults for all headers
app.use(helmet())

// What helmet enables by default:
// Content-Security-Policy    → prevents XSS
// X-Frame-Options: DENY      → prevents clickjacking
// X-Content-Type-Options     → prevents MIME sniffing
// Strict-Transport-Security  → forces HTTPS
// Referrer-Policy            → controls referrer leakage
```

---

### CORS — allowlist origins explicitly
Avoid `*` in production unless intentionally serving a public API — it allows any website to make requests.

```ts
import cors from 'cors'

// ❌ Allows any origin
app.use(cors())

// ✅ Explicit allowlist
app.use(cors({
  origin: ['https://app.example.com', 'https://admin.example.com'],
  credentials: true,         // required if using cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
```