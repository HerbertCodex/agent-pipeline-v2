> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Code Smells

> **Note:** Examples use TypeScript. Apply the same refactoring principles in your project's language.

A code smell is a surface signal that something deeper may be wrong.
Each smell has a suggested refactoring technique (see `references/techniques.md`).

---

### Long Function
A function that does too many things. Hard to name, hard to test, hard to reuse.

```ts
// ❌ Does validation, calculation, persistence, AND notification
async function processOrder(userId: string, items: CartItem[]) {
  if (!userId) throw new Error('userId required')
  if (!items.length) throw new Error('Cart is empty')
  const user = await db.query('SELECT * FROM users WHERE id = $1', [userId])
  if (!user) throw new Error('User not found')
  let total = 0
  for (const item of items) {
    const product = await db.query('SELECT * FROM products WHERE id = $1', [item.productId])
    if (product.stock < item.quantity) throw new Error(`${product.name} out of stock`)
    total += product.price * item.quantity
  }
  if (user.isPremium) total *= 0.9
  const order = await db.query('INSERT INTO orders ...', [userId, total])
  await emailService.send(user.email, 'Order confirmed', { orderId: order.id, total })
  return order
}
```

→ **Technique**: Extract Function — split into `validateOrder`, `calculateTotal`, `saveOrder`, `notifyUser`

---

### Long Parameter List
Many parameters (typically 4+) make a function hard to call and easy to misuse — consider grouping into an object or struct.

```ts
// ❌
function createReport(title: string, startDate: Date, endDate: Date,
                      format: string, includeCharts: boolean, userId: string) { ... }

// ✅ Group into a parameter object
function createReport(options: {
  title: string
  dateRange: { start: Date; end: Date }
  format: 'pdf' | 'csv' | 'html'
  includeCharts: boolean
  requestedBy: string
}) { ... }
```

→ **Technique**: Introduce Parameter Object

---

### Duplicated Code
The same logic appears in two or more places. A bug fix in one won't be applied to the other.

```ts
// ❌ Same discount logic in two places
class OrderService {
  calculateTotal(items: Item[], user: User) {
    const subtotal = items.reduce((s, i) => s + i.price, 0)
    return user.isPremium ? subtotal * 0.9 : subtotal
  }
}
class QuoteService {
  estimateTotal(items: Item[], user: User) {
    const subtotal = items.reduce((s, i) => s + i.price, 0)
    return user.isPremium ? subtotal * 0.9 : subtotal  // copy-paste
  }
}
```

→ **Technique**: Extract Function into a shared utility

---

### God Class
A class that knows too much and does too much. Violates SRP.

```ts
// ❌ UserManager does auth, profile, billing, notifications, AND reporting
class UserManager {
  login() { ... }
  logout() { ... }
  updateProfile() { ... }
  uploadAvatar() { ... }
  subscribe() { ... }
  cancelSubscription() { ... }
  sendWelcomeEmail() { ... }
  generateActivityReport() { ... }
}
```

→ **Technique**: Extract Class — split into `AuthService`, `ProfileService`, `BillingService`, `NotificationService`

---

### Feature Envy
A function that uses more data from another class than from its own.
The logic belongs in the other class.

```ts
// ❌ OrderPrinter knows too much about Order's internals
class OrderPrinter {
  format(order: Order): string {
    const discount = order.items.reduce((s, i) => s + i.price, 0) * order.discountRate
    const tax      = (order.subtotal - discount) * order.taxRate
    return `Total: ${order.subtotal - discount + tax}`
  }
}

// ✅ Move logic to Order — it already has the data
class Order {
  get formattedTotal(): string {
    return `Total: ${(this.subtotal * (1 - this.discountRate) * (1 + this.taxRate)).toFixed(2)}`
  }
}
```

→ **Technique**: Move Function to the class that owns the data

---

### Deep Nesting
Deep nesting makes code hard to follow — use guard clauses or extract helper functions.

```ts
// ❌ 4 levels deep — hard to read the happy path
async function processPayment(order) {
  if (order) {
    if (order.status === 'pending') {
      try {
        if (order.total > 0) {
          await chargeCard(order)
        }
      } catch (e) {
        ...
      }
    }
  }
}

// ✅ Guard clauses eliminate nesting — happy path reads top to bottom
async function processPayment(order) {
  if (!order) throw new Error('Order required')
  if (order.status !== 'pending') throw new InvalidStateError('Order is not pending')
  if (order.total <= 0) throw new DomainError('Order total must be positive')
  await chargeCard(order)
}
```

→ **Technique**: Replace Nested Conditionals with Guard Clauses

---

### Primitive Obsession
Using primitives (`string`, `number`) where a Value Object would add safety and meaning.

```ts
// ❌ What is this string? An email? A username? A phone?
function sendMessage(recipient: string, sender: string) { ... }

// ❌ Is this price in cents or euros? What currency?
function charge(amount: number) { ... }

// ✅ Value Objects make types self-documenting and validated
function sendMessage(recipient: Email, sender: Email) { ... }
function charge(amount: Money) { ... }
```

→ **Technique**: Replace Primitive with Value Object

---

### Data Clumps
Groups of data that always travel together should be a class or object.

```ts
// ❌ street, city, country, zip always appear together
function shipOrder(street: string, city: string, country: string, zip: string) { ... }
function validateAddress(street: string, city: string, country: string, zip: string) { ... }
function formatAddress(street: string, city: string, country: string, zip: string) { ... }

// ✅ Extract into a class
function shipOrder(address: Address) { ... }
function validateAddress(address: Address) { ... }
function formatAddress(address: Address) { ... }
```

→ **Technique**: Introduce Parameter Object / Extract Class

---

### Divergent Change
One class changes for many different reasons — a sign it has multiple responsibilities.

```
OrderService changes when:
- The discount calculation changes
- The email template changes
- The database schema changes
- The tax rules change
→ Each reason to change should be a separate class
```

→ **Technique**: Extract Class, apply SRP

---

### Shotgun Surgery
One change requires small edits in many different classes.

```
Adding a new payment method requires:
- editing PaymentController
- editing PaymentService
- editing OrderSummary
- editing InvoiceGenerator
- editing EmailTemplate
→ The concept is scattered — centralize it
```

→ **Technique**: Move Function / Move Field to consolidate the concept

---

### Commented-Out Code and Dead Code
Blocks of disabled code, unused imports, unused functions, and unreachable branches.
They create noise, confuse readers, and break trust — "is this still needed?"

```ts
// ❌ Dead code left behind
function calculateTotal(items: Item[]) {
  // const oldTotal = items.reduce((s, i) => s + i.price, 0)
  // return oldTotal * 0.95  // old discount logic
  return items.reduce((s, i) => s + i.price, 0)
}
```

→ **Technique**: Delete it. If it was ever important, Git remembers. Never comment out code "just in case" — that's what version control is for.

### Dead Code Smells for Agents
When reviewing or refactoring, remove:
- Unused imports, variables, parameters, or functions
- Functions that are never called
- Branches that can never be true
- Commented-out blocks older than the current commit
- Empty `catch` blocks, empty `if` bodies, placeholder `console.log` statements

If you are unsure whether code is dead, search all call sites. If none exist and it is not part of a public API, delete it.