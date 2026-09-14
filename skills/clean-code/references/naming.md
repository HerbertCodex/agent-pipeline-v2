> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Naming

> **Language note:** Examples use JavaScript/TypeScript. Apply the same naming principles in your project's language, following its idioms and conventions.

> **Attribution:** Adapted and extended from [kettanaito/naming-cheatsheet](https://github.com/kettanaito/naming-cheatsheet) (MIT). The A/HC/LC pattern and the action/prefix tables originate there.

> **Transposing to other languages:** The naming principles below are language-agnostic. Only the *conventions* (casing, keyword style) differ. Quick map:
> - **camelCase** → JS/TS variables & functions, Java methods, Swift methods, C# private fields (`_camelCase`), Go unexported
> - **PascalCase** → TS/JS types & classes, C# public members & types, Java classes, Go exported, Rust types
> - **snake_case** → Python, Rust functions & variables, PHP, Ruby
> - **SCREAMING_SNAKE_CASE** → true global constants in most languages (Go uses `PascalCase` for exported constants)
> - **kebab-case** → CSS classes, HTML attributes, file names in some ecosystems
>
> **Filenames** are a separate concern from identifiers: Go test files (`*_test.go`), Python modules, and Rust modules use `snake_case` filenames regardless of the identifier casing inside them.
>
> Pick your language's community convention and apply the A/HC/LC pattern within it.

---

### S-I-D: the 3 rules every name must follow
- **Short** — easy to type and remember
- **Intuitive** — reads naturally, close to common speech
- **Descriptive** — reflects what it does or holds

```js
// ❌
const a = 5
const isPaginatable = a > 10    // unnatural word
const shouldPaginatize = a > 10 // made-up verb

// ✅
const postCount = 5
const hasPagination = postCount > 10
const shouldPaginate = postCount > 10
```

---

### Always use English
All code, variables, functions, and comments must be in English — even in non-English projects.

```js
// ❌
const primerNombre = 'Gustavo'

// ✅
const firstName = 'Gustavo'
```

---

### Pick one naming convention and stick to it
Check the language's community standard. Don't mix conventions in the same codebase.

```js
// ❌ Mixed conventions
const page_count = 5
const shouldUpdate = true

// ✅ Consistent camelCase (JavaScript / TypeScript)
const pageCount = 5
const shouldUpdate = true

// ✅ Consistent snake_case (Python)
page_count = 5
should_update = True
```

---

### No contractions
```js
// ❌
const onItmClk = () => {}
const usrNm = 'Alice'

// ✅
const onItemClick = () => {}
const userName = 'Alice'
```

---

### No context duplication
Remove the context from a name if it's already implied by the surrounding scope.

```js
// ❌
class MenuItem {
  handleMenuItemClick = (event) => { ... } // "MenuItem" is redundant here
}

// ✅ — reads as MenuItem.handleClick()
class MenuItem {
  handleClick = (event) => { ... }
}
```

---

### Reflect the expected result
The name should match what the value actually represents, not its inverse.

```js
// ❌ — name says "enabled" but it's used as "disabled"
const isEnabled = itemCount > 3
return <Button disabled={!isEnabled} />  // [component-based frameworks: React, Vue, Svelte, Angular, etc.]

// ✅ — name and usage align
const isDisabled = itemCount <= 3
return <Button disabled={isDisabled} />  // [component-based frameworks: React, Vue, Svelte, Angular, etc.]
```

---

### Booleans: prefix with is / has / should / can

| Prefix | Use for |
|---|---|
| `is` | characteristic or state → `isActive`, `isLoading` |
| `has` | possession of a value → `hasProducts`, `hasPermission` |
| `should` | conditional coupled with an action → `shouldPaginate`, `shouldUpdateUrl` |
| `can` | capability or permission → `canEdit`, `canDelete` |

```js
// ❌
const active = true
const productsExist = productsCount > 0

// ✅
const isActive = true
const hasProducts = productsCount > 0
```

---

### Functions: A/HC/LC pattern
```
prefix? + action (A) + high context (HC) + low context? (LC)
```

| Name | Prefix | Action | High context | Low context |
|---|---|---|---|---|
| `getUser` | | `get` | `User` | |
| `getUserMessages` | | `get` | `User` | `Messages` |
| `handleClickOutside` | | `handle` | `Click` | `Outside` |
| `shouldDisplayMessage` | `should` | `Display` | `Message` | |

> High context carries the most meaning — `shouldUpdateComponent` means *you* update it,
> `shouldComponentUpdate` means *the component* decides when to update itself.

---

### Actions — use the right verb

| Action | Use when | Example |
|---|---|---|
| `get` | accessing data (sync or async) | `getUser(id)` |
| `set` | setting a value declaratively | `setFruits(5)` |
| `reset` | restoring to initial state | `resetForm()` |
| `fetch` | retrieving from a remote source | `fetchOrders()` |
| `remove` | removing *from* a collection | `removeFilter('price', filters)` |
| `delete` | permanently erasing an entity | `deletePost(id)` |
| `create` | instantiating a new entity | `createUser(data)` |
| `compose` | building new data from existing | `composePageUrl(name, id)` |
| `handle` | implementing an event handler | `handleLinkClick()` |

```js
// remove vs delete — a common confusion:
// ❌
function deleteFilter(filterName, filters) { ... } // not erasing from the DB
function removePost(id) { ... }                    // actually erasing from the DB

// ✅
function removeFilter(filterName, filters) { ... } // removed from a collection
function deletePost(id) { ... }                    // erased from the database
// Rule of thumb: remove pairs with add / delete pairs with create
```

**In your language's casing convention:** the pattern stays the same; only the
shape changes.

```python
# Python / snake_case
def get_user_by_id(user_id): ...
def remove_filter(filter_name, filters): ...
```

```java
// Java / camelCase
public User getUserById(int userId) { ... }
public void removeFilter(String filterName, List<String> filters) { ... }
```

```go
// Go / exported PascalCase for public API, camelCase for internal
func GetUserByID(userID int) (*User, error) { ... }
func removeFilter(filterName string, filters []string) { ... }
```

---

### `on` vs `handle` [component-based frameworks: React, Vue, Svelte, Angular, etc.]
- `on` → **the interface** (props/events that receive a handler)
- `handle` → **the implementation** of that handler (the logic)

Applies to any component-based framework where a parent passes a callback to a child via a prop or event binding.

```jsx
// ❌ — inconsistent, confusing at a glance
<Button onClick={onButtonClick} />
function handleClick() { ... } // mixed naming

// ✅
// In the parent: handle* = the implementation
function handleSubmit(event) { ... }

// In the child component: on* = the prop name
<Button onSubmit={handleSubmit} />
```

---

### Constants: UPPER_SNAKE_CASE only for true globals
`UPPER_SNAKE_CASE` applies to **global configuration constants** — values that are fixed
across the entire application. Regular `const` variables stay in `camelCase`.

> Follow your language's convention for constants (e.g., Python uses `UPPER_SNAKE_CASE`, Go uses `camelCase` for unexported constants).

```js
// ❌ — over-applying UPPER_SNAKE_CASE
const USER = getUser()
const FILTERED_POSTS = posts.filter(isPublished)

// ✅ — UPPER_SNAKE_CASE only for true constants
const MAX_RETRY_COUNT = 3
const API_BASE_URL = 'https://api.example.com'

// ✅ — regular const stays camelCase
const user = getUser()
const filteredPosts = posts.filter(isPublished)
```

---

### [TypeScript] Types, interfaces, enums

**PascalCase** for all type-level constructs.

```ts
// ❌
type userProfile = { name: string }
interface iUser { id: number }   // "I" prefix is officially discouraged by Microsoft
enum userRole { Admin, Editor }

// ✅
type UserProfile = { name: string }
interface User { id: number }    // no "I" prefix
enum UserRole { Admin, Editor }
```

> The `IUser` convention comes from old C#/Java habits. TypeScript's own official style
> guide and Microsoft explicitly discourage it. Rename if you encounter it in a legacy codebase.

**Distinguish `type` vs `interface`** — both are valid, but be consistent within a project:
- `interface` → for object shapes that may be extended or implemented
- `type` → for unions, intersections, primitives, or mapped types

```ts
// Object shape → interface
interface UserRepository {
  findById(id: number): Promise<User>
  save(user: User): Promise<void>
}

// Union or computed → type
type Status = 'active' | 'inactive' | 'banned'
type PartialUser = Partial<User>
```

---

### [TypeScript] Literal union types — the self-documenting alternative to magic strings
A **literal union type** (`'click' | 'scroll' | 'focus'`) names a fixed set of string values directly in the type system. It replaces magic strings with a type the compiler checks, without the ceremony of an `enum`.

```ts
// ❌ Magic strings scattered across the codebase — no protection against typos
function logEvent(kind: string) { /* ... */ }
logEvent('clikc') // typo compiles fine, bug at runtime

// ✅ Literal union — the set of valid values lives in the type, named and checked
type EventKind = 'click' | 'scroll' | 'focus'
function logEvent(kind: EventKind) { /* ... */ }
logEvent('clikc')  // ❌ compile error
logEvent('click')  // ✅
```

Prefer a literal union when the set is small, stable, and string-meaningful. Reach for an `enum` only when the values need to be referenced as a namespace (`Status.Active`) or when you need reverse mapping (value → name). For larger or open-ended sets, a schema (zod enum) keeps validation and the type in one place.

> This is the naming-level counterpart to "no magic numbers" (see `functions.md`): give the constant set a name in the type system instead of repeating the literal everywhere.

---

### Singular vs plural
```js
// ❌
const friends = 'Bob'
const friend = ['Bob', 'Tony', 'Tanya']

// ✅
const friend = 'Bob'
const friends = ['Bob', 'Tony', 'Tanya']
```

---

### min / max / prev / next prefixes
Use for boundaries and state transitions.

```js
function renderPosts(posts, minPosts, maxPosts) {
  return posts.slice(0, randomBetween(minPosts, maxPosts))
}

async function getPosts() {
  const prevPosts = this.state.posts
  const latestPosts = await fetch('...')
  const nextPosts = concat(prevPosts, latestPosts)
  this.setState({ posts: nextPosts })
}
```

---

### No noise words
```js
// ❌ — all refer to the same thing
class UserData {}
class UserInfo {}
class UserObject {}
class UserEntity {}

// ✅
class User {}
```