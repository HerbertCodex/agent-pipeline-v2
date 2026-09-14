> Reference adapted from the supplied V1 archive. Engineering examples only: the approved V2 spec, role permissions and project gates take precedence. No command or numeric style threshold here grants permission or creates an automatic gate.

## Design Process — Before You Write Any CSS

A distinctive interface is the result of **decisions made before coding**,
not styles invented while typing. This file defines the sequence to follow
at the start of any UI task. Skipping straight to components is how
generic output happens.

> **Language note:** This process is stack- and framework-agnostic. It
> produces decisions (tokens, type, layout intent) that feed into
> `visual-identity.md`, `layout.md`, and `components.md`.

> **Agent note:** An AI agent cannot browse visual sites (Awwwards,
> Dribbble) or evaluate screenshots aesthetically. The steps below are
> written so they work **without live browsing**: use the project context
> (existing tokens, brand description, user-provided references) where a
> human designer would use a moodboard. When no brand context exists,
> use the fallback decision tables in each step — they give defensible
> defaults that avoid the generic fingerprints.

---

### When to use the full process vs. the fast path

- **Full process (all 6 steps):** new project, new visual identity, or a
  landing page / marketing site where distinctiveness is the goal.
- **Fast path (skip to Step 3):** a component or screen inside an
  existing design system that already has tokens, fonts, and a layout
  language defined. Reuse the existing decisions — don't reinvent.

If existing tokens exist in the project, read them first and follow them.
The process below is for **establishing** decisions, not overriding
existing ones.

---

### Step 1 — Understand the brand and audience

Answer these before touching a token. If the project has no brand yet,
propose answers based on the product description and get them approved.

```
1. Personality — pick 1–2 adjectives (e.g. "technical + trustworthy",
   "playful + bold", "calm + editorial"). These drive every later choice.
2. Audience — who reads this? A fintech dashboard for traders and a
   children's reading app share almost no visual decisions.
3. Tone register — formal, neutral, or conversational? Affects micro-copy
   AND typography (a serif feels formal, a rounded sans feels friendly).
4. Competitive landscape — what do 3–5 direct competitors share (genre
   conventions to respect per Jakob's Law) and where is there room to differ?
```

**Fallback if no brand context is provided** — infer from product type:

| Product type | Likely personality | Mode | Register |
|---|---|---|---|
| Developer tool / CLI / terminal | technical, utilitarian | dark | neutral |
| Fintech / B2B SaaS dashboard | trustworthy, precise | light or dark | formal |
| Consumer app (social, reading, kids) | friendly, approachable | light | conversational |
| Editorial / magazine / content | calm, refined | light | formal |
| Creative tool / portfolio | bold, expressive | either | neutral |
| Enterprise / corporate | professional, stable | light | formal |

> These are starting points to **react to and revise**, not fixed answers.
> State the inferred personality aloud, then check it against the product.

**Output of step 1:** a one-paragraph brand brief. Everything downstream
must be justifiable against it.

---

### Step 2 — Establish the visual reference (without browsing)

A human designer collects screenshots; an agent works from **described
references** and the brand brief. The goal is the same: don't invent an
identity from nothing — anchor it to a known visual genre.

```
How an agent establishes references without live browsing:

1. From the brand brief (Step 1), identify the visual genre:
   - "editorial magazine" → large serif headlines, generous whitespace,
     rule-based grids, minimal color
   - "developer terminal" → monospace details, high contrast, sharp corners
   - "brutalist" → raw borders, exposed structure, clashing color blocks
   - "Swiss / International" → strict grid, Helvetica-adjacent sans,
     red/black/white, asymmetric
   - "luminous / futuristic" → dark base, glow accents, geometric type

2. Name 2–3 genres that fit the brief, then pick ONE as the primary anchor.
   Do NOT pick "luminous dark SaaS" by default — it is the most common
   AI output and the most recognizable.

3. If the user provides links, screenshots, or an existing site to match,
   treat those as the reference and skip the genre inference.

4. Write down the chosen genre + one sentence: "This genre suits the brand
   because ___." If you can't finish the sentence, pick a different genre.
```

**Anti-pattern:** defaulting to "premium dark + glow" when the brief
doesn't explicitly call for it. That is the second cliché (see
`anti-generic.md`). Match the genre to the brand, not to habit.

**Output of step 2:** a named visual genre + one-line justification.
This replaces the human's moodboard as the anchor for token decisions.

---

### Step 3 — Define the constraints (creativity needs a box)

A design system with too many options produces inconsistent, generic-feeling
output. Pick a **tight** set of constraints and push them hard.

```
Color:      1 anchor + 1 optional secondary + a neutral ramp derived
            from the anchor. No more. (see visual-identity.md)
Type:       1 display + 1 text. 1 type scale (e.g. 6 steps). No more.
Spacing:    1 scale (e.g. 4px base → 5 steps). No one-off pixel values.
Radius:     1 value, or at most 2 (e.g. cards 12px, buttons pill). Pick
            and commit — sharp, rounded, or pill, not a mix.
Motion:     2 easings + 3 durations max. (see motion.md)
Elevation:  1 strategy per mode — light uses shadows, dark uses lightness.
```

> **Why this matters for "anti-generic":** constraints force commitment.
A design that commits to "sharp corners, two colors, one weight of type"
reads as intentional. A design with twelve colors and four radii reads
as "the AI used every option available."

**Output of step 3:** a one-page decision sheet listing the chosen
constraints. This becomes the seed of `tokens.css`.

---

### Step 4 — Decide the layout language

Before components, decide how the page *as a whole* behaves.

```
Ask:
- Containment: is this a contained, full-bleed, or mixed layout language?
  Pick a default and 1–2 exceptions — not a different container per section.
- Rhythm: consistent section height, or varied (short / tall / full-bleed)?
- Asymmetry: centered and symmetric, or deliberately off-axis? Commit to
  one posture; mixing both randomly reads as indecision.
- Grid: how many columns at desktop, and is it a strict grid or a relaxed
  one with intentional breaks?
```

Map this to the section list (hero, features, pricing, footer...) and
assign each a layout treatment from the *same* vocabulary. If every
section invents a new layout, the page feels chaotic, not distinctive.

**Output of step 4:** a layout sketch (wireframe or annotated outline)
showing containment and rhythm per section.

---

### Step 5 — Identify the "one memorable thing"

Every screen needs one element a visitor would remember after 2 seconds
(see the test in `anti-generic.md`). Decide what it is *now*, not at the end.

```
It could be:
- A typographic statement (oversized word, mixed weight, outlined type)
- A single bold color block or full-bleed section
- A data viz or product UI shot unique to this product
- A distinctive motion (one purposeful entrance, not many)
- An unconventional layout (asymmetric split, overlapping sections)

Pick ONE per screen. Two "wow" elements compete and neither is remembered.
```

**Fallback by genre** — when you can't decide, pick from the genre you
chose in Step 2 instead of defaulting to "glow on the hero":

| Genre | Default memorable element |
|---|---|
| Editorial | Oversized serif headline, asymmetric |
| Developer / terminal | Monospace labels, high-contrast code block |
| Brutalist | A clashing color block or exposed grid |
| Swiss / International | Red accent + strict asymmetric grid |
| Luminous / futuristic | One glowing CTA (only one element, not all) |
| Friendly / consumer | Rounded illustration or playful micro-interaction |

**Output of step 5:** a one-line note per screen: "The memorable element
is ___ because it communicates ___."

---

### Step 6 — Only now, write tokens and components

With the brand brief, visual genre, constraints, layout language, and
memorable element decided:

1. Write `tokens.css` from the constraint sheet (Step 3) — see `visual-identity.md`
2. Build the layout shell (Step 4) — see `layout.md`
3. Build components that serve the memorable element (Step 5) — see `components.md`
4. Add motion only where it clarifies — see `motion.md`

At each step, check the decision against the brand brief (Step 1). If a
choice can't be justified by the brief, it's a default creeping back in.

---

### Quick self-check before coding

```
□ I wrote a one-paragraph brand brief (Step 1)
□ I named a visual genre + one-line justification, not "premium dark" by default (Step 2)
□ I chose a tight constraint set: 1–2 colors, 2 fonts, 1 spacing scale, 1 radius (Step 3)
□ I assigned one layout treatment per section from a shared vocabulary (Step 4)
□ I named the ONE memorable element per screen (Step 5)
□ I can justify every token against the brand brief (Step 6)
```

If any box is unchecked, you are about to produce generic output — go back.