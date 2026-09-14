> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Visual Identity

This file defines the **design token structure** and rules for creating
a distinctive visual identity. All values are project-specific — define
them based on the project's brand before writing any component.

---

### Color — token-based system

Define a semantic color palette as CSS custom properties.
Never hardcode hex values in components — always reference tokens.

```css
/* ✅ Token structure — replace values with your project's brand */
:root {
  /* Backgrounds — layered depth (3-4 levels) */
  --bg-base:    /* ... */;  /* page background */
  --bg-surface: /* ... */;  /* cards, panels */
  --bg-raised:  /* ... */;  /* dropdowns, modals */
  --bg-overlay: /* ... */;  /* hover states, overlays */

  /* Primary accent — one vibrant color, used sparingly */
  --accent:       /* ... */;  /* buttons, links, key elements */
  --accent-light: /* ... */;  /* lighter variant for hover/secondary */
  --accent-glow:  /* ... */;  /* rgba version for box-shadow glow */

  /* Secondary accent — optional, creates tension and interest */
  --accent-2:      /* ... */;
  --accent-2-glow: /* ... */;

  /* Text hierarchy — 3 levels minimum */
  --text-primary:   /* ... */;  /* headings, important content */
  --text-secondary: /* ... */;  /* body text */
  --text-muted:     /* ... */;  /* labels, captions, placeholders */

  /* Borders — subtle, never heavy */
  --border:       /* ... */;
  --border-light: /* ... */;

  /* Status colors */
  --color-success: /* ... */;
  --color-warning: /* ... */;
  --color-error:   /* ... */;
  --color-info:    /* ... */;
}
```

**Color rules:**
- Accent color appears on ≤ 10% of the UI — the rest is neutrals
- Glow effects (`box-shadow` with accent color) are an **option**, not a
  default — see `anti-generic.md`. They read well on dark, less so on light.
- Gradients: use intentionally — diagonal or radial, never random
- Never use more than 2 accent colors — contrast creates interest, chaos kills it
- Avoid pure `#000000` and `#ffffff` — tinted neutrals feel more refined

**Choosing your palette:**
- Start from the brand's primary color, then derive the rest
- For dark themes: tint the background with the accent hue (e.g. a blue brand → slightly blue-black)
- For light themes: use off-whites with a warm or cool tint matching the brand
- Test contrast ratios: text must have ≥ 4.5:1 against its background
- **Pick light or dark as the PRIMARY mode based on the brand**, not habit.
  A children's reading app is light; a developer terminal tool is dark.
  Do not default to dark just because it "feels premium."

```css
/* ✅ Using tokens in components — no hex values */
/* Dark theme example: glow works, accent pops against deep background */
.theme-dark .button-primary {
  background: var(--accent);
  box-shadow: 0 0 24px var(--accent-glow);
}

/* Light theme example: solid fill, no glow — reads cleaner on light */
.theme-light .button-primary {
  background: var(--accent);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);  /* structural shadow, not glow */
}

/* Light theme card: elevation via shadow, not background lightness */
.theme-light .hero-title {
  color: var(--text-primary);  /* solid color — gradient text is optional, not required */
}
.theme-dark .hero-title {
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-light) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

> **Gradient text is a choice, not a default.** It suits dark themes and
> bold display type. On a light editorial layout, solid black headlines
> often read as more confident and distinctive. Match the technique to
> the brand, not to a habit.

---

### Typography — make type a design element

Typography is the fastest way to create a distinctive identity.
Pair a display font with a text font — never rely on a single font.

**How to choose fonts:**
- **Display font** (headings, hero text): pick one with personality that matches the brand
  - Geometric/modern: Space Grotesk, Syne, Clash Display
  - Humanist/warm: Cabinet Grotesk, Neue Montreal
  - Bold/impactful: Bebas Neue, Dela Gothic One
  - Elegant/serif: Playfair Display, Fraunces
  - Technical/mono: JetBrains Mono, IBM Plex Mono
- **Text font** (body, UI): pick one optimized for readability at small sizes
  - Inter, IBM Plex Sans, Source Sans 3, Nunito Sans, DM Sans

```css
:root {
  --font-display: /* your display font */, sans-serif;
  --font-text:    /* your text font */, sans-serif;
}
```

**Type scale — go big or go home:**
```css
.hero-heading {
  font-family: var(--font-display);
  font-size: clamp(3rem, 8vw, 7rem);  /* responsive giant type */
  font-weight: 800;
  line-height: 0.95;                  /* tight — feels editorial */
  letter-spacing: -0.03em;           /* negative tracking on large type */
}

.section-heading {
  font-size: clamp(1.75rem, 4vw, 3rem);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.body-text {
  font-size: 1rem;
  line-height: 1.7;
  color: var(--text-secondary);
}
```

**Typography tricks that create impact:**
```css
/* Outlined text — creates visual contrast */
.outline-text {
  -webkit-text-stroke: 1px var(--accent-light);
  color: transparent;
}

/* Mixed weight in a heading */
/* "Build something" (light) + "UNFORGETTABLE" (black weight) */

/* Oversized single letter as decorative element */
.decorative-letter {
  font-size: 20rem;
  opacity: 0.03;
  position: absolute;
  font-weight: 900;
  user-select: none;
}
```

---

### Spacing — breathing room creates quality

Quality design uses more space than you think is necessary.

```css
:root {
  /* Section padding — generous */
  --section-padding: clamp(4rem, 10vw, 8rem);

  /* Component spacing */
  --gap-xs: 0.5rem;
  --gap-sm: 1rem;
  --gap-md: 1.5rem;
  --gap-lg: 2.5rem;
  --gap-xl: 4rem;
}

/* ✅ Sections breathe */
.section {
  padding: var(--section-padding) 0;
}
```

---

### Elevation & depth

Elevation strategy depends on the theme — **both are equally valid**.
Do not assume dark; pick the mode the brand calls for (see `design-process.md`).

```css
/* Dark themes: elevation = lighter background, minimal shadows */
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
}
.card:hover {
  background: var(--bg-raised);
}

/* Light themes: elevation = shadow depth */
.card {
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
}
.card:hover {
  box-shadow: var(--shadow-md);
}

/* Use the token system from theming.md to handle both automatically */
```
