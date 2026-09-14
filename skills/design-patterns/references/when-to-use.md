> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## When to Use Which Pattern

> **Language note:** Examples use TypeScript with class-based OOP. Apply the same patterns using your project's language idioms — functional languages may use closures and modules instead of classes.

Use this file when you recognize a problem but aren't sure which pattern fits.

> **When multiple patterns seem applicable, prefer the simpler one** — introduce complexity only when the simpler option proves insufficient.

---

### Symptom → Pattern mapping

| You notice... | Consider |
|---|---|
| `if/else` or `switch` that grows with every new type | **Strategy** or **Factory** |
| `if/else` or `switch` checking state in multiple methods | **State** |
| Constructor with many parameters, hard to read at call site | **Builder** |
| A class doing too many unrelated things | **Facade** |
| Adding behavior requires subclassing in many combinations | **Decorator** |
| Two systems with incompatible interfaces need to work together | **Adapter** |
| One change triggers updates in many unrelated places | **Observer** |
| Need undo/redo, queued operations, or replayable actions | **Command** |
| Need one shared instance across the app | **Singleton** |
| Need to add caching, logging, or auth around an object | **Proxy** |
| A request needs to pass through multiple independent steps | **Chain of Responsibility** |
| Iterating over a complex or paginated structure | **Iterator** |

---

### Choosing between similar patterns

**Strategy vs State**
- **Strategy**: algorithm chosen by the **caller**, doesn't change on its own
- **State**: behavior changes as the **object transitions** through its own lifecycle

```ts
// Strategy — caller picks the algorithm
sortUsers(users, sortStrategies['alphabetical'])

// State — object delegates to its current state, transitions internally
order.pay()  // PendingState → PaidState
order.ship() // PaidState → ShippedState
```

**Chain of Responsibility vs Observer**
- **Chain of Responsibility**: one request passes through handlers in sequence,
  any handler can short-circuit the chain
- **Observer**: one event notifies all subscribers — no short-circuiting, no sequence

```ts
// Chain — auth failure stops the chain, handler never reached
app.post('/orders', authHandler, rateLimitHandler, handleCreateOrder)

// Observer — all subscribers notified, none can stop others
orderService.onOrderPlaced.emit(order) // email + inventory + analytics all fire
```

**Strategy vs Factory**
- **Strategy**: the algorithm varies at runtime, the object is already created
- **Factory**: the *type* of object to create varies at runtime

```ts
// Strategy — object exists, behavior varies
sorter.sort(users, sortStrategies['alphabetical'])

// Factory — which object to create varies
const payment = createPayment('stripe', amount) // returns StripePayment
```

**Decorator vs Proxy**
- **Decorator**: adds new behavior (compression, encryption, logging)
- **Proxy**: controls access to the same behavior (caching, auth, lazy-loading)

```ts
// Decorator — wraps and extends behavior
const source = new EncryptionDecorator(new FileDataSource('./data'))

// Proxy — same interface, controls access
const service = new CachedUserService(new RealUserService())
```

**Facade vs Adapter**
- **Facade**: simplifies a complex subsystem you own
- **Adapter**: bridges two incompatible interfaces you don't control
- In practice, the line can blur — the key difference is intent: Facade simplifies, Adapter translates

```ts
// Facade — your own complex subsystem, simplified
await orderFacade.placeOrder(user, items, card, address)

// Adapter — third-party library, wrapped in your interface
const logger: Logger = new WinstonAdapter(new WinstonLogger())
```

**Observer vs Command**
- **Observer**: something happened, interested parties react
- **Command**: an action is captured as an object to be executed, queued, or undone

```ts
// Observer — event happened, subscribers react
orderService.onOrderPlaced.emit(order)

// Command — action captured, history tracked
history.execute(new MoveTextCommand(editor, position))
history.undo()
```

---

### Anti-patterns — when NOT to use a pattern

| Temptation | Why to resist |
|---|---|
| Factory for a single class | Just call `new` — a factory adds nothing |
| Singleton for convenience | You want global state — prefer dependency injection |
| Observer for a single listener | Just call the function directly |
| Strategy for two branches | An `if/else` is simpler and more readable |
| Builder for simple objects with a few required fields | Use Builder when construction has many optional parameters, complex validation, or step-by-step assembly — not for simple objects |
| Facade over one class | It's just a wrapper — add no value |

**The rule**: if adding the pattern doesn't solve a concrete pain point
(growing switch, untestable code, rigid hierarchy), don't add it.
Simple code that works beats complex code that's "correctly architected".