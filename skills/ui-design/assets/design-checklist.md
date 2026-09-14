> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Design Checklist

---

### Design process (before any CSS)
- [ ] One-paragraph brand brief written (personality, audience, tone)
- [ ] 8–12 references collected with reasons — not all "premium dark"
- [ ] Tight constraint set chosen: 1–2 colors, 2 fonts, 1 spacing scale, 1 radius
- [ ] Layout language decided — containment default + 1–2 intentional exceptions
- [ ] ONE memorable element named per screen
- [ ] Every token justifiable against the brand brief

### Anti-generic
- [ ] Output does NOT have ≥ 3 traits from the generic SaaS fingerprint
- [ ] Output does NOT have ≥ 3 traits from the "premium dark + glow" fingerprint
- [ ] Glow used only where the brand genuinely calls for it — not sprayed everywhere
- [ ] The design could not be mistaken for "premium dark SaaS" — what makes it *this* brand's?

### UX laws
- [ ] Primary CTA is visually isolated — only colored/glowing element (Von Restorff)
- [ ] Max 5–7 navigation items, one primary CTA per screen (Hick)
- [ ] Important actions in the bottom thumb zone on mobile (Fitts)
- [ ] Progress indicator on multi-step flows (Zeigarnik)
- [ ] Form input normalized before validation — spaces/case accepted (Postel)
- [ ] Success state and final screen designed with care (Peak-End)
- [ ] Conventions broken only intentionally — nav, logo, Tab behavior respected (Jakob)

### UX patterns
- [ ] Every interactive action has a feedback state (loading, success, error)
- [ ] Loading states: skeleton for known shapes, spinner for unknown
- [ ] Interactions respond within 400ms — optimistic UI where needed (Doherty)
- [ ] Error messages explain what + why + how to fix — no generic "Error"
- [ ] Forms: labels always visible, validation on blur not on change
- [ ] Forms: errors shown inline next to the field
- [ ] Double submission prevented (button disabled while submitting)
- [ ] Input never cleared on validation error
- [ ] Empty states have icon + explanation + CTA
- [ ] Destructive actions require confirmation (inline or type-to-confirm)
- [ ] iOS: `font-size: max(1rem, 16px)` on inputs — prevents auto-zoom
- [ ] Micro-copy is specific and human — no "Submit", "Error", "Loading"

### CSS architecture
- [ ] All colors, spacing, easing defined as CSS custom properties in one global file
- [ ] No hardcoded hex values or pixel values in component styles
- [ ] Scoped styles used in Svelte/Vue/Angular — not global classes
- [ ] BEM not used — scoping handles collision prevention
- [ ] `@layer` used to manage specificity in global CSS
- [ ] Logical properties used (`padding-inline`, `margin-block`, `inset`)
- [ ] `@keyframes` in global animations file — not duplicated in components

---
- [ ] There is one element on every screen that makes someone stop and look
- [ ] The design does NOT have ≥ 3 traits from the generic app fingerprint
- [ ] The layout is not "max-w-7xl mx-auto" on every section
- [ ] Each section has a dominant visual tone — not trying to be everything at once
- [ ] I would screenshot this and share it

---

### Visual identity
- [ ] Background has a tint — not pure `#000` or `#fff`
- [ ] Primary color is custom to the brand — not a framework default
- [ ] At least one display font is used — not just Inter or system-ui
- [ ] Font sizes go large enough to make type a design element (≥ 6vw for hero)
- [ ] Color palette has: dark base + vibrant accent + secondary accent + text hierarchy
- [ ] Accent color used on ≤ 10% of the UI — rest is neutrals
- [ ] Gradient text used on at least one key heading

---

### Layout
- [ ] Not every section is centered in the same container
- [ ] At least one section uses asymmetric or full-bleed layout
- [ ] Hero is not "centered title + subtitle + two buttons on a plain background"
- [ ] Sections have breathing room between them
- [ ] Background has texture (noise, grid, dots, or gradient orb) on at least one section

---

### Motion (subtle — micro-interactions only)
- [ ] Hover states have personality — translate + glow, not just opacity/color change
- [ ] Easing uses custom cubic-bezier — not ease, not linear
- [ ] Button has active/press state (scale(0.97))
- [ ] Input focus state is distinctive — glow, not just border color change
- [ ] Scroll entrance animations are present — once, fade + translateY, done
- [ ] No looping animations on content (only decorative elements)
- [ ] No scroll hijacking or pinned horizontal scroll
- [ ] `prefers-reduced-motion` respected — all transitions disabled

---

### Stack-agnostic
- [ ] Core visual identity works without JavaScript (CSS tokens, fonts, colors)
- [ ] Scroll entrance uses IntersectionObserver or Framer Motion — not GSAP ScrollTrigger for simple cases
- [ ] Design tokens defined as CSS custom properties — usable in any framework

---

### Responsive — mobile-first mandatory
- [ ] All styles written mobile-first — only `min-width` media queries used
- [ ] Tested at: 320px, 375px, 640px, 768px, 1024px, 1280px, 1440px, 1920px
- [ ] All heading font sizes use `clamp()` — min starts at ≥ 2rem for h1
- [ ] All section padding uses `clamp()` — no fixed values
- [ ] All grid layouts start at 1 column on mobile, enhance upward
- [ ] Staggered grid offsets only applied at 1024px+ (`min-width`)
- [ ] Decorative oversized type uses `clamp()` — readable at 320px
- [ ] Touch targets are minimum 44px height and width
- [ ] Gradient orbs sized with `clamp()` or `vw` — not fixed pixels
- [ ] Navigation has a mobile pattern (hamburger or bottom nav)
- [ ] Bottom nav uses `env(safe-area-inset-bottom)` for iPhone notch
- [ ] Container queries used for components that appear in multiple contexts
- [ ] Content capped at readable max-width on ultrawide (1536px–1920px max)
- [ ] `100svh` used instead of `100vh` for mobile browser chrome

---
- [ ] Buttons have a distinct style — shimmer, glow, or texture
- [ ] Primary button has shadow/glow effect
- [ ] Input focus state is distinctive — glow, not just border color change
- [ ] Cards have a hover state that feels interactive (translate + border glow)
- [ ] Navigation feels premium — frosted glass or distinct treatment

---

### Performance
- [ ] Hero image is WebP format, preloaded with `<link rel="preload">`
- [ ] Hero image has `priority` / not lazy-loaded (above the fold)
- [ ] All images have explicit `width` and `height` attributes (prevents CLS)
- [ ] All images below the fold use `loading="lazy"` and `decoding="async"`
- [ ] Display font is preloaded in `<head>`
- [ ] All fonts use `font-display: swap`
- [ ] Font fallback matches display font metrics (no layout shift on swap)
- [ ] Only `transform` and `opacity` animated — no layout-triggering properties
- [ ] `will-change` used sparingly — removed after animation completes
- [ ] Heavy libraries (GSAP, anime.js) lazy-loaded via dynamic import
- [ ] Scripts use `defer` or `async` — nothing blocking in `<head>`
- [ ] CLS checked in DevTools before shipping (target < 0.1)

---
- [ ] All text has a minimum 4.5:1 contrast ratio against its background
- [ ] Focus states are visible and styled — not removed (`outline: none` without replacement)
- [ ] Interactive elements have `:focus-visible` styles with glow ring
- [ ] Motion respects `prefers-reduced-motion`
- [ ] Color is not the only way to convey information