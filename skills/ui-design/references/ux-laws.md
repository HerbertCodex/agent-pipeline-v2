> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Laws of UX

These laws describe how humans perceive and interact with interfaces.
Each one has a direct, actionable consequence for UI decisions.

---

### Aesthetic-Usability Effect
**Beautiful design is perceived as easier to use** — even if it isn't.
Users are more tolerant of minor issues in visually polished interfaces.

```
✅ A premium-looking UI gets more forgiveness on bugs
✅ Visual quality = perceived trustworthiness
❌ "It works so design doesn't matter" — wrong. Users judge quality visually first.
```

---

### Doherty Threshold
**Interactions under 400ms keep the user in flow.** Above that, they disengage.

```tsx
// ✅ Optimistic UI — update immediately, revert on error
async function toggleLike() {
  setLiked(prev => !prev)
  try { await api.toggleLike() }
  catch { setLiked(prev => !prev); toast.error('Failed') }
}

// ✅ Show skeleton in < 100ms — user sees structure before data arrives
// ✅ Animate loading states — perceived time is shorter than real time
```

---

### Peak-End Rule
**Users judge an experience by its peak and its ending** — not the average.
A frustrating middle is forgiven if the end is great. A bad ending ruins everything.

```
✅ Design these moments with extra care:
- Success state: "Your order is confirmed! Here's what happens next."
- Last onboarding screen: "You're all set — here's your first action."
- Error recovery: exact steps to fix, not just what went wrong
- Empty state on first login: warm welcome + clear first action

❌ Never end on a blank screen, "Done." with no next step, or an error
   with no recovery path
```

---

### Von Restorff Effect
**What differs from its surroundings is remembered.**
The primary CTA must be visually isolated — not just "more prominent."

```css
/* ✅ Primary CTA breaks every pattern on the page */
.btn-primary {
  background: var(--accent);               /* only colored element */
  box-shadow: 0 0 24px var(--accent-glow); /* only glowing element */
  font-weight: 700;                        /* heaviest weight on screen */
}

/* ❌ Two equal-weight buttons — neither is remembered */
.btn-primary, .btn-secondary { background: var(--accent); }
```

---

### Zeigarnik Effect
**Incomplete tasks stay in memory.** Progress indicators create psychological
commitment and increase completion rates.

```tsx
// ✅ Always show where the user is and how far they have to go
<div class="steps">
  <div class="step completed">1. Account</div>
  <div class="step active">2. Profile</div>
  <div class="step pending">3. Preferences</div>
</div>
<progress value={2} max={3} aria-label="Step 2 of 3" />

// ✅ Persist progress — let users resume where they left off
// Save form state to localStorage on change
// Show "Continue where you left off?" on return
```

---

### Postel's Law
**Be liberal in what you accept, strict in what you send.**
Accept messy input. Normalize it. Never make users format data for you.

```ts
// ❌ Rejects "06 12 34 56 78" because it has spaces
if (!/^\d{10}$/.test(phone)) throw new Error('Invalid')

// ✅ Strip formatting, then validate
const normalizePhone = (raw: string) => raw.replace(/[\s\-\.\(\)]/g, '')
const normalizeEmail = (raw: string) => raw.trim().toLowerCase()

// "  Alice@Example.COM  " → "alice@example.com" ✓
// "+33 6 12 34 56 78"    → "+33612345678"       ✓
```

---

### Fitts's Law
**The larger and closer a target, the faster it is to reach.**

```
✅ Primary CTA: largest interactive element on the screen
✅ Mobile: important actions in the bottom 60% (thumb zone)
✅ Destructive actions (Delete): smaller and far from the primary action
❌ Tiny "Confirm" next to a large form
❌ "Delete account" button same size as "Save changes"
```

---

### Hick's Law
**Fewer choices = faster decisions.** Every option added increases decision time.

```
✅ Navigation: max 5–7 top-level items
✅ CTAs: one primary per screen, one secondary at most
✅ Pricing: max 3 tiers, one highlighted as recommended
✅ Forms: one question at a time when possible (multi-step)
❌ Navigation with 12 items
❌ Three equally-weighted buttons competing for attention
```

---

### Miller's Law
**Users hold 7 ± 2 items in working memory.** Group and chunk information.

```
✅ Phone: 06 12 34 56 78 — not 0612345678
✅ Long forms: grouped sections with clear labels
✅ Onboarding: 3–5 steps, never 10+
✅ Passwords: show strength indicator, not a list of 8 rules
❌ 12-step onboarding with no progress indicator
❌ Form fields with no logical grouping
```

---

### Jakob's Law
**Users expect your site to work like other sites they know.**
Break conventions intentionally and sparingly.

```
✅ Safe to break: visual style, micro-interactions, layout
❌ Risky to break: nav location, Tab/Enter behavior, logo → home,
                   search icon top-right, link appearance
```