> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Performance

Performance is part of the design. A beautiful interface that loads slowly
or jitters feels cheap. These rules are non-negotiable.

---

### Fonts — the #1 cause of FOUT and layout shift

```html
<!-- ✅ Preconnect + preload — load fonts as early as possible -->
<head>
  <!-- Step 1: preconnect to font CDN -->
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />

  <!-- Step 2: preload the critical weight (display font, heaviest weight) -->
  <link
    rel="preload"
    href="https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_04uQ.woff2"
    as="font"
    type="font/woff2"
    crossorigin
  />

  <!-- Step 3: load all weights with display=swap -->
  <link
    href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Inter:wght@400;500&display=swap"
    rel="stylesheet"
  />
</head>
```

```css
/* ✅ Font-display: swap — text visible immediately, swaps when font loads */
@font-face {
  font-family: 'Syne';
  font-display: swap;  /* never use block or auto */
  src: url('/fonts/syne-bold.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
}

/* ✅ System font fallback that matches your display font metrics */
/* Prevents layout shift when the font swaps in */
:root {
  --font-display: 'Syne', 'Arial Black', sans-serif;
  --font-text: 'Inter', system-ui, -apple-system, sans-serif;
}
```

**Self-host fonts when possible** — eliminates third-party DNS lookup:
```
1. Download from Google Fonts (fontsource.org or google-webfonts-helper.herokuapp.com)
2. Place in /public/fonts/
3. Use @font-face with font-display: swap
4. Ship only the weights you actually use
```

---

### Images — never cause layout shift

Always provide `width` and `height` attributes. The browser needs them
to reserve space before the image loads.

```html
<!-- ✅ Fixed dimensions — browser reserves space immediately -->
<img src="/hero-visual.webp" width="600" height="400" alt="..." loading="lazy" />

<!-- ✅ Responsive image — browser picks the right size -->
<img
  src="/card-image.webp"
  srcset="/card-image-400.webp 400w, /card-image-800.webp 800w"
  sizes="(min-width: 768px) 400px, 100vw"
  width="800"
  height="600"
  alt="..."
  loading="lazy"
  decoding="async"
/>

<!-- ❌ No dimensions — causes layout shift as image loads -->
<img src="/hero.jpg" alt="..." />
```

```tsx
// ✅ Next.js — use Image component, handles everything
import Image from 'next/image'

<Image
  src="/hero-visual.webp"
  width={600}
  height={400}
  alt="..."
  priority={true}  // for above-the-fold images — don't lazy load these
  quality={85}
/>

// Above the fold → priority={true}
// Below the fold → priority={false} (default, lazy loads)
```

**Image formats:**
```
WebP  → best default — 25-35% smaller than PNG/JPEG at same quality
AVIF  → even better compression, but slower to encode
SVG   → icons, logos, illustrations — infinitely scalable, tiny size
PNG   → only when transparency + no WebP support needed
JPEG  → never use in new projects — WebP is strictly better
```

---

### Animations — GPU only, no reflow

```css
/* ✅ GPU-accelerated properties — smooth on all devices */
transform: translateX(10px) rotate(5deg) scale(1.05);
opacity: 0.8;

/* ❌ Layout-triggering properties — cause reflow, cause jank */
width: 200px;       /* triggers layout */
height: 100px;      /* triggers layout */
top: 20px;          /* triggers layout */
left: 30px;         /* triggers layout */
margin: 10px;       /* triggers layout */
padding: 20px;      /* triggers layout */
font-size: 2rem;    /* triggers layout */

/* ✅ Promote to GPU layer for elements that animate frequently */
.animated-element {
  will-change: transform, opacity;
  /* ⚠️ Use sparingly — creates a new compositing layer (memory cost) */
  /* Remove will-change after animation if possible */
}

/* ✅ Contain layout for animated sections */
.animation-container {
  contain: layout style;  /* prevents animation from affecting outside elements */
}
```

```ts
// ✅ Remove will-change after animation in JS
element.addEventListener('transitionend', () => {
  element.style.willChange = 'auto'
})
```

---

### CSS — load only what you need

```css
/* ✅ Critical CSS inline — styles needed for above-the-fold content */
/* In <style> in <head> — renders without waiting for external CSS */
/* Everything else in external stylesheet */

/* ✅ Layer CSS to control specificity and load order */
@layer reset, tokens, base, components, utilities;

@layer tokens {
  :root { --accent: #7c3aed; }
}
@layer base {
  *, *::before, *::after { box-sizing: border-box; }
}
@layer components {
  .btn-primary { ... }
}
```

```ts
// ✅ Lazy-load heavy CSS — animations only when visible
const loadAnimations = async () => {
  const { default: gsap } = await import('gsap')
  const { ScrollTrigger } = await import('gsap/ScrollTrigger')
  gsap.registerPlugin(ScrollTrigger)
  // initialize animations
}

// Only load when the element enters viewport
const observer = new IntersectionObserver(([entry]) => {
  if (entry.isIntersecting) {
    loadAnimations()
    observer.disconnect()
  }
})
observer.observe(document.querySelector('.animated-section'))
```

---

### JS bundles — don't load what you don't need

```ts
// ✅ Dynamic import — load heavy libraries only when needed
// Framer Motion — tree-shakeable, import only what you use
import { motion } from 'framer-motion'       // ❌ full bundle
import { m } from 'framer-motion'            // ✅ lighter version
import { LazyMotion, domAnimation, m } from 'framer-motion' // ✅ lightest

// GSAP — import only the plugins you use
import gsap from 'gsap'                          // core only
import { ScrollTrigger } from 'gsap/ScrollTrigger' // only if needed
// Don't import the whole GSAP bundle

// ✅ Lazy-load GSAP — only when a scroll-animated section is near
const initScrollAnimations = async () => {
  const [{ default: gsap }, { ScrollTrigger }] = await Promise.all([
    import('gsap'),
    import('gsap/ScrollTrigger'),
  ])
  gsap.registerPlugin(ScrollTrigger)
}
```

---

### Core Web Vitals — the three numbers that matter

| Metric | What it measures | Target | Common cause of failure |
|---|---|---|---|
| **LCP** Largest Contentful Paint | How fast the main content loads | < 2.5s | Unoptimized hero image, render-blocking fonts |
| **CLS** Cumulative Layout Shift | How much the layout jumps | < 0.1 | Images without dimensions, late-loading fonts |
| **INP** Interaction to Next Paint | How fast UI responds to input | < 200ms | Heavy JS on main thread, layout-triggering animations |

```ts
// ✅ Measure in the browser during development
// Open DevTools → Performance → record a page load
// Or use: web.dev/measure

// ✅ Quick CLS check — run in console
let cls = 0
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (!entry.hadRecentInput) cls += entry.value
  }
  console.log('CLS:', cls)
}).observe({ type: 'layout-shift', buffered: true })
```

---

### Render-blocking resources — eliminate them

```html
<!-- ✅ CSS — load non-critical styles asynchronously -->
<link
  rel="preload"
  href="/styles/main.css"
  as="style"
  onload="this.onload=null;this.rel='stylesheet'"
/>
<noscript><link rel="stylesheet" href="/styles/main.css" /></noscript>

<!-- ✅ Scripts — always defer or async -->
<script src="/app.js" defer></script>      <!-- executes after HTML parsed -->
<script src="/analytics.js" async></script> <!-- executes as soon as loaded -->

<!-- ❌ Blocking script in <head> -->
<script src="/app.js"></script>            <!-- blocks rendering -->
```

---

### Checklist — before shipping any UI

```
LCP:
□ Hero image is WebP, preloaded with <link rel="preload">
□ Hero image has priority loading (not lazy)
□ Display font is preloaded
□ font-display: swap on all @font-face rules

CLS:
□ All images have explicit width and height attributes
□ Fonts have a metric-matched fallback (no layout shift on swap)
□ No content inserted above existing content after load

INP:
□ No layout-triggering properties animated (only transform + opacity)
□ will-change used sparingly, removed after animation
□ Heavy libraries (GSAP, Three.js) lazy-loaded
□ No synchronous heavy computation on click/input handlers
```