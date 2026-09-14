> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Creational Patterns

> **Language note:** Examples use TypeScript with class-based OOP. Apply the same patterns using your project's language idioms — functional languages may use closures and modules instead of classes.

Creational patterns deal with **how objects are created**.
Use them when object construction is complex, varies by type, or needs to be centralized.

---

### Factory — create objects without specifying the exact class

**Problem**: a `switch` or `if/else` that instantiates different classes
grows every time a new type is added — violates Open/Closed.

```ts
// ❌ New payment type = edit this function
function createPayment(type: string, amount: number) {
  if (type === 'stripe')   return new StripePayment(amount)
  if (type === 'paypal')   return new PaypalPayment(amount)
  if (type === 'crypto')   return new CryptoPayment(amount)
  throw new Error(`Unknown payment type: ${type}`)
}

// ✅ Factory — adding a new type = add one entry to the map, nothing else changes
interface Payment {
  process(): Promise<void>
}

type PaymentConstructor = new (amount: number) => Payment

const paymentFactories: Record<string, PaymentConstructor> = {
  stripe:  StripePayment,
  paypal:  PaypalPayment,
  crypto:  CryptoPayment,
}

function createPayment(type: string, amount: number): Payment {
  const Constructor = paymentFactories[type]
  if (!Constructor) throw new Error(`Unknown payment type: ${type}`)
  return new Constructor(amount)
}

// Adding a new type — minimal changes: add to the registry, a config map, or a new factory method
paymentFactories['bank'] = BankTransferPayment
```

**Use Factory when:**
- Object creation logic would otherwise be duplicated across the codebase
- The exact class to instantiate depends on runtime data
- You want to centralize and encapsulate object creation

---

### Builder — construct complex objects step by step

**Problem**: a constructor with many optional parameters is hard to call
correctly and impossible to read at the call site.

```ts
// ❌ Constructor with 7 parameters — which is which?
const email = new Email(
  'alice@example.com',
  ['bob@example.com'],
  'Welcome!',
  '<h1>Hi</h1>',
  null,
  true,
  ['file.pdf']
)

// ✅ Builder — fluent, self-documenting, each field explicit
const email = new EmailBuilder()
  .to('alice@example.com')
  .cc('bob@example.com')
  .subject('Welcome!')
  .htmlBody('<h1>Hi</h1>')
  .highPriority()
  .attach('file.pdf')
  .build()

class EmailBuilder {
  private data: Partial<Email> = {}

  to(address: string):         this { this.data.to = address;          return this }
  cc(address: string):         this { this.data.cc = address;          return this }
  subject(text: string):       this { this.data.subject = text;        return this }
  htmlBody(html: string):      this { this.data.body = html;           return this }
  highPriority():              this { this.data.priority = 'high';     return this }
  attach(filename: string):    this {
    this.data.attachments = [...(this.data.attachments ?? []), filename]
    return this
  }

  build(): Email {
    if (!this.data.to || !this.data.subject) {
      throw new Error('Email requires at least "to" and "subject"')
    }
    return this.data as Email
  }
}
```

**Use Builder when:**
- An object has many optional fields and combining them in a constructor is unreadable
- Construction involves validation that should happen at `build()` time
- You want to reuse partial configurations (call `.subject()` once, vary `.to()`)

---

### Singleton — ensure a single shared instance

**Problem**: some resources (DB connection pool, logger, config) must exist
only once. Creating multiple instances wastes resources or causes inconsistency.

```ts
// ✅ Singleton via static instance
class DatabasePool {
  private static instance: DatabasePool | null = null
  private pool: Pool

  private constructor() {
    // Private — prevents direct instantiation
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL })
  }

  static getInstance(): DatabasePool {
    if (!DatabasePool.instance) {
      DatabasePool.instance = new DatabasePool()
    }
    return DatabasePool.instance
  }

  query(sql: string, params: unknown[]) {
    return this.pool.query(sql, params)
  }
}

// Usage — always the same instance
const db = DatabasePool.getInstance()
```

**In modern runtimes — module-level singleton (simpler):**
```ts
// db.ts — most runtimes cache modules, so this is already a singleton
import { Pool } from 'pg'
export const db = new Pool({ connectionString: process.env.DATABASE_URL })

// Any file that imports db gets the same instance
import { db } from './db'
```

**⚠️ Singleton is global state — use with caution:**
- Makes unit testing hard (can't inject a mock easily)
- Creates hidden dependencies between modules
- Prefer dependency injection when testability matters

**Use Singleton only when:**
- A single instance is a true system constraint (connection pool, config, logger)
- Your language's module system already provides singleton semantics (Node.js, Python, Go packages, etc.)