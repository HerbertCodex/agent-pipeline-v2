> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Layout & Composition

**All layout is mobile-first.** Write for 320px. Enhance upward.
Never use `max-width` media queries.

---

### Breakpoint system — the only one to use

```css
:root {
  /* 5 breakpoints — cover everything from 320px to 2560px */
  /* xs:  320px  — small phones (iPhone SE)         */
  /* sm:  640px  — large phones / small tablets      */
  /* md:  768px  — tablets                           */
  /* lg:  1024px — laptops                           */
  /* xl:  1280px — desktops                          */
  /* 2xl: 1536px — wide screens                      */
  /* 3xl: 1920px — full HD / large monitors          */
  /* 4xl: 2560px — ultrawide / 4K                    */
}

/* ✅ Mobile-first — always min-width */
.element { /* 320px+ — base, always defined first */ }
@media (min-width: 640px)  { .element { /* 640px+ */ } }
@media (min-width: 768px)  { .element { /* 768px+ */ } }
@media (min-width: 1024px) { .element { /* 1024px+ */ } }
@media (min-width: 1280px) { .element { /* 1280px+ */ } }
@media (min-width: 1536px) { .element { /* 1536px+ */ } }
@media (min-width: 1920px) { .element { /* 1920px+ — large monitors */ } }
@media (min-width: 2560px) { .element { /* 2560px+ — ultrawide/4K */ } }

/* ❌ Never — desktop-first overrides */
@media (max-width: 768px)  { .element { /* fighting your own styles */ } }
```

---

### Fluid type — `clamp()` everywhere, no fixed sizes

```css
/* ✅ Scales from 320px to 2560px without a single media query */
.hero-heading {
  /* min: 2.25rem (36px) at 320px */
  /* preferred: 7vw */
  /* max: 8rem (128px) at 1140px+ */
  font-size: clamp(2.25rem, 7vw, 8rem);
  line-height: clamp(1.05, 0.97, 0.92);
  letter-spacing: -0.03em;
}

.section-heading {
  font-size: clamp(1.75rem, 4vw, 3.5rem);
  letter-spacing: -0.02em;
}

.card-heading {
  font-size: clamp(1.125rem, 2vw, 1.5rem);
}

.body-text {
  font-size: clamp(0.9375rem, 1.2vw, 1.0625rem);
  line-height: 1.7;
}

.label-small {
  font-size: clamp(0.75rem, 1vw, 0.875rem);
}

/* ❌ Never — fixed sizes that break */
h1 { font-size: 5rem; }        /* too big on mobile */
h1 { font-size: 1.5rem; }      /* too small on desktop */
```

---

### Fluid spacing — `clamp()` for padding and gaps

```css
/* ✅ Section padding — generous on all screens */
.section {
  padding-block: clamp(3rem, 8vw, 8rem);
  padding-inline: clamp(1.25rem, 5vw, 4rem);
}

/* ✅ Container — fluid max-width with side padding */
.container {
  width: 100%;
  max-width: 1280px;
  margin-inline: auto;
  padding-inline: clamp(1.25rem, 5vw, 4rem);
}

/* ✅ Wide container — for near-full-bleed sections */
.container-wide {
  width: 100%;
  max-width: 1536px;
  margin-inline: auto;
  padding-inline: clamp(1.25rem, 4vw, 3rem);
}

/* ✅ Gap between cards / grid items */
.grid-gap {
  gap: clamp(1rem, 2.5vw, 2rem);
}
```

---

### Grid layouts — mobile-first, enhance upward

```css
/* ✅ Feature cards — 1 col → 2 col → 3 col → asymmetric on wide */
.features-grid {
  display: grid;
  grid-template-columns: 1fr;                      /* 320px+ */
  gap: clamp(1rem, 2.5vw, 1.5rem);
}
@media (min-width: 640px) {
  .features-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (min-width: 1024px) {
  .features-grid { grid-template-columns: repeat(3, 1fr); }
}
@media (min-width: 1280px) {
  /* Asymmetry only at desktop — safe to break convention here */
  .features-grid { grid-template-columns: 2fr 1fr 1fr; }
}

/* ✅ Split layout — stacked → side by side → wide asymmetric */
.split-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: clamp(2rem, 5vw, 4rem);
}
@media (min-width: 768px) {
  .split-layout { grid-template-columns: 1fr 1fr; align-items: center; }
}
@media (min-width: 1280px) {
  .split-layout { grid-template-columns: 5fr 4fr; } /* slight asymmetry */
}

/* Visual always after content on mobile */
.split-layout .visual { order: 2; }
.split-layout .content { order: 1; }
@media (min-width: 768px) {
  /* Alternate on desktop — odd sections flip the order */
  .split-layout.reverse .visual  { order: 1; }
  .split-layout.reverse .content { order: 2; }
}
```

---

### Staggered grids — offset only on desktop

```css
/* ✅ Stagger introduced progressively */
.cards-staggered {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.25rem;
}
@media (min-width: 640px) {
  .cards-staggered { grid-template-columns: repeat(2, 1fr); }
}
@media (min-width: 1024px) {
  .cards-staggered { grid-template-columns: repeat(3, 1fr); }
  /* Stagger only when there's enough space */
  .cards-staggered > :nth-child(2) { margin-top: 3rem; }
  .cards-staggered > :nth-child(3) { margin-top: 1.5rem; }
}
```

---

### Hero sections — bold on every screen

```css
/* ✅ Full-height hero — mobile-first */
.hero {
  min-height: 100svh;            /* svh = small viewport height, respects mobile browser chrome */
  display: grid;
  grid-template-columns: 1fr;    /* stacked on mobile */
  place-items: center;
  padding: clamp(5rem, 10vw, 8rem) clamp(1.25rem, 5vw, 4rem);
  position: relative;
  overflow: hidden;
}

@media (min-width: 1024px) {
  .hero {
    grid-template-columns: 1fr 1fr;   /* side by side on desktop */
    place-items: stretch;
  }
}

/* ✅ Hero text — bold on all screens */
.hero-content {
  display: flex;
  flex-direction: column;
  gap: clamp(1.25rem, 3vw, 2rem);
  max-width: 100%;
}

/* ✅ Gradient orb — sized for the screen */
.gradient-orb {
  width: clamp(200px, 60vw, 600px);
  height: clamp(200px, 60vw, 600px);
  position: absolute;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
  filter: blur(clamp(20px, 5vw, 60px));
  top: -20%;
  right: -10%;
  pointer-events: none;
}
```

---

### Container queries — component-level responsive

Container queries let a component respond to its own container size,
not the viewport. Use for reusable components that appear in different contexts.

```css
/* ✅ Card that responds to its container, not the viewport */
.card-wrapper {
  container-type: inline-size;
  container-name: card;
}

.card {
  display: flex;
  flex-direction: column;   /* stacked by default */
  gap: 1rem;
  padding: 1.5rem;
}

/* When the container is wide enough, go horizontal */
@container card (min-width: 400px) {
  .card {
    flex-direction: row;
    align-items: center;
  }
  .card-image { width: 40%; }
  .card-content { flex: 1; }
}

/* ✅ Stat card — changes layout at container breakpoint */
.stats-wrapper {
  container-type: inline-size;
}

.stat-card {
  padding: clamp(1rem, 3cqi, 2rem); /* cqi = container query inline unit */
}

.stat-value {
  font-size: clamp(1.5rem, 5cqi, 3rem);
}
```

**When to use container queries vs media queries:**
```
Media query  → layout of whole sections/pages (hero, navigation, grid columns)
Container query → individual components that appear in multiple contexts
                  (cards in a sidebar vs cards in a full-width grid)
```

---

### Large screens — cap the design, don't stretch it

```css
/* ✅ Content always stays readable — cap line length */
.body-text,
.prose {
  max-width: 65ch;   /* ~650px — optimal reading line length */
}

/* ✅ Wide screen hero — type doesn't get absurdly large */
.hero-heading {
  font-size: clamp(2.25rem, 7vw, 8rem);  /* capped at 8rem = 128px */
}

/* ✅ Background elements can scale, content stays in container */
.section {
  width: 100%;  /* full-bleed background */
}
.section .container {
  max-width: 1280px;
  margin-inline: auto;
}

/* ✅ Ultra-wide — two-column layouts get a max-width cap */
.split-layout {
  max-width: 1536px;
  margin-inline: auto;
}

/* ✅ On very large screens, increase spacing — content breathes more */
@media (min-width: 1920px) {
  .section { padding-block: clamp(8rem, 10vw, 12rem); }
  .container { padding-inline: clamp(4rem, 6vw, 8rem); }
}
```

---

### Navigation — mobile-first patterns

```css
/* ✅ Base: frosted glass bar, no links visible */
.navbar {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem clamp(1.25rem, 5vw, 2rem);
  background: color-mix(in srgb, var(--bg-base) 70%, transparent);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border-light);
}

/* Desktop links — hidden on mobile */
.nav-links { display: none; }

@media (min-width: 768px) {
  .nav-links {
    display: flex;
    gap: 0.25rem;
  }
}

/* ✅ Bottom nav for mobile — feels native */
.bottom-nav {
  position: fixed;
  inset: auto 0 0 0;
  z-index: 100;
  display: flex;
  justify-content: space-around;
  padding: 0.75rem 1rem;
  padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
  background: color-mix(in srgb, var(--bg-base) 80%, transparent);
  backdrop-filter: blur(20px);
  border-top: 1px solid var(--border);
}

@media (min-width: 768px) {
  .bottom-nav { display: none; }
}
```

---

### Touch targets — minimum 44px, always

```css
/* ✅ Every interactive element is tappable */
.btn,
.nav-item,
.icon-btn,
.link,
input[type="checkbox"],
input[type="radio"] {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
```

---

### Decorative elements — scale for the screen

```css
/* ✅ Oversized decorative type — reduced on mobile */
.decorative-letter {
  font-size: clamp(6rem, 25vw, 20rem);
  opacity: clamp(0.02, 0.03, 0.04);
  position: absolute;
  pointer-events: none;
  user-select: none;
}

/* ✅ Grid/dot backgrounds — density stays readable */
.dot-bg {
  background-size: clamp(16px, 3vw, 24px) clamp(16px, 3vw, 24px);
}
```

---

### Break the centered container trap

Never use the same container on every section.
Mix full-bleed, offset, and contained sections.

```css
/* ✅ Full-bleed with structured content inside */
.section-fullbleed {
  width: 100%;
  padding-inline: clamp(1.25rem, 5vw, 4rem);
}

/* ✅ Off-center content — only on desktop */
.section-offset {
  padding-inline: clamp(1.25rem, 5vw, 4rem);
}
@media (min-width: 1024px) {
  .section-offset {
    padding-left: clamp(4rem, 15vw, 20rem);
    padding-right: clamp(1.25rem, 5vw, 4rem);
  }
}

/* ✅ Overlapping elements — only when there's enough space */
.overlap-card {
  margin-top: 0;
}
@media (min-width: 768px) {
  .overlap-card { margin-top: -4rem; }
}
```

---

### Backgrounds — mobile-safe

```css
/* ✅ Noise texture — same on all screens */
.noise-overlay {
  position: absolute;
  inset: 0;
  opacity: 0.04;
  pointer-events: none;
  background-image: url("data:image/svg+xml,...");
}

/* ✅ Grid background — density adapts */
.grid-bg {
  background-image:
    linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size: clamp(30px, 5vw, 60px) clamp(30px, 5vw, 60px);
}

/* ✅ Spotlight beam — scales with viewport */
.spotlight {
  background: radial-gradient(
    ellipse clamp(60%, 80%, 100%) 50% at 50% -20%,
    var(--accent-glow),
    transparent
  );
}
```

---

### Dividers that don't look like dividers

```css
.section-divider {
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--border) 20%,
    var(--accent) 50%,
    var(--border) 80%,
    transparent
  );
}
```