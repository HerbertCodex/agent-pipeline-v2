> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Structural Patterns

> **Language note:** Examples use TypeScript with class-based OOP. Apply the same patterns using your project's language idioms — functional languages may use closures and modules instead of classes.

Structural patterns deal with **how classes and objects are composed**.
Use them to adapt interfaces, add behavior, or simplify complex subsystems.

---

### Adapter — make incompatible interfaces work together

**Problem**: you need to use a class or library whose interface doesn't match
what your code expects — and you can't change either side.

```ts
// Existing interface your code depends on
interface Logger {
  log(level: 'info' | 'warn' | 'error', message: string): void
}

// Third-party library with a different interface
class WinstonLogger {
  info(msg: string)  { ... }
  warn(msg: string)  { ... }
  error(msg: string) { ... }
}

// ❌ Scattered adapter logic — every call site has to translate
winston.info(message)   // instead of logger.log('info', message)
winston.error(message)  // instead of logger.log('error', message)

// ✅ Adapter — wraps Winston behind your expected interface
class WinstonAdapter implements Logger {
  constructor(private winston: WinstonLogger) {}

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.winston[level](message) // translates your interface to Winston's
  }
}

// Usage — your code never knows it's talking to Winston
const logger: Logger = new WinstonAdapter(new WinstonLogger())
logger.log('info', 'Server started')
```

**Use Adapter when:**
- Integrating a third-party library behind your own interface
- Migrating from one library to another without changing all call sites
- Two systems need to communicate but have incompatible interfaces

---

### Decorator — add behavior without modifying the original class

**Problem**: you need to extend a class's behavior, but subclassing creates
an explosion of combinations, and modifying the original violates Open/Closed.

```ts
// Base interface
interface DataSource {
  write(data: string): void
  read(): string
}

class FileDataSource implements DataSource {
  write(data: string) { fs.writeFileSync(this.path, data) }
  read()              { return fs.readFileSync(this.path, 'utf8') }
  constructor(private path: string) {}
}

// ✅ Decorators — each adds one behavior, fully composable
class CompressionDecorator implements DataSource {
  constructor(private wrapped: DataSource) {}
  write(data: string) { this.wrapped.write(compress(data)) }
  read()              { return decompress(this.wrapped.read()) }
}

class EncryptionDecorator implements DataSource {
  constructor(private wrapped: DataSource) {}
  write(data: string) { this.wrapped.write(encrypt(data)) }
  read()              { return decrypt(this.wrapped.read()) }
}

// Compose freely — order matters
const plain      = new FileDataSource('./data.txt')
const compressed = new CompressionDecorator(plain)
const secured    = new EncryptionDecorator(compressed) // encrypt then compress

secured.write('Hello') // → encrypted → compressed → written to file
secured.read()         // → read → decompressed → decrypted
```

**Use Decorator when:**
- You need to add behavior to individual objects without affecting others
- Subclassing would create too many combinations (compressed+encrypted, compressed only, encrypted only...)
- You want to add/remove responsibilities at runtime

---

### Facade — provide a simple interface to a complex subsystem

**Problem**: a subsystem has many classes and interactions. Callers need
to know too much about how it works internally.

```ts
// ❌ Caller has to orchestrate the entire subsystem
const inventory = new InventoryService()
const payment   = new PaymentGateway()
const shipping  = new ShippingCalculator()
const notifier  = new NotificationService()

await inventory.reserve(items)
const total   = shipping.calculate(address, items)
const charged = await payment.charge(card, total)
await inventory.confirm(items)
await notifier.sendConfirmation(user, charged)

// ✅ Facade — one simple entry point, complexity hidden inside
class OrderFacade {
  constructor(
    private inventory: InventoryService,
    private payment:   PaymentGateway,
    private shipping:  ShippingCalculator,
    private notifier:  NotificationService,
  ) {}

  async placeOrder(user: User, items: Item[], card: Card, address: Address) {
    await this.inventory.reserve(items)
    const total   = this.shipping.calculate(address, items)
    const charged = await this.payment.charge(card, total)
    await this.inventory.confirm(items)
    await this.notifier.sendConfirmation(user, charged)
  }
}

// Caller
await orderFacade.placeOrder(user, items, card, address)
```

**Facade vs Adapter:** In practice, the line can blur — the key difference is intent: Facade simplifies, Adapter translates.

**Use Facade when:**
- A subsystem is complex and most callers only need a simple workflow
- You want to decouple callers from internal implementation details
- You're building a public API over a complex internal system

---

### Proxy — control access to an object

**Problem**: you need to add access control, caching, or logging
around an object without changing the object itself.

```ts
interface UserService {
  getUser(id: number): Promise<User>
}

// ✅ Caching Proxy — transparent to the caller
class CachedUserService implements UserService {
  private cache = new Map<number, User>()

  constructor(private real: UserService) {}

  async getUser(id: number): Promise<User> {
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached  // serve from cache
    const user = await this.real.getUser(id)
    this.cache.set(id, user)
    return user
  }
}

// ✅ Authorization Proxy — checks permissions before delegating
class AuthorizedUserService implements UserService {
  constructor(private real: UserService, private currentUser: User) {}

  async getUser(id: number): Promise<User> {
    if (this.currentUser.role !== 'admin' && this.currentUser.id !== id) {
      throw new ForbiddenError('Cannot access another user\'s profile')
    }
    return this.real.getUser(id)
  }
}

// Compose proxies — caller sees only UserService
const service = new CachedUserService(new AuthorizedUserService(new RealUserService(), currentUser))
```

**Use Proxy when:**
- Adding caching, logging, or access control without touching the real class
- Lazy-loading an expensive object until it's actually needed
- Controlling access to a remote service or sensitive resource