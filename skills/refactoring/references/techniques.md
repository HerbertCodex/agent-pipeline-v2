> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Refactoring Techniques

> **Note:** Examples use TypeScript. Apply the same refactoring principles in your project's language.

---

### Extract Function
Move a block of code into a named function.
The most common and most impactful refactoring.

```ts
// ❌ Comment signals that extraction is needed
async function placeOrder(dto: CreateOrderDTO, userId: string) {
  // Validate stock
  for (const item of dto.items) {
    const product = await productRepo.findById(item.productId)
    if (!product || product.stock < item.quantity) {
      throw new Error(`${item.productId} out of stock`)
    }
  }
  // Calculate total
  const subtotal = dto.items.reduce((s, i) => s + i.price * i.quantity, 0)
  const discount = dto.coupon ? subtotal * 0.1 : 0
  const total    = subtotal - discount
  // Save and notify
  const order = await orderRepo.save({ userId, items: dto.items, total })
  await emailService.sendConfirmation(userId, order)
  return order
}

// ✅ Each extracted function has a clear name and single responsibility
async function placeOrder(dto: CreateOrderDTO, userId: string) {
  await validateStock(dto.items)
  const total = calculateTotal(dto.items, dto.coupon)
  return saveAndNotify(userId, dto.items, total)
}

async function validateStock(items: OrderItem[]) {
  for (const item of items) {
    const product = await productRepo.findById(item.productId)
    if (!product || product.stock < item.quantity) {
      throw new OutOfStockError(item.productId)
    }
  }
}

function calculateTotal(items: OrderItem[], coupon?: string): number {
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0)
  return coupon ? subtotal * 0.9 : subtotal
}
```

---

### Rename Variable / Function / Class
The cheapest, safest, and most impactful refactoring.
A good name eliminates the need for a comment.

```ts
// ❌ What is d? What does calc do? What is x?
const d = new Date()
function calc(x: number, y: number) { return x * y }
const res = calc(q, p)

// ✅ No comment needed
const today = new Date()
function calculateLineItemTotal(quantity: number, unitPrice: number) {
  return quantity * unitPrice
}
const lineTotal = calculateLineItemTotal(quantity, unitPrice)
```

---

### Replace Nested Conditionals with Guard Clauses
Exit early for invalid cases so the happy path is at the bottom, unindented.

```ts
// ❌ Happy path buried inside nesting
function getDiscount(user: User, order: Order): number {
  if (user) {
    if (user.isActive) {
      if (order.total > 100) {
        if (user.isPremium) {
          return 0.2
        } else {
          return 0.1
        }
      }
    }
  }
  return 0
}

// ✅ Guard clauses — invalid cases exit immediately
function getDiscount(user: User, order: Order): number {
  if (!user)            return 0
  if (!user.isActive)   return 0
  if (order.total <= 100) return 0
  return user.isPremium ? 0.2 : 0.1
}
```

---

### Replace Conditional with Polymorphism / Strategy
A switch/if-else that checks a type and behaves differently is a Strategy waiting to be born.

```ts
// ❌ Switch grows with every new notification type
function sendNotification(type: string, user: User, message: string) {
  switch (type) {
    case 'email': emailService.send(user.email, message); break
    case 'sms':   smsService.send(user.phone, message);   break
    case 'push':  pushService.send(user.deviceId, message); break
    default: throw new Error(`Unknown type: ${type}`)
  }
}

// ✅ Each type is isolated — adding a new one touches nothing else
interface NotificationChannel {
  send(user: User, message: string): Promise<void>
}

const channels: Record<string, NotificationChannel> = {
  email: new EmailChannel(emailService),
  sms:   new SMSChannel(smsService),
  push:  new PushChannel(pushService),
}

async function sendNotification(type: string, user: User, message: string) {
  const channel = channels[type]
  if (!channel) throw new Error(`Unknown notification type: ${type}`)
  await channel.send(user, message)
}
```

---

### Extract Class
When a class has too many responsibilities, split it.
A good signal: if you can describe the class without using "and", it's cohesive.

```ts
// ❌ User handles both identity AND address
class User {
  id: string
  email: string
  passwordHash: string
  street: string     // address concern
  city: string
  country: string
  zip: string

  validateEmail() { ... }
  changePassword() { ... }
  formatAddress() { ... }  // doesn't belong here
  validateZip() { ... }    // doesn't belong here
}

// ✅ Address extracted — each class has one responsibility
class User {
  id: string
  email: Email
  passwordHash: string
  address: Address  // delegated

  changePassword(newHash: string) { this.passwordHash = newHash }
}

class Address {
  constructor(
    public readonly street:  string,
    public readonly city:    string,
    public readonly country: string,
    public readonly zip:     string,
  ) { this.validate() }

  format(): string  { return `${this.street}, ${this.city}, ${this.zip}` }
  private validate() { ... }
}
```

---

### Introduce Parameter Object
Replace a group of parameters that always travel together with a single object.

```ts
// ❌ Always passed together — they form a concept
function filterOrders(startDate: Date, endDate: Date, status: string, userId: string) { ... }
function exportOrders(startDate: Date, endDate: Date, status: string, userId: string) { ... }

// ✅ Named concept — easier to pass, extend, and validate
interface OrderFilter {
  dateRange: { start: Date; end: Date }
  status?:   OrderStatus
  userId?:   string
}

function filterOrders(filter: OrderFilter) { ... }
function exportOrders(filter: OrderFilter) { ... }
```

---

### Replace Magic Number with Named Constant

```ts
// ❌ What is 0.15? What is 86400000?
if (order.total > 1000) discount = order.total * 0.15
setTimeout(refreshToken, 86400000)

// ✅ Self-documenting
const BULK_ORDER_DISCOUNT_RATE = 0.15
const ONE_DAY_MS               = 24 * 60 * 60 * 1000

if (order.total > BULK_ORDER_THRESHOLD) discount = order.total * BULK_ORDER_DISCOUNT_RATE
setTimeout(refreshToken, ONE_DAY_MS)
```

---

### Inline Function
Remove a function that does nothing beyond what its name says — the body is already clear.

```ts
// ❌ The function adds no clarity — its body is self-explanatory
function isAboveMinimum(value: number): boolean {
  return value > MIN_ORDER_TOTAL
}
if (isAboveMinimum(order.total)) { ... }

// ✅ Inline — reads just as clearly
if (order.total > MIN_ORDER_TOTAL) { ... }
```

---

### Move Function / Move Field
If a function uses more data from another class than its own, move it there.

```ts
// ❌ OrderFormatter uses Order's internals more than its own
class OrderFormatter {
  format(order: Order): string {
    const tax = order.subtotal * order.taxRate
    return `${order.id}: $${(order.subtotal + tax).toFixed(2)}`
  }
}

// ✅ Move to Order — it already has the data
class Order {
  format(): string {
    const tax = this.subtotal * this.taxRate
    return `${this.id}: $${(this.subtotal + tax).toFixed(2)}`
  }
}
```

---

### Parallel Change (Expand-Contract)
Modify a shared interface without breaking existing callers.
Instead of changing the signature in one step — which breaks everything at once —
expand first, migrate callers, then contract.

The three phases:

```
1. EXPAND   — add the new version alongside the old one
2. MIGRATE  — update all callers to use the new version
3. CONTRACT — remove the old version
```

**Example: changing a function signature**

```ts
// Current signature — used in 20 places
function createUser(name: string, email: string, role: string): User { ... }

// ❌ Change signature directly — breaks all 20 callers at once
function createUser(options: CreateUserOptions): User { ... }
// → 20 compile errors, hard to migrate safely

// ✅ Phase 1 — EXPAND: add new version, keep old one working
function createUser(name: string, email: string, role: string): User
function createUser(options: CreateUserOptions): User
function createUser(
  nameOrOptions: string | CreateUserOptions,
  email?: string,
  role?: string
): User {
  const opts = typeof nameOrOptions === 'string'
    ? { name: nameOrOptions, email: email ?? '', role: role ?? 'user' } // transitional — callers migrated in Phase 2
    : nameOrOptions
  return buildUser(opts)
}
// → All 20 callers still work, nothing is broken

// ✅ Phase 2 — MIGRATE: update callers one by one, commit after each
// Before: createUser('Alice', 'alice@x.com', 'admin')
// After:  createUser({ name: 'Alice', email: 'alice@x.com', role: 'admin' })
// Repeat for all 20 callers — each is a safe, independent commit

// ✅ Phase 3 — CONTRACT: remove the old signature
function createUser(options: CreateUserOptions): User {
  return buildUser(options)
}
// → Clean new interface, zero broken callers
```

**Example: renaming a method on a shared class**

```ts
// Old method — used across many modules
class OrderRepository {
  async get(id: string): Promise<Order> { ... }
}

// ✅ Phase 1 — EXPAND: add new name, delegate to old
class OrderRepository {
  async get(id: string): Promise<Order> { return this.findById(id) }      // keep old
  async findById(id: string): Promise<Order> { /* real implementation */ } // add new
}

// ✅ Phase 2 — MIGRATE: update callers from .get() to .findById()
// Each module migrated independently — one commit per module

// ✅ Phase 3 — CONTRACT: remove .get()
class OrderRepository {
  async findById(id: string): Promise<Order> { ... }
}
```

**When to use Parallel Change:**
Use Parallel Change when modifying a widely-used interface — introduce the new version
alongside the old, migrate callers, then remove the old. Common cases:
- Renaming a method or function used in many places
- Changing a function signature (adding/removing/reordering parameters)
- Splitting a class that is widely imported

**When a direct change is fine:**
- The function is private or used in only 1-2 places
- The codebase is fully typed (TypeScript) and the compiler catches all callers
- You can fix all callers in a single atomic commit without risk

---

### Replace Temp with Query
A local variable computed once can become stale or duplicated. Replace it with a query
that computes the value on demand.

```ts
// ❌ Temp variable computed once — may get stale if order changes
const total = order.items.reduce((s, i) => s + i.subtotal, 0)
if (total > 1000) applyBulkDiscount(order)
sendReceipt(user, total)  // total may be wrong if order was modified

// ✅ Computed on demand — always fresh
class Order {
  get total(): number {
    return this.items.reduce((s, i) => s + i.subtotal, 0)
  }
}
if (order.total > 1000) applyBulkDiscount(order)
sendReceipt(user, order.total)
```