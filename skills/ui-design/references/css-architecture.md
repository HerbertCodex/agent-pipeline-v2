> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## CSS Architecture

---

### CSS raw vs Tailwind vs UnoCSS — when to use what

There is no universally correct answer. The right choice depends on the project.

| | CSS raw + scoped | Tailwind | UnoCSS |
|---|---|---|---|
| **Best for** | Svelte, Vue, Angular | React, Next.js | Any — lightest option |
| **Bundle size** | Depends on discipline | ✅ Purged automatically | ✅ Smallest possible |
| **Readability** | ✅ Real CSS, familiar | ❌ Long class strings | ✅ Shorter than Tailwind |
| **Consistency** | ⚠️ Requires discipline | ✅ Constrained by design | ✅ |
| **Design tokens** | ✅ CSS custom properties | ✅ Extend config | ✅ |
| **Theming** | ✅ Native CSS variables | ⚠️ Needs config extension | ✅ |
| **IDE support** | ✅ Native | ✅ With extension | ✅ |

**The rule that applies to all three:**
CSS custom properties (tokens) are always the foundation.
Whatever system you use on top, the tokens must be defined in one place.

---

### The universal token layer — define once, use everywhere

```css
/* app.css / global.css / tokens.css — loaded once, globally */

:root,
[data-theme="dark"] {
  /* Backgrounds */
  --bg-base:    #0a0a0f;
  --bg-surface: #111118;
  --bg-raised:  #1a1a24;

  /* Accent */
  --accent:       #7c3aed;
  --accent-light: #a78bfa;
  --accent-glow:  rgba(124, 58, 237, 0.3);

  /* Text */
  --text-primary:   #f8fafc;
  --text-secondary: #94a3b8;
  --text-muted:     #475569;

  /* Borders */
  --border:       rgba(255, 255, 255, 0.08);
  --border-light: rgba(255, 255, 255, 0.04);

  /* Spacing */
  --gap-xs: 0.5rem;
  --gap-sm: 1rem;
  --gap-md: 1.5rem;
  --gap-lg: 2.5rem;
  --gap-xl: 4rem;

  /* Easing */
  --ease-out-expo:  cubic-bezier(0.19, 1, 0.22, 1);
  --ease-spring:    cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-smooth:    cubic-bezier(0.25, 0.46, 0.45, 0.94);

  /* Typography */
  --font-display: 'Syne', 'Arial Black', sans-serif;
  --font-text:    'Inter', system-ui, sans-serif;

  /* Radius */
  --radius-sm:  0.375rem;
  --radius-md:  0.5rem;
  --radius-lg:  0.75rem;
  --radius-xl:  1rem;
  --radius-full: 9999px;
}

[data-theme="light"] {
  --bg-base:    #fafafa;
  --bg-surface: #ffffff;
  --bg-raised:  #f4f4f8;
  /* ... rest of light tokens */
}
```

---

### Svelte — CSS scoped in components

Svelte's `<style>` is scoped by default — the right approach for component styles.
Use global tokens, write scoped styles. No CSS-in-JS, no runtime overhead.

```svelte
<!-- ✅ Card.svelte — scoped styles + global tokens -->
<div class="card">
  <h3 class="card-title">{title}</h3>
  <p class="card-body">{body}</p>
</div>

<style>
  /* Scoped to this component automatically */
  .card {
    background: var(--bg-surface);     /* global token */
    border: 1px solid var(--border);   /* global token */
    border-radius: var(--radius-lg);   /* global token */
    padding: var(--gap-md);            /* global token */
    transition: transform 0.35s var(--ease-out-expo);
  }

  .card:hover {
    transform: translateY(-4px);
    border-color: rgba(124, 58, 237, 0.3);
  }

  .card-title {
    font-family: var(--font-display);
    font-size: clamp(1.125rem, 2vw, 1.5rem);
    color: var(--text-primary);
    margin: 0 0 var(--gap-xs);
  }

  .card-body {
    font-size: 0.9375rem;
    color: var(--text-secondary);
    line-height: 1.7;
    margin: 0;
  }
</style>
```

**Svelte CSS patterns:**

```svelte
<!-- ✅ :global() — when you need to style child components or DOM elements -->
<style>
  /* Style a child component's root element */
  :global(.prose h2) {
    font-family: var(--font-display);
    color: var(--accent-light);
  }

  /* Style injected HTML (markdown, rich text) */
  .content :global(a) {
    color: var(--accent-light);
    text-decoration-color: var(--accent-glow);
  }
</style>

<!-- ✅ @keyframes in a component — scoped won't work, use :global -->
<style>
  :global(@keyframes pulse) {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.5; }
  }

  .dot {
    animation: pulse 2s ease-in-out infinite;
  }
</style>

<!-- ✅ Conditional classes with Svelte -->
<div class="btn" class:active={isActive} class:loading={isLoading}>
  {label}
</div>

<style>
  .btn { /* base */ }
  .btn.active { color: var(--accent); }
  .btn.loading { opacity: 0.7; pointer-events: none; }
</style>
```

**Svelte + Tailwind — when to combine:**
```svelte
<!--
  Use Tailwind for layout utilities (flex, grid, spacing)
  Use scoped CSS for animations, hover states, complex styles
  Never mix — pick one approach per concern
-->

<!-- ✅ Tailwind for layout, scoped CSS for personality -->
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
  <div class="card">...</div>
</div>

<style>
  /* Tailwind handles layout, CSS handles the visual identity */
  .card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    transition: transform 0.35s var(--ease-out-expo), box-shadow 0.35s ease;
  }
  .card:hover {
    transform: translateY(-5px);
    box-shadow: 0 20px 40px rgba(0,0,0,0.3), 0 0 24px var(--accent-glow);
  }
</style>
```

---

### Vue — `<style scoped>`

Same philosophy as Svelte. Vue's scoped styles are the right default.

```vue
<template>
  <div class="card">
    <h3 class="card-title">{{ title }}</h3>
  </div>
</template>

<style scoped>
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--gap-md);
  transition: transform 0.35s var(--ease-out-expo);
}

.card:hover { transform: translateY(-4px); }

/* :deep() = Svelte's :global() for child components */
.card :deep(.badge) {
  font-size: 0.75rem;
}
</style>

<!-- ✅ CSS Modules in Vue when you need more control -->
<style module>
.card { /* class exposed as $style.card */ }
</style>
```

---

### React — CSS Modules

```tsx
// Card.module.css
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--gap-md);
  transition: transform 0.35s var(--ease-out-expo);
}

.card:hover { transform: translateY(-4px); }

.cardTitle {
  font-family: var(--font-display);
  color: var(--text-primary);
}
```

```tsx
// Card.tsx
import styles from './Card.module.css'

export function Card({ title }) {
  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>{title}</h3>
    </div>
  )
}
```

---

### Angular — component styles

```ts
// card.component.ts
@Component({
  selector: 'app-card',
  templateUrl: './card.component.html',
  styleUrl: './card.component.css',
  // encapsulation: ViewEncapsulation.Emulated — default, same as scoped
})
export class CardComponent {}
```

```css
/* card.component.css — automatically scoped */
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--gap-md);
  transition: transform 0.35s var(--ease-out-expo);
}

/* ::ng-deep = Vue's :deep() = Svelte's :global() */
.card ::ng-deep .badge {
  font-size: 0.75rem;
}
```

---

### File organization — global vs scoped

```
src/
├── styles/
│   ├── tokens.css        ← ALL CSS custom properties (colors, spacing, easing)
│   ├── reset.css         ← normalize, box-sizing, base elements
│   ├── typography.css    ← font faces, base type scale
│   ├── animations.css    ← @keyframes used across components
│   └── global.css        ← imports all of the above, loaded once
└── components/
    └── Card/
        ├── Card.svelte   ← scoped styles inside
        ├── Card.vue      ← <style scoped>
        ├── Card.tsx      ← imports Card.module.css
        └── Card.module.css
```

**Rule**: if a style is used in more than one component → move it to `global.css`.
If a style is specific to one component → keep it scoped.

---

### CSS methodology — BEM's role in modern projects

BEM (`.block__element--modifier`) was the standard when CSS had no
built-in scoping. With Svelte/Vue scoped styles and CSS Modules, BEM is
**no longer necessary in those stacks** — the scoping handles collision
prevention that BEM was invented to solve.

```css
/* In scoped-styles stacks — BEM is unnecessary */
.card__title--highlighted { ... }  /* verbose, redundant with scoping */
.title.highlighted { ... }         /* scoping prevents collisions */
```

**When BEM still makes sense:**
- Large vanilla-CSS codebases with no framework scoping (e.g. a design
  system shipped as plain CSS for consumption by multiple apps)
- Teams that need explicit naming conventions for handoffs and documentation
- Mixed CSS where some styles are global and some are scoped

In those cases BEM is a valid, battle-tested choice — not a relic. The
rule is: **use the collision-prevention your stack gives you; reach for
BEM only when you don't have scoping and need a convention.**

**What modern stacks use instead of BEM:**
- **Scoped styles** (Svelte, Vue, Angular, CSS Modules) → collision prevention built-in
- **Tailwind** → no class names at all for utilities
- **CSS Layers** (`@layer`) → specificity management without BEM naming

---

### CSS Layers — modern specificity management

```css
/* global.css */
@layer reset, tokens, base, components, utilities;

@layer reset {
  *, *::before, *::after { box-sizing: border-box; margin: 0; }
}

@layer tokens {
  :root { --accent: #7c3aed; /* ... */ }
}

@layer base {
  body { font-family: var(--font-text); color: var(--text-primary); }
  h1, h2, h3 { font-family: var(--font-display); }
}

@layer components {
  /* Shared component styles used across the app */
  .btn-primary { background: var(--accent); /* ... */ }
}

@layer utilities {
  /* One-off utility classes */
  .sr-only { position: absolute; width: 1px; clip: rect(0,0,0,0); }
  .text-gradient {
    background: linear-gradient(135deg, var(--text-primary), var(--accent-light));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
}
```

---

### Writing CSS that doesn't age badly

```css
/* ✅ Logical properties — works in all writing directions */
padding-inline: 1rem;     /* instead of padding-left + padding-right */
margin-block:   1.5rem;   /* instead of margin-top + margin-bottom */
border-inline-start: 2px solid var(--accent); /* instead of border-left */
inset: 0;                 /* instead of top: 0; right: 0; bottom: 0; left: 0 */

/* ✅ Container queries over media queries for components */
.card-wrapper { container-type: inline-size; }
@container (min-width: 400px) {
  .card { flex-direction: row; }
}

/* ✅ :has() — style parents based on children */
.form-group:has(input:invalid) .label { color: var(--color-error); }
.nav:has(.nav-item.active) { border-color: var(--accent); }

/* ✅ color-mix() — tint colors without extra variables */
.card:hover {
  background: color-mix(in srgb, var(--bg-surface) 90%, var(--accent));
}
```