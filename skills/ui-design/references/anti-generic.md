> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Anti-Generic — Breaking the Template

This file exists for one reason: to prevent the output from looking
like every other app built with the same tools.

---

### The generic app fingerprint

If the output has ≥ 3 of these traits, restart the design:

```
□ White or light gray (#f9fafb, #f3f4f6) as the background
□ A framework default color (Tailwind blue #3B82F6, violet #8B5CF6, emerald #10B981) as the primary
□ A single default font (Inter, system-ui) with no display font
□ Every section is max-w-7xl mx-auto px-4
□ Hero: centered title + subtitle + two buttons
□ Features section: 3-column icon + title + text cards
□ Pricing: 3 cards with a "Most popular" badge
□ CTA section: colored background + big title + button
□ Footer: 4-column link list
□ Navbar: logo left + links right + CTA button
```

This is the SaaS template. It works. It's forgettable.

---

### The second cliché — "premium dark + glow"

Escaping the SaaS template often leads to the **same** escape route:
dark `#0a0a0f` background, Space Grotesk / Syne, a single violet accent,
`box-shadow: 0 0 24px accent-glow` on every interactive element, a
blurry gradient orb behind the hero. This is now its own fingerprint —
recognizable as "AI that read an anti-generic guide."

```
□ Dark #0a0a0f-ish background with a single hue tint
□ One display font from the same short list (Syne, Space Grotesk, Clash Display)
□ Glow shadows (0 0 Npx accent-glow) on buttons, cards, inputs, focus rings
□ Radial gradient orb blurred behind the hero
□ Frosted-glass navbar with backdrop-filter
```

If the output has ≥ 3 of *these*, it has escaped one template only to
land in another. The goal is a design that belongs to **one** project —
not to a genre of "premium dark SaaS."

> **Dark is not banned.** A dark theme is the right call for developer
> tools, terminals, media viewers, and brands that are genuinely
> "luminous/futuristic." The problem is dark **by default** — chosen
> because it's easy, not because the brand demands it. If the brand
> brief points to dark, commit to it fully. If it doesn't, don't.
> See `design-process.md` Step 1 for how to decide.

> The sections below give **decision principles**, not fixed recipes.
> The specific font, color, or effect you pick matters less than *why*
> you picked it and *whether it serves the brand*. Two projects can both
> be "anti-generic" and look nothing alike.

---

### Override principles (not recipes)

**Don't replace one default with another.** The fix for "Inter everywhere"
is not "Space Grotesk everywhere" — it's choosing a typeface with a reason
tied to the brand's personality. Use the principle, then pick *your* answer.

**Choose with a reason, not from a list.** Before adopting any visual
element, be able to finish the sentence: "I chose this because the brand
is \_\_\_, and this element communicates \_\_\_." If you can't, it's a
default in disguise.

**Direction, not prescription — typography:**
```
The goal: a typeface that carries the brand's personality in its shapes.

Ask:
- Is the brand technical, editorial, playful, luxury, or utilitarian?
- Should the display font feel geometric, humanist, serif, or monospace?
- Can a single weight do the job, or do you need a wide weight range?

Then search the FULL font space — Google Fonts, Fontshare, commercial
foundries — not the same five names every guide lists. A typeface no one
else in your market uses is worth more than the "safe" pick.
```

**Fallback typeface pairings by genre** — when no reference is provided,
pick the row that matches the genre from `design-process.md` Step 2.
These are defensible starting points, not the only valid choice — adjust
once you have a reason to.

| Genre | Display font | Text font | Why this pairing |
|---|---|---|---|
| Editorial / content | Fraunces, Playfair Display | Source Serif 4, Newsreader | Serif display reads as literary, serif text keeps cohesion |
| Developer / terminal | JetBrains Mono, IBM Plex Mono | IBM Plex Sans | Mono display signals "code", plex sans is technical but readable |
| Swiss / International | Space Grotesk, Neue Montreal | Inter, DM Sans | Geometric sans, neutral text — grid-driven |
| Friendly / consumer | Cabinet Grotesk, Bricolage Grotesque | Nunito Sans, DM Sans | Humanist + rounded = approachable |
| Brutalist | Archivo, Any wide grotesque | IBM Plex Sans, Space Mono | Wide display + utilitarian text = raw |
| Luminous / futuristic | Syne, Clash Display | Inter, Space Grotesk | Geometric display + clean text = "tech" |

> Avoid pairing a display font from one genre with a text font from
> another — it reads as indecision. Both fonts should belong to the same
> visual world.

**Direction, not prescription — color:**
```css
/* The goal: a palette derived from the brand, not borrowed from a framework.

Principle: pick one anchor color that reflects the brand's personality,
then build neutrals and a secondary accent from it. Test the palette on
real component mockups before committing — a color that looks great in
isolation can clash inside a card next to text.

Avoid these because they signal "I didn't decide":
- Framework defaults (Tailwind blue/violet/emerald) used unmodified
- A single accent with no supporting neutrals derived from it
- Pure #000 / #fff anywhere

Tools like oklch() give perceptually uniform steps; use them to derive
tints and shades from your anchor instead of hardcoding hex values. */
```

**Direction, not prescription — layout:**
```css
/* The goal: each section has its own rhythm, not a repeating container.

Principle: vary containment between full-bleed, offset, and contained.
Introduce asymmetry or overlap where the content supports it. The
variation must feel intentional — a reason like "this section leads
into the next" — not random for its own sake.

Examples of intentional variation (not a fixed set — invent your own):
.section-fullbleed { width: 100%; }
.section-offset   { padding-left: 15vw; }     /* off-center, if it aids reading */
.section-split    { grid-template-columns: 40% 60%; }
.section-overlap  { margin-top: -4rem; }       /* only when content connects them */
*/
```

**Kill the hero cliché — by understanding why it fails, not by swapping clichés:**
```
Why "centered h1 + subtitle + two buttons" fails: it communicates nothing
about the product. It could be any product.

The fix is a hero that could only belong to THIS product:
- What is the single most important thing a visitor should grasp in 2s?
- What visual element makes that idea concrete? (data viz, product UI,
  abstract motion, a bold typographic statement — NOT a stock photo)
- What's the ONE action you want? Secondary actions compete — drop them.

This may be dark and oversized, or light and quiet, or split and
asymmetric. The form follows the message, not a template.
```

**Replace the features grid — by matching the structure to the content:**
```
Ask: are these features equal, sequenced, or hierarchical?

Equal peers      → a grid is fine, but vary card size or add a featured one
Sequenced steps  → timeline or numbered narrative, not a grid
One hero feature → large block + smaller supporting items, not 3 equal cards

The content's structure should dictate the layout, not the other way around.
```

---

### Glow, gradient text, and other "premium" tics

Glow shadows and gradient text are **options, not defaults**. They became
shorthand for "this is premium" and are now as recognizable as the clichés
they replaced.

```
Before adding a glow or gradient, ask:
- Does it serve the brand's personality, or am I adding it to look "designed"?
- If I removed it, would the element lose meaning — or just lose a tic?

A confident design can use flat colors, solid borders, and no shadows
at all. Minimalism with restraint reads as more premium than glow on
everything. Brutalist, editorial, and Swiss-influenced styles use almost
no glow — and they are the opposite of generic.
```

**Alternatives to glow for signaling interactivity:**
```css
/* Weight / color shift — no shadow needed */
.btn:hover { font-weight: 700; letter-spacing: 0.01em; }

/* Border weight change — subtle, structural */
.card:hover { border-width: 2px; }

/* Background fill — solid, not glowing */
.nav-item:hover { background: var(--bg-overlay); }

/* Inset shadow — reads as pressed, not glowing */
.btn:active { box-shadow: inset 0 2px 8px rgba(0,0,0,0.2); }

/* Underline draw — for links, animated width */
.link:hover { background-size: 100% 1px; }
```

**When glow IS the right call:** the brand is genuinely "luminous / neon /
futuristic," and it's used on ONE element type (e.g. only the primary CTA),
not sprayed across buttons, cards, inputs, and focus rings simultaneously.

---

### shadcn/ui — use but restyle

shadcn/ui components are a good base but produce identical-looking apps
if used without customization. The principle: treat shadcn as scaffolding,
not as a finished design. Restyle with your project's tokens and add at
least one personality detail per component that shadcn wouldn't ship by
default.

```tsx
// ❌ Use shadcn defaults — the component library IS the design
<Button>Get started</Button>

// ✅ Override with your tokens + one intentional personality choice
//    (here: a sharp 0px radius for a technical/industrial brand)
<Button
  className="
    bg-accent text-accent-foreground
    rounded-none border-2 border-accent
    font-semibold uppercase tracking-wider
    hover:bg-accent hover:text-background
  "
>
  Get started
</Button>
```

```css
/* Override shadcn defaults in globals.css with your project tokens */
:root {
  --primary: /* your brand accent in HSL or RGB */;
  --primary-foreground: /* contrast text for primary */;
  --background: /* your bg-base token */;
  --foreground: /* your text-primary token */;
  --border: /* your border token */;
  --radius: 0px; /* sharp corners for a technical brand — or 0.5rem, your call */
}
```

> The radius, border weight, and font treatment above are **examples of
> a decision**, not a recommendation. Your brand might call for pill
> buttons, no borders, and a serif label — that's equally valid if it
> serves the identity.

---

### Consistency with variety

Each section should have a dominant visual tone, but all sections
must feel like they belong to the same brand.

| Section | Principle | How |
|---|---|---|
| Hero | Maximum impact | Oversized type, unexpected layout, one strong visual |
| Features | Clarity + restraint | Generous space, restrained color, quality over quantity |
| Stats / Numbers | Strong hierarchy | Large numbers as design elements, clear data communication |
| CTA | Break the rhythm | Full-bleed color or texture, distinct from surrounding sections |
| Footer | Minimal | Only what's needed — no visual noise |

**The rule**: one dominant approach per section. Variety in treatment, unity in brand.


Before shipping any UI, apply this test to every screen:

```
1. Would a designer screenshot this and share it on Twitter/X?
2. If someone sees this for 2 seconds, do they remember something specific?
3. Does this look like it could be from exactly one company, or from any company?
4. Is there one element on this screen that makes someone stop scrolling?
5. Could this be mistaken for "premium dark SaaS"? If yes, what makes it yours?
```

If the answer to any of these is "no" or "I'm not sure" — there's work to do.
The fix is usually one of:
- Typography is too small or too safe → make it bigger and bolder, OR pick a less common typeface
- Color is too neutral → add one bold accent element tied to the brand
- Layout is too symmetric → introduce asymmetry or overlap with a reason
- Nothing moves → add one purposeful animation
- Everything glows → remove half the glows; confidence is restraint