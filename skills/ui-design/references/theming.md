> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Theming — Dark & Light Mode

Both modes are required. Neither is optional.
Dark mode ≠ inverted light mode. Light mode ≠ white background.
Each mode has its own elevation system, shadow rules, and color logic.

---

### Token system — single source of truth

Define semantic tokens that work in both modes.
Never hardcode colors — always reference a token.

```css
/* ─── Dark mode ─── */
/* Replace placeholder values with your project's brand colors */
:root[data-theme="dark"],
[data-theme="dark"] {
  /* Backgrounds — layered depth via lightness, not shadows */
  /* Tip: start from near-black, tint with your accent hue, increase lightness per level */
  --bg-base:    /* near-black with brand tint */;
  --bg-surface: /* slightly lighter — cards, panels */;
  --bg-raised:  /* lighter still — dropdowns, modals */;
  --bg-overlay: /* lightest — hover states */;

  /* Accent — derive from your brand's primary color */
  --accent:         /* brand primary */;
  --accent-light:   /* lighter variant */;
  --accent-glow:    /* brand primary at 0.3 opacity */;
  --accent-subtle:  /* brand primary at 0.12 opacity */;

  /* Secondary accent — optional */
  --accent-2:       /* complementary or analogous color */;
  --accent-2-glow:  /* secondary at 0.2 opacity */;

  /* Text */
  --text-primary:   /* near-white — headings */;
  --text-secondary: /* muted — body text */;
  --text-muted:     /* very muted — labels, captions */;

  /* Borders */
  --border:       rgba(255, 255, 255, 0.08);
  --border-light: rgba(255, 255, 255, 0.04);
  --border-focus: var(--accent);

  /* Elevation — dark uses lightness, not shadows */
  --shadow-sm: none;
  --shadow-md: none;
  --shadow-lg: 0 25px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.05);

  /* Status */
  --color-success: /* green that works on dark bg */;
  --color-warning: /* amber that works on dark bg */;
  --color-error:   /* red that works on dark bg */;
  --color-info:    var(--accent-light);
}

/* ─── Light mode ─── */
[data-theme="light"] {
  /* Backgrounds — crisp, never pure white */
  /* Tip: tint off-white with your brand hue for warmth or coolness */
  --bg-base:    /* off-white with brand tint */;
  --bg-surface: /* white or near-white — cards */;
  --bg-raised:  /* slightly tinted — elevated surfaces */;
  --bg-overlay: /* muted — overlays, hover */;

  /* Accent — same hue as dark mode, adjusted for contrast on light */
  --accent:         /* brand primary, darker for contrast */;
  --accent-light:   /* lighter variant */;
  --accent-glow:    /* brand primary at 0.15 opacity */;
  --accent-subtle:  /* brand primary at 0.08 opacity */;

  /* Secondary accent */
  --accent-2:       /* complementary or analogous, adjusted */;
  --accent-2-glow:  /* secondary at 0.12 opacity */;

  /* Text */
  --text-primary:   /* near-black — headings */;
  --text-secondary: /* medium gray — body text */;
  --text-muted:     /* light gray — labels, captions */;

  /* Borders — subtle on light */
  --border:       rgba(0, 0, 0, 0.08);
  --border-light: rgba(0, 0, 0, 0.04);
  --border-focus: var(--accent);

  /* Elevation — light uses shadows, not lightness */
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04);
  --shadow-lg: 0 20px 40px rgba(0,0,0,0.10), 0 8px 16px rgba(0,0,0,0.06);

  /* Status */
  --color-success: /* green that works on light bg */;
  --color-warning: /* amber that works on light bg */;
  --color-error:   /* red that works on light bg */;
  --color-info:    var(--accent);
}
```

---

### Key differences between modes

**Elevation:**
```css
/* Dark: elevation = lighter background */
.card { background: var(--bg-surface); }       /* lighter than base */
.modal { background: var(--bg-raised); }       /* even lighter */

/* Light: elevation = shadow depth */
.card { background: var(--bg-surface); box-shadow: var(--shadow-sm); }
.modal { background: var(--bg-surface); box-shadow: var(--shadow-lg); }
```

**Glow effects:**
```css
/* Dark: glows work and look premium */
.btn-primary {
  box-shadow: 0 0 24px var(--accent-glow);  /* visible on dark */
}

/* Light: reduce glow — too strong on light backgrounds */
[data-theme="light"] .btn-primary {
  box-shadow: 0 4px 12px var(--accent-glow);  /* subtler */
}
```

**Gradient text:**
```css
/* Works on both — adjust the colors */
.gradient-heading {
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-light) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
/* Token update handles the rest — no extra code needed */
```

**Backgrounds and texture:**
```css
/* Dark: noise + grid adds depth */
.noise-overlay { opacity: 0.04; }
.grid-bg { background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px); }

/* Light: reduce or remove — too visible on light */
[data-theme="light"] .noise-overlay { opacity: 0.02; }
[data-theme="light"] .grid-bg {
  background-image: linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px);
}
```

---

### System preference detection

Always respect the user's OS preference as the default.

```css
/* ✅ CSS-only — respects OS setting, no JS needed */
@media (prefers-color-scheme: dark) {
  :root { /* dark tokens already defined as default above */ }
}

@media (prefers-color-scheme: light) {
  :root {
    /* Copy light mode tokens here if :root defaults to dark */
    --bg-base: #fafafa;
    /* ... all light tokens */
  }
}
```

---

### Toggle system — by stack

The CSS token system and `[data-theme]` attribute work identically in every stack.
Only the toggle implementation changes.

---

#### Vanilla JS

```ts
// theme.ts — works in any project, no framework needed
type Theme = 'dark' | 'light' | 'system'

function getResolved(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return theme
}

function applyTheme(theme: Theme) {
  const resolved = getResolved(theme)
  document.documentElement.setAttribute('data-theme', resolved)
  localStorage.setItem('theme', theme)
}

function initTheme() {
  const stored = (localStorage.getItem('theme') as Theme) ?? 'system'
  applyTheme(stored)

  // Follow OS changes when in system mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = (localStorage.getItem('theme') as Theme) ?? 'system'
    if (current === 'system') applyTheme('system')
  })
}

// Wire up toggle buttons
document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
  btn.addEventListener('click', () => {
    applyTheme(btn.getAttribute('data-theme-toggle') as Theme)
    // Update active state
    document.querySelectorAll('[data-theme-toggle]').forEach(b =>
      b.classList.toggle('active', b === btn)
    )
  })
})

initTheme()
```

```html
<!-- HTML toggle -->
<!-- ⚠️ Emojis (☀️🌙💻) are the generic default — recognizable as "AI-built".
     Replace with custom SVG icons or a distinctive interaction tied to the brand.
     The markup below is intentionally icon-agnostic: swap the emoji for your
     own <svg>, icon font, or a custom control (slider, segmented pill, etc.). -->
<div class="theme-toggle" role="group" aria-label="Theme">
  <button data-theme-toggle="light"  title="Light" aria-label="Switch to light mode">
    <!-- your custom sun icon here -->
  </button>
  <button data-theme-toggle="dark"   title="Dark" aria-label="Switch to dark mode">
    <!-- your custom moon icon here -->
  </button>
  <button data-theme-toggle="system" title="System" aria-label="Follow system theme">
    <!-- your custom system icon here -->
  </button>
</div>
```

```css
/* ✅ Custom theme toggle — segmented pill, not three emoji buttons */
.theme-toggle {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  padding: 0.125rem;
  background: var(--bg-surface);
}
.theme-toggle button {
  min-height: 1.75rem;
  padding: 0 0.75rem;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: var(--radius-full);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background 0.2s ease, color 0.2s ease;
}
.theme-toggle button.active {
  background: var(--accent);
  color: var(--bg-base);
}
.theme-toggle button svg { width: 1rem; height: 1rem; }
```

---

#### React / Next.js

```tsx
// hooks/useTheme.ts
import { useState, useEffect } from 'react'

type Theme = 'dark' | 'light' | 'system'

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'system'
    return (localStorage.getItem('theme') as Theme) ?? 'system'
  })

  const setTheme = (t: Theme) => {
    setThemeState(t)
    const resolved = t === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : t
    document.documentElement.setAttribute('data-theme', resolved)
    localStorage.setItem('theme', t)
  }

  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  return { theme, setTheme }
}
```

```tsx
// components/ThemeToggle.tsx
import { useTheme } from '@/hooks/useTheme'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {(['light', 'dark', 'system'] as const).map(t => (
        <button key={t} onClick={() => setTheme(t)}
          className={theme === t ? 'active' : ''} aria-pressed={theme === t}>
          {t === 'light' ? '☀️' : t === 'dark' ? '🌙' : '💻'}
        </button>
      ))}
    </div>
  )
}
```

---

#### Vue 3

```ts
// composables/useTheme.ts
import { ref, watchEffect, onMounted } from 'vue'

type Theme = 'dark' | 'light' | 'system'

export function useTheme() {
  const theme = ref<Theme>('system')

  function resolve(t: Theme): 'dark' | 'light' {
    return t === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : t
  }

  function setTheme(t: Theme) {
    theme.value = t
    document.documentElement.setAttribute('data-theme', resolve(t))
    localStorage.setItem('theme', t)
  }

  onMounted(() => {
    theme.value = (localStorage.getItem('theme') as Theme) ?? 'system'
    document.documentElement.setAttribute('data-theme', resolve(theme.value))

    // Follow OS changes in system mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'system') {
        document.documentElement.setAttribute('data-theme', resolve('system'))
      }
    })
  })

  return { theme, setTheme }
}
```

```vue
<!-- components/ThemeToggle.vue -->
<script setup lang="ts">
import { useTheme } from '@/composables/useTheme'
const { theme, setTheme } = useTheme()
const options = [
  { value: 'light',  label: '☀️' },
  { value: 'dark',   label: '🌙' },
  { value: 'system', label: '💻' },
] as const
</script>

<template>
  <div class="theme-toggle" role="group" aria-label="Theme">
    <button
      v-for="opt in options" :key="opt.value"
      :class="{ active: theme === opt.value }"
      :aria-pressed="theme === opt.value"
      @click="setTheme(opt.value)"
    >{{ opt.label }}</button>
  </div>
</template>
```

---

#### Svelte 5

```ts
// stores/theme.svelte.ts
type Theme = 'dark' | 'light' | 'system'

function createTheme() {
  let theme = $state<Theme>('system')

  function resolve(t: Theme): 'dark' | 'light' {
    return t === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : t
  }

  function set(t: Theme) {
    theme = t
    document.documentElement.setAttribute('data-theme', resolve(t))
    localStorage.setItem('theme', t)
  }

  function init() {
    theme = (localStorage.getItem('theme') as Theme) ?? 'system'
    document.documentElement.setAttribute('data-theme', resolve(theme))

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme === 'system') {
        document.documentElement.setAttribute('data-theme', resolve('system'))
      }
    })
  }

  return { get theme() { return theme }, set, init }
}

export const themeStore = createTheme()
```

```svelte
<!-- ThemeToggle.svelte -->
<script lang="ts">
  import { themeStore } from '$lib/stores/theme.svelte'
  import { onMount } from 'svelte'

  onMount(() => themeStore.init())

  const options = [
    { value: 'light',  label: '☀️' },
    { value: 'dark',   label: '🌙' },
    { value: 'system', label: '💻' },
  ] as const
</script>

<div class="theme-toggle" role="group" aria-label="Theme">
  {#each options as opt}
    <button
      class:active={themeStore.theme === opt.value}
      aria-pressed={themeStore.theme === opt.value}
      onclick={() => themeStore.set(opt.value)}
    >{opt.label}</button>
  {/each}
</div>
```

---

#### Angular

```ts
// services/theme.service.ts
import { Injectable, signal, effect } from '@angular/core'
import { DOCUMENT } from '@angular/common'
import { inject } from '@angular/core'

type Theme = 'dark' | 'light' | 'system'

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private document = inject(DOCUMENT)
  theme = signal<Theme>('system')

  constructor() {
    // Init from localStorage
    const stored = localStorage.getItem('theme') as Theme ?? 'system'
    this.theme.set(stored)
    this.apply(stored)

    // Follow OS changes in system mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.theme() === 'system') this.apply('system')
    })

    // Apply on every change
    effect(() => {
      this.apply(this.theme())
      localStorage.setItem('theme', this.theme())
    })
  }

  setTheme(t: Theme) { this.theme.set(t) }

  private resolve(t: Theme): 'dark' | 'light' {
    return t === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : t
  }

  private apply(t: Theme) {
    this.document.documentElement.setAttribute('data-theme', this.resolve(t))
  }
}
```

```ts
// components/theme-toggle.component.ts
import { Component } from '@angular/core'
import { ThemeService } from '@/services/theme.service'

@Component({
  selector: 'app-theme-toggle',
  standalone: true,
  template: `
    <div class="theme-toggle" role="group" aria-label="Theme">
      @for (opt of options; track opt.value) {
        <button
          [class.active]="themeService.theme() === opt.value"
          [attr.aria-pressed]="themeService.theme() === opt.value"
          (click)="themeService.setTheme(opt.value)"
        >{{ opt.label }}</button>
      }
    </div>
  `
})
export class ThemeToggleComponent {
  themeService = inject(ThemeService)
  options = [
    { value: 'light'  as const, label: '☀️' },
    { value: 'dark'   as const, label: '🌙' },
    { value: 'system' as const, label: '💻' },
  ]
}
```

---

### Prevent FOUC — Flash of Unstyled Content

Without this, users see the wrong theme for a split second on page load.
This script must run **before** the rest of the page renders — in every stack.

```html
<!-- Universal — works in any stack. In <head>, before any CSS. Inline only. -->
<script>
  (function() {
    var stored = localStorage.getItem('theme')
    var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    var resolved = stored === 'light' ? 'light'
                 : stored === 'dark'  ? 'dark'
                 : systemDark         ? 'dark'
                 : 'light'
    document.documentElement.setAttribute('data-theme', resolved)
  })()
</script>
```

**Per-framework placement:**

```html
<!-- Vanilla / plain HTML — in <head> before stylesheets -->
<head>
  <script>/* FOUC script above */</script>
  <link rel="stylesheet" href="/styles.css" />
</head>
```

```tsx
// Next.js — app/layout.tsx
// Use suppressHydrationWarning to prevent React hydration mismatch
export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var stored = localStorage.getItem('theme')
            var systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
            var resolved = stored === 'light' ? 'light' : stored === 'dark' ? 'dark' : systemDark ? 'dark' : 'light'
            document.documentElement.setAttribute('data-theme', resolved)
          })()
        `}} />
      </head>
      <body>{children}</body>
    </html>
  )
}
```

```html
<!-- Vue / Nuxt — nuxt.config.ts or index.html -->
<!-- nuxt.config.ts -->
export default defineNuxtConfig({
  app: {
    head: {
      script: [{ innerHTML: `(function(){...})()`, tagPosition: 'head' }]
    }
  }
})
```

```html
<!-- SvelteKit — src/app.html -->
<!DOCTYPE html>
<html lang="en" %sveltekit.attributes%>
  <head>
    <script>/* FOUC script */</script>
    %sveltekit.head%
  </head>
  <body>%sveltekit.body%</body>
</html>
```

```html
<!-- Angular — index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <script>/* FOUC script */</script>
  </head>
  <body>
    <app-root></app-root>
  </body>
</html>
```

---

### Tailwind — extend config for both modes

```ts
// tailwind.config.ts — works in any framework using Tailwind
export default {
  darkMode: ['selector', '[data-theme="dark"]'], // use data-theme, not .dark class
  theme: {
    extend: {
      colors: {
        accent:           'var(--accent)',
        'accent-light':   'var(--accent-light)',
        'bg-base':        'var(--bg-base)',
        'bg-surface':     'var(--bg-surface)',
        'bg-raised':      'var(--bg-raised)',
        'text-primary':   'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted':     'var(--text-muted)',
        border:           'var(--border)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
    },
  },
}

// Usage — same in React, Vue, Svelte, Angular
// <div class="bg-bg-surface border border-border text-text-primary">
// <button class="bg-accent text-white shadow-md">
```

---

### Testing both modes

```
Before shipping any UI, test both modes:

1. Dark mode  → DevTools → Rendering → Emulate dark prefers-color-scheme
2. Light mode → DevTools → Rendering → Emulate light prefers-color-scheme
3. Toggle     → click the toggle in the app, verify instant switch, no flash
4. Persistence → reload page, verify mode is remembered
5. System sync → change OS setting while in "system" mode, verify it follows

Check in each mode:
□ Text contrast ≥ 4.5:1 (use DevTools → Accessibility → Color contrast)
□ Borders visible (not invisible on same-color backgrounds)
□ Glows not overwhelming (especially on light mode)
□ Shadows visible on light mode cards and modals
□ Focus rings visible in both modes
□ Status colors (success/error/warning) readable in both modes
```