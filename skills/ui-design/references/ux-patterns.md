> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## UX Patterns

Concrete patterns for the most common UX challenges.
Each pattern maps to one or more laws from `references/ux-laws.md`.

---

### Feedback — every action needs a response

Users need to know their action was received. Silence = confusion.

```
Immediate (0–100ms):  button press state, checkbox toggle
Short (100–400ms):    page navigation, filter update
Medium (400ms–1s):    form submission → skeleton or spinner required
Long (1s–3s):         loading indicator with message
Very long (3s+):      progress bar + cancel option
```

```tsx
// ✅ Button — all four states required
<button
  disabled={isLoading}
  aria-busy={isLoading}
  aria-label={isLoading ? 'Saving...' : 'Save changes'}
>
  {isLoading ? <Spinner /> : 'Save changes'}
</button>

// ✅ Skeleton > spinner when the layout is known
// Skeleton: cards, lists, profiles — shape is predictable
// Spinner:  search results, file processing — shape is unknown
```

---

### Error messages — explain what + why + how to fix

```
❌ Bad                    ✅ Good
"An error occurred"      "We couldn't save your changes. Check your connection and try again."
"Error 422"              "Email is already in use. Sign in instead?" + [Sign in] link
"Invalid input"          "Password must be at least 8 characters — you have 5."
"Session expired"        "Your session expired. Sign in again to continue." + [Sign in]
```

```tsx
// ✅ Inline validation — on blur, not on every keystroke
<input
  onBlur={() => validate(value)}
  aria-invalid={!!error}
  aria-describedby="email-error"
/>
{error && (
  <span id="email-error" role="alert" className="field-error">
    {error}
  </span>
)}

// ✅ Form error summary — for multi-field forms
{formErrors.length > 0 && (
  <div role="alert" aria-live="polite" className="error-summary">
    <p>Please fix {formErrors.length} errors:</p>
    <ul>
      {formErrors.map(e => (
        <li key={e.field}>
          <a href={`#${e.field}`}>{e.message}</a>
        </li>
      ))}
    </ul>
  </div>
)}
```

---

### Forms — the most critical UX surface

```
□ Label always visible — never placeholder-only (placeholder disappears on type)
□ Required fields marked — prefer making things optional where possible
□ Validate on blur, not on change — don't interrupt while typing
□ Error next to the field, not just at the top
□ Success state — confirm what was saved
□ Auto-focus first field on page load
□ Tab order follows visual order
□ Submit on Enter for single-field forms
□ Disable submit while submitting — prevent double submission
□ Preserve input on error — never clear a form on validation failure
□ font-size ≥ 16px on inputs — prevents iOS auto-zoom
```

```css
/* ✅ Floating label — always visible, adapts on focus */
.form-group { position: relative; margin-top: 1.5rem; }

.form-label {
  position: absolute;
  top: 0.75rem;
  left: 1rem;
  color: var(--text-muted);
  font-size: 0.9375rem;
  pointer-events: none;
  transition: all 0.2s var(--ease-out-expo);
}

.form-input:focus ~ .form-label,
.form-input:not(:placeholder-shown) ~ .form-label {
  top: -0.625rem;
  font-size: 0.75rem;
  color: var(--accent);
  background: var(--bg-surface);
  padding: 0 0.25rem;
}

/* ✅ iOS zoom prevention */
input, select, textarea {
  font-size: max(1rem, 16px);
}
```

---

### Mobile — thumb zone and touch patterns

```
The thumb zone (right-handed, one-handed):
┌──────────────┐
│  ✗  ✗  ✗  ✗ │  ← dead zone — never put important actions here
│  ~  ~  ~  ~ │  ← stretch zone — secondary actions
│  ✓  ✓  ✓  ✓ │  ← easy reach — primary actions here
│  ✓  ✓  ✓  ✓ │  ← easy reach
└──────────────┘
```

```css
/* ✅ Bottom sheet for mobile — reachable, native feel */
.bottom-sheet {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-surface);
  border-radius: 1rem 1rem 0 0;
  border-top: 1px solid var(--border);
  padding: 1.5rem 1.5rem calc(1.5rem + env(safe-area-inset-bottom));
  transform: translateY(100%);
  transition: transform 0.4s var(--ease-out-expo);
}
.bottom-sheet.open { transform: translateY(0); }

/* Swipe handle */
.bottom-sheet::before {
  content: '';
  display: block;
  width: 2.5rem;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  margin: 0 auto 1rem;
}
```

```
Touch-specific rules:
□ No hover-only interactions — touch has no hover state
□ Swipe gestures must have a visible fallback (button or tap)
□ Tap targets minimum 44×44px
□ Tap feedback within 100ms
```

---

### Empty states — an opportunity, not an afterthought

```tsx
// ❌ Blank screen — confusing and cold
{items.length === 0 && <div />}

// ✅ Empty state — explains + context + action
{items.length === 0 && (
  <div className="empty-state">
    <div className="empty-icon">📋</div>
    <h3>No orders yet</h3>
    <p>When you place your first order, it will appear here.</p>
    <a href="/shop" className="btn-primary">Browse products</a>
  </div>
)}
```

```css
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: clamp(3rem, 8vw, 6rem) 2rem;
  text-align: center;
}
.empty-icon { font-size: 3rem; opacity: 0.4; }
.empty-state h3 { font-size: 1.25rem; font-weight: 600; color: var(--text-primary); }
.empty-state p  { color: var(--text-muted); max-width: 30ch; }
```

---

### Confirmation — destructive actions

```tsx
// ✅ Inline confirmation — no modal for low-stakes actions
function DeleteButton({ onDelete }) {
  const [confirming, setConfirming] = useState(false)

  if (confirming) return (
    <div className="confirm-inline">
      <span>Delete this post?</span>
      <button onClick={onDelete}          className="btn-danger">Yes, delete</button>
      <button onClick={() => setConfirming(false)} className="btn-ghost">Cancel</button>
    </div>
  )
  return <button onClick={() => setConfirming(true)} className="btn-ghost">Delete</button>
}

// ✅ Type-to-confirm for irreversible high-stakes actions
// "Type DELETE to confirm permanent account deletion"
// Used for: account deletion, bulk data wipe, irreversible billing actions
```

---

### Micro-copy — words are part of the design

```
❌ Generic           ✅ Specific and human
"Submit"            "Send message" / "Book my spot" / "Start free trial"
"Error"             "Something went wrong — try again in a moment"
"Loading..."        "Finding the best matches for you..."
"Are you sure?"     "Delete this post? This can't be undone."
"Success"           "Your order is confirmed! Check your email for details."
"No results"        "No results for 'figma plugin' — try 'design tool'"
"Required"          "We need your email to send your receipt"
"Invalid"           "That doesn't look like a valid email — example: you@domain.com"
```

---

### Navigation — wayfinding patterns

```
□ Always show where the user is (active state, breadcrumb)
□ Back button always available on mobile
□ Logo always links to home
□ Search available from every page if content is searchable
□ Max 5–7 top-level navigation items (Hick's Law)
□ Important items first and last — not in the middle (Serial Position Effect)
□ Current page not a link — don't link to the page the user is already on
```

```css
/* ✅ Active nav item — obvious, not subtle */
.nav-item.active {
  color: var(--text-primary);
  background: var(--bg-surface);
}
.nav-item.active::after {
  content: '';
  position: absolute;
  bottom: -1rem;
  left: 50%;
  transform: translateX(-50%);
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
}
```