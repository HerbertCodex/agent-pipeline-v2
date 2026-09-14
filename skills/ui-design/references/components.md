> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Components

Non-generic patterns for common UI elements.
Every component here has personality — not just function.

> The examples below show **two directions**, not one. Direction A
> ("luminous") suits dark, technical, or futuristic brands. Direction B
> ("editorial") suits light, content-driven, or refined brands. Pick the
> direction that matches your brand brief (see `design-process.md`) — do
> not mix the two in one project.
>
> **Hard rule: choose ONE direction per project and apply it to every
> component.** Mixing Direction A buttons with Direction B cards in the
> same interface reads as inconsistent, not distinctive. If you're unsure
> which direction fits, decide in `design-process.md` Step 2 (visual
> genre) before reading this file.

---

### Buttons

#### Direction A — Luminous (dark, glow)

```css
/* ✅ Primary — glowing, magnetic feel */
.btn-primary {
  background: var(--accent);
  color: #fff;
  padding: 0.75rem 2rem;
  border-radius: 0.5rem;
  font-weight: 600;
  font-size: 0.9375rem;
  border: none;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  box-shadow: 0 0 20px var(--accent-glow);
  transition: box-shadow 0.3s ease, transform 0.15s ease;
}

/* Shimmer effect on hover */
.btn-primary::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.15) 50%, transparent 60%);
  transform: translateX(-100%);
  transition: transform 0.5s ease;
}
.btn-primary:hover::before { transform: translateX(100%); }
.btn-primary:hover {
  box-shadow: 0 0 40px var(--accent-glow), 0 0 80px var(--accent-subtle);
}
.btn-primary:active { transform: scale(0.97); }

/* ✅ Ghost — outlined, subtle */
.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  padding: 0.75rem 1.5rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.2s, border-color 0.2s, background 0.2s;
}
.btn-ghost:hover {
  color: var(--text-primary);
  border-color: rgba(255,255,255,0.2);
  background: var(--bg-surface);
}

/* ✅ Icon button with tooltip */
.btn-icon {
  width: 2.5rem;
  height: 2.5rem;
  display: grid;
  place-items: center;
  border-radius: 0.5rem;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-icon:hover {
  color: var(--text-primary);
  background: var(--bg-surface);
  border-color: rgba(255,255,255,0.15);
}
```

#### Direction B — Editorial (light, structural, no glow)

```css
/* ✅ Primary — solid fill, sharp or subtle radius, structural shadow */
.btn-primary {
  background: var(--accent);
  color: var(--bg-base);
  padding: 0.75rem 1.75rem;
  border-radius: 0;             /* sharp — editorial / technical */
  font-weight: 700;
  font-size: 0.875rem;
  letter-spacing: 0.02em;
  text-transform: uppercase;    /* editorial register */
  border: none;
  cursor: pointer;
  transition: background 0.2s ease;
}
.btn-primary:hover { background: var(--accent-light); }
.btn-primary:active { transform: translateY(1px); }  /* subtle press, no scale */

/* ✅ Ghost — thin underline draw, no border box */
.btn-ghost {
  background: transparent;
  color: var(--text-primary);
  padding: 0.75rem 0;
  border: none;
  font-weight: 500;
  font-size: 0.875rem;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: border-color 0.2s ease;
}
.btn-ghost:hover { border-bottom-color: var(--accent); }

/* ✅ Icon button — outlined square, fills on hover */
.btn-icon {
  width: 2.5rem;
  height: 2.5rem;
  display: grid;
  place-items: center;
  border-radius: 0;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.btn-icon:hover {
  color: var(--bg-base);
  background: var(--accent);
  border-color: var(--accent);
}
```

---

### Cards

#### Direction A — Luminous (dark, glow on hover)

```css
/* ✅ Feature card — glows on hover, accent border */
.feature-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 1rem;
  padding: 2rem;
  position: relative;
  overflow: hidden;
  transition: border-color 0.3s ease, transform 0.3s ease;
}

/* Top border accent */
.feature-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.feature-card:hover {
  border-color: var(--accent-glow);
  transform: translateY(-4px);
}
.feature-card:hover::before { opacity: 1; }

/* Icon container */
.card-icon {
  width: 3rem;
  height: 3rem;
  border-radius: 0.75rem;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  display: grid;
  place-items: center;
  margin-bottom: 1.5rem;
  box-shadow: 0 8px 16px var(--accent-glow);
}

/* ✅ Stat card — number-forward */
.stat-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 1rem;
  padding: 1.5rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.stat-value {
  font-size: 2.5rem;
  font-weight: 800;
  font-family: var(--font-display);
  background: linear-gradient(135deg, var(--text-primary), var(--accent-light));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  line-height: 1;
}
.stat-label {
  font-size: 0.875rem;
  color: var(--text-muted);
}
.stat-delta {
  font-size: 0.8125rem;
  color: var(--color-success);
  margin-top: 0.5rem;
}
```

#### Direction B — Editorial (light, structural, no glow)

```css
/* ✅ Feature card — border thickens on hover, no transform, no glow */
.feature-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 0;            /* sharp corners — editorial register */
  padding: 2rem;
  transition: border-width 0.15s ease, border-color 0.15s ease;
}
.feature-card:hover {
  border-width: 2px;
  border-color: var(--accent);
  /* no translateY, no glow — the border IS the feedback */
}

/* Icon container — solid square, no gradient, no shadow */
.card-icon {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 0;
  background: var(--accent);
  display: grid;
  place-items: center;
  margin-bottom: 1.25rem;
  color: var(--bg-base);
}

/* ✅ Stat card — number in display font, solid color, no gradient text */
.stat-card {
  background: transparent;     /* no card background — sits on the page */
  border-top: 1px solid var(--border);
  padding: 1.5rem 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.stat-value {
  font-size: clamp(2.5rem, 5vw, 3.5rem);
  font-weight: 800;
  font-family: var(--font-display);
  color: var(--text-primary);  /* solid — no gradient clip */
  line-height: 1;
  letter-spacing: -0.02em;
}
.stat-label {
  font-size: 0.8125rem;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

---

### Navigation

```css
/* ✅ Navbar — frosted glass, not solid */
.navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  padding: 1rem 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(10, 10, 15, 0.6);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border-light);
}

/* Active nav item */
.nav-item {
  color: var(--text-muted);
  font-size: 0.875rem;
  font-weight: 500;
  text-decoration: none;
  padding: 0.4rem 0.75rem;
  border-radius: 0.375rem;
  transition: color 0.2s, background 0.2s;
  position: relative;
}
.nav-item:hover { color: var(--text-primary); background: var(--bg-surface); }
.nav-item.active { color: var(--text-primary); }
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

---

### Forms & Inputs

```css
/* ✅ Input with glow on focus */
.form-group { display: flex; flex-direction: column; gap: 0.5rem; }

.form-label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  letter-spacing: 0.01em;
}

.form-input {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  color: var(--text-primary);
  font-size: 0.9375rem;
  width: 100%;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.form-input::placeholder { color: var(--text-muted); }
.form-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow), inset 0 0 0 1px var(--accent);
}
.form-input:hover:not(:focus) {
  border-color: rgba(255,255,255,0.15);
}
```

---

### Badges & Tags

```css
/* ✅ Badge with glow */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.badge-accent {
  background: var(--accent-subtle);
  color: var(--accent-light);
  border: 1px solid var(--accent-glow);
}

.badge-success {
  background: rgba(74, 222, 128, 0.1);
  color: #4ade80;
  border: 1px solid rgba(74, 222, 128, 0.2);
}

.badge-new {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: white;
  box-shadow: 0 2px 8px var(--accent-glow);
}

/* ✅ Dot indicator */
.badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
```