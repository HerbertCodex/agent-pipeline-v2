> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Behavioral Patterns

> **Language note:** Examples use TypeScript with class-based OOP. Apply the same patterns using your project's language idioms — functional languages may use closures and modules instead of classes.

Behavioral patterns deal with **how objects communicate and distribute responsibility**.
Use them to decouple senders from receivers, encapsulate algorithms, or manage state transitions.

---

### Strategy — swap algorithms at runtime

**Problem**: a function has growing `if/else` or `switch` blocks,
each branch implementing a different algorithm. Adding a new algorithm
requires modifying the function — violates Open/Closed.

```ts
// ❌ Growing switch — every new sort algorithm modifies this function
function sortUsers(users: User[], method: string): User[] {
  if (method === 'alphabetical') return users.sort((a, b) => a.name.localeCompare(b.name))
  if (method === 'byAge')        return users.sort((a, b) => a.age - b.age)
  if (method === 'bySignupDate') return users.sort((a, b) => a.createdAt - b.createdAt)
  throw new Error(`Unknown sort method: ${method}`)
}

// ✅ Strategy — each algorithm is isolated, new ones added without touching existing code
type SortStrategy = (users: User[]) => User[]

const sortStrategies: Record<string, SortStrategy> = {
  alphabetical: users => [...users].sort((a, b) => a.name.localeCompare(b.name)),
  byAge:        users => [...users].sort((a, b) => a.age - b.age),
  bySignupDate: users => [...users].sort((a, b) => a.createdAt - b.createdAt),
}

function sortUsers(users: User[], method: string): User[] {
  const strategy = sortStrategies[method]
  if (!strategy) throw new Error(`Unknown sort method: ${method}`)
  return strategy(users)
}

// Adding a new strategy — touch nothing else
sortStrategies['byRevenue'] = users => [...users].sort((a, b) => b.revenue - a.revenue)
```

**Use Strategy when:**
- Multiple variants of an algorithm exist and may be swapped at runtime
- A class has many `if/else` branches that each implement a different behavior
- You want to add new behaviors without modifying existing code (Open/Closed)

---

### Observer — notify multiple objects when state changes

**Problem**: when something happens, multiple unrelated parts of the system
need to react. Wiring them together directly creates tight coupling.

```ts
// ❌ OrderService directly calls every system that cares about new orders
class OrderService {
  async placeOrder(order: Order) {
    await this.db.save(order)
    await this.emailService.sendConfirmation(order)    // tight coupling
    await this.inventoryService.reserve(order.items)   // tight coupling
    await this.analyticsService.track('order_placed')  // tight coupling
    // Adding a new reaction = modify OrderService
  }
}

// ✅ Observer — OrderService emits an event, others subscribe independently
class EventEmitter<T> {
  private listeners: ((data: T) => void)[] = []
  subscribe(fn: (data: T) => void)   { this.listeners.push(fn) }
  emit(data: T)                      { this.listeners.forEach(fn => fn(data)) }
}

class OrderService {
  readonly onOrderPlaced = new EventEmitter<Order>()

  async placeOrder(order: Order) {
    await this.db.save(order)
    this.onOrderPlaced.emit(order) // fire and forget — no knowledge of who listens
  }
}

// Each subscriber registers independently — OrderService never changes
orderService.onOrderPlaced.subscribe(order => emailService.sendConfirmation(order))
orderService.onOrderPlaced.subscribe(order => inventoryService.reserve(order.items))
orderService.onOrderPlaced.subscribe(order => analyticsService.track('order_placed'))
```

**Use Observer when:**
- One event should trigger reactions in multiple unrelated parts of the system
- You want to decouple the event source from its consumers
- The set of consumers may change at runtime or grow over time

---

### Command — encapsulate actions as objects

**Problem**: you need to queue, log, undo, or retry operations.
Functions can't easily be stored, composed, or reversed.

```ts
// Command interface
interface Command {
  execute(): void
  undo?():   void  // optional — only implement when your domain requires reversibility
}

// Each action encapsulated as a command
class MoveTextCommand implements Command {
  private previousPosition: Position

  constructor(
    private editor: TextEditor,
    private newPosition: Position
  ) {}

  execute() {
    this.previousPosition = this.editor.cursorPosition
    this.editor.moveCursor(this.newPosition)
  }

  undo() {
    this.editor.moveCursor(this.previousPosition)
  }
}

// Command history enables undo/redo
class CommandHistory {
  private history: Command[] = []

  execute(command: Command) {
    command.execute()
    this.history.push(command)
  }

  undo() {
    const command = this.history.pop()
    command?.undo()
  }
}

// Usage
const history = new CommandHistory()
history.execute(new MoveTextCommand(editor, { line: 10, col: 5 }))
history.execute(new BoldTextCommand(editor, selectedRange))
history.undo() // undoes BoldText
history.undo() // undoes MoveText
```

**Use Command when:**
- You need undo/redo functionality (undo() is optional — only implement it when your domain requires reversibility)
- Operations should be queued, logged, or replayed
- You want to decouple the object that invokes an operation from the one that performs it

---

### State — change behavior as internal state changes

**Problem**: an object behaves differently depending on its current state,
leading to large `if/else` or `switch` blocks that check the state everywhere.

```ts
// ❌ State checked in every method — grows with every new state
class Order {
  status: 'pending' | 'paid' | 'shipped' | 'cancelled'

  cancel() {
    if (this.status === 'pending') { this.status = 'cancelled' }
    else if (this.status === 'paid') { this.status = 'cancelled'; refund() }
    else if (this.status === 'shipped') throw new Error('Cannot cancel shipped order')
    else if (this.status === 'cancelled') throw new Error('Already cancelled')
  }

  ship() {
    if (this.status === 'paid') { this.status = 'shipped'; notifyShipping() }
    else throw new Error(`Cannot ship order in status: ${this.status}`)
  }
}

// ✅ State pattern — each state encapsulates its own behavior
interface OrderState {
  cancel(order: Order): void
  ship(order: Order):   void
}

class PendingState implements OrderState {
  cancel(order: Order) { order.setState(new CancelledState()) }
  ship(order: Order)   { throw new Error('Pay first') }
}

class PaidState implements OrderState {
  cancel(order: Order) { refund(); order.setState(new CancelledState()) }
  ship(order: Order)   { notifyShipping(); order.setState(new ShippedState()) }
}

class ShippedState implements OrderState {
  cancel(order: Order) { throw new Error('Cannot cancel shipped order') }
  ship(order: Order)   { throw new Error('Already shipped') }
}

class CancelledState implements OrderState {
  cancel(order: Order) { throw new Error('Already cancelled') }
  ship(order: Order)   { throw new Error('Cannot ship cancelled order') }
}

class Order {
  private state: OrderState = new PendingState()

  setState(state: OrderState) { this.state = state }
  cancel() { this.state.cancel(this) } // delegates to current state
  ship()   { this.state.ship(this) }
}
```

**Strategy vs State — the key difference:**
```
Strategy: the algorithm is chosen by the CALLER and doesn't change on its own
          → sortUsers(users, sortStrategies['alphabetical'])

State:    the behavior changes as the OBJECT transitions through its own lifecycle
          → order.pay() → order.ship() → each call delegates to the current state
```

**Use State when:**
- An object's behavior changes significantly based on its internal state
- You have large `if/else` or `switch` blocks that check state in multiple methods
- State transitions follow clear rules (paid → shipped, never pending → shipped)

---

### Chain of Responsibility — pass a request along a chain of handlers

**Problem**: a request needs to go through multiple processing steps
(validation, auth, logging, transformation). Hardcoding the chain creates
tight coupling and makes reordering or adding steps painful.

```ts
// ❌ All steps hardcoded — adding or reordering requires modifying the function
async function handleRequest(req: Request, res: Response) {
  // Step 1: auth
  if (!req.headers.authorization) return res.status(401).send()
  const user = verifyToken(req.headers.authorization)
  if (!user) return res.status(401).send()

  // Step 2: rate limit
  if (await isRateLimited(req.ip)) return res.status(429).send()

  // Step 3: validate body
  const result = schema.safeParse(req.body)
  if (!result.success) return res.status(400).json(result.error)

  // Step 4: actual handler
  await processOrder(result.data, res)
}

// ✅ Chain of Responsibility — each handler does one thing, chain is composable
type Handler = (req: Request, res: Response, next: () => void) => void

const authHandler: Handler = (req, res, next) => {
  const user = verifyToken(req.headers.authorization)
  if (!user) return res.status(401).send()
  req.user = user
  next() // pass to next handler
}

const rateLimitHandler: Handler = async (req, res, next) => {
  if (await isRateLimited(req.ip)) return res.status(429).send()
  next()
}

const validationHandler = (schema: ZodSchema): Handler => (req, res, next) => {
  const result = schema.safeParse(req.body)
  if (!result.success) return res.status(400).json(result.error)
  req.body = result.data
  next()
}

// Compose the chain — reorder, add, remove without touching other handlers
// This is exactly how Express middleware works
app.post('/orders',
  authHandler,
  rateLimitHandler,
  validationHandler(CreateOrderSchema),
  handleCreateOrder,
)
```

**Real-world examples of Chain of Responsibility:**
- Express / Koa middleware (`app.use(...)`)
- HTTP interceptors (Axios, fetch wrappers)
- Validation pipelines
- Event bubbling in the DOM
- NestJS guards, interceptors, and pipes

**Use Chain of Responsibility when:**
- A request needs to pass through multiple independent processing steps
- Steps should be reusable and composable in different orders
- Any handler should be able to short-circuit the chain (returns a result, throws an error, or stops processing)
- You're building middleware, pipelines, or interceptors

---

### Iterator — traverse a collection without exposing its structure

**Problem**: you need to loop over a custom data structure (tree, graph, paginated API)
without exposing how it's stored internally.

```ts
// ✅ Custom iterator — hides traversal logic behind a standard interface
class PaginatedAPIIterator {
  private page = 1
  private buffer: User[] = []
  private done = false

  async next(): Promise<{ value: User | null; done: boolean }> {
    if (this.buffer.length === 0) {
      if (this.done) return { value: null, done: true }

      const response = await fetch(`/api/users?page=${this.page++}`)
      const data = await response.json()

      if (data.users.length === 0) {
        this.done = true
        return { value: null, done: true }
      }
      this.buffer = data.users
    }
    const next = this.buffer.shift()
    if (next === undefined) return { value: null, done: true }
    return { value: next, done: false }
  }

  // ✅ [JavaScript/TypeScript] Make it work with for...of via the iterable protocol
  [Symbol.asyncIterator]() { return this }
}

// Caller never knows about pagination
for await (const user of new PaginatedAPIIterator()) {
  console.log(user.name)
}
```

**Use Iterator when:**
- Traversal logic is complex (pagination, tree walking, lazy loading)
- You want to iterate over a custom structure with a standard `for...of` loop
- You want to decouple traversal logic from the collection itself