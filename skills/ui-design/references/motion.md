> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Motion & Animation

Animation direction: **subtle micro-interactions** — the user feels quality,
not spectacle. Every transition should be invisible when done right.

---

### The hierarchy of motion

```
1. CSS transitions       → always try first, zero JS overhead
2. CSS animations        → for looping or keyframe effects
3. Framer Motion         → React enter/exit, layout, scroll-triggered
4. GSAP                  → only when CSS + Framer can't handle it
5. anime.js              → SVG animations, staggered sequences
```

Default rule: if CSS can do it, CSS does it.
Never reach for a JS library to do what a `transition` handles.

---

### The right easing — the most impactful single change

The difference between a generic and a premium feel is almost entirely easing.

```css
:root {
  /* Use these instead of ease/linear */
  --ease-out-expo:  cubic-bezier(0.19, 1, 0.22, 1);    /* snappy deceleration */
  --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);     /* smooth deceleration */
  --ease-in-out:    cubic-bezier(0.83, 0, 0.17, 1);    /* symmetric, cinematic */
  --ease-spring:    cubic-bezier(0.34, 1.56, 0.64, 1); /* slight overshoot */
  --ease-smooth:    cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

/* ❌ Generic easing */
transition: all 0.2s ease;
transition: all 0.3s;

/* ✅ Purposeful easing */
transition:
  transform 0.4s var(--ease-out-expo),
  opacity   0.3s var(--ease-smooth);
```

---

### Micro-interactions — the full catalog

**Hover — translate + glow, not just color change:**
```css
.card {
  transform: translateY(0);
  transition:
    transform  0.35s var(--ease-out-expo),
    box-shadow 0.35s var(--ease-out-expo),
    border-color 0.25s ease;
}
.card:hover {
  transform: translateY(-5px);
  box-shadow:
    0 16px 32px rgba(0,0,0,0.35),
    0 0 0 1px rgba(255,255,255,0.08),
    0 0 24px var(--accent-glow);
  border-color: var(--accent-glow);
}
```

**Button press — physical feedback:**
```css
.btn { transition: transform 0.1s ease, box-shadow 0.2s ease; }
.btn:active { transform: scale(0.97); }
/* Scale down on press, back up on release — feels physical */
```

**Input focus — the field comes alive:**
```css
.input {
  border: 1px solid var(--border);
  transition: border-color 0.2s ease, box-shadow 0.25s ease;
}
.input:hover:not(:focus) { border-color: rgba(255,255,255,0.15); }
.input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
  outline: none;
}
```

**Focus ring — distinctive, not default:**
```css
/* ❌ Default browser outline — ugly and inconsistent */
:focus { outline: 2px solid blue; }

/* ✅ Layered ring with glow */
:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--bg-base),
    0 0 0 4px var(--accent),
    0 0 8px var(--accent-glow);
}
```

**Link underline — animated, not static:**
```css
.link {
  text-decoration: none;
  background-image: linear-gradient(var(--accent), var(--accent));
  background-size: 0% 1px;
  background-position: left bottom;
  background-repeat: no-repeat;
  transition: background-size 0.3s var(--ease-out-expo);
  padding-bottom: 2px;
}
.link:hover { background-size: 100% 1px; }
```

**Icon — rotate or translate on hover:**
```css
.btn-icon .icon {
  transition: transform 0.3s var(--ease-spring);
}
.btn-icon:hover .icon { transform: rotate(15deg) scale(1.1); }

/* Arrow icon that moves right */
.btn-arrow .arrow {
  transition: transform 0.3s var(--ease-out-expo);
}
.btn-arrow:hover .arrow { transform: translateX(4px); }
```

**Shimmer on buttons — premium feel:**
```css
.btn-primary {
  position: relative;
  overflow: hidden;
}
.btn-primary::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    transparent 40%,
    rgba(255,255,255,0.12) 50%,
    transparent 60%
  );
  transform: translateX(-100%);
  transition: transform 0.6s ease;
}
.btn-primary:hover::before { transform: translateX(100%); }
```

---

### Framer Motion — scroll entrance (the one JS animation worth using)

For React. Keep it simple: fade + translate up on scroll, once.

```tsx
import { motion } from 'framer-motion'

// Single element entrance
const fadeUp = {
  hidden:  { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.19, 1, 0.22, 1] }
  }
}

export function Section({ children }) {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-80px' }}
    >
      {children}
    </motion.div>
  )
}

// Staggered list — children animate in sequence
const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } }
}

export function StaggeredList({ items }) {
  return (
    <motion.ul variants={container} initial="hidden" whileInView="visible" viewport={{ once: true }}>
      {items.map(item => (
        <motion.li key={item.id} variants={fadeUp}>{item.content}</motion.li>
      ))}
    </motion.ul>
  )
}
```

**For Vue / Svelte / vanilla — use IntersectionObserver instead:**
```ts
// Stack-agnostic scroll entrance
function observeEntrance(selector: string) {
  const els = document.querySelectorAll(selector)
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible')
          observer.unobserve(entry.target) // once only
        }
      })
    },
    { threshold: 0.1, rootMargin: '-80px' }
  )
  els.forEach(el => observer.observe(el))
}
```
```css
.reveal {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity 0.6s var(--ease-out-expo), transform 0.6s var(--ease-out-expo);
}
.reveal.visible {
  opacity: 1;
  transform: none;
}
```

---

### Skeleton loading — better than spinners

```css
/* ✅ Skeleton shimmer — shows structure while content loads */
.skeleton {
  background: var(--bg-surface);
  border-radius: 0.375rem;
  position: relative;
  overflow: hidden;
}
.skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255,255,255,0.04) 50%,
    transparent 100%
  );
  animation: skeleton-shimmer 1.8s ease-in-out infinite;
}
@keyframes skeleton-shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
```

---

### What NOT to animate

```
❌ Scroll hijacking / pinned horizontal scroll   → frustrates users
❌ Page transitions that take > 400ms            → feels slow, not premium
❌ Looping animations on content (not decorative) → distracting
❌ Hover animations on mobile                    → no hover on touch
❌ Animating width, height, top, left            → causes layout reflow
❌ More than ~10 elements animating simultaneously → jank
```

---

### Accessibility

```css
/* Always — no exceptions */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```