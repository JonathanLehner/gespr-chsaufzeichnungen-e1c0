---
name: Gesprächsaufzeichnungen – Immotrust AG
description: Interne Anwendung zum Ablegen, Transkribieren, Durchsuchen und Bewerten von Verkaufsgesprächen.
colors:
  ink: "#101a24"
  ink-soft: "#4a5a6a"
  ink-faint: "#5f6d7b"
  line: "#dde3ea"
  line-strong: "#c3ccd6"
  surface: "#ffffff"
  canvas: "#f2f4f7"
  petrol: "#0e5567"
  petrol-dark: "#0a4150"
  petrol-soft: "#e4eef1"
  ok: "#1c6b45"
  ok-soft: "#e2f2ea"
  warn: "#8a5a06"
  warn-soft: "#fbf0d8"
  busy: "#1f4f9c"
  busy-soft: "#e4ecfa"
  bad: "#a12b1e"
  bad-soft: "#fbe6e3"
typography:
  display: { fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif", fontSize: "2.25rem", fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.025em" }
  headline: { fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif", fontSize: "1.25rem", fontWeight: 600, letterSpacing: "-0.025em" }
  title: { fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif", fontSize: "14px", fontWeight: 600 }
  body: { fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif", fontSize: "13px", fontWeight: 400, lineHeight: 1.625 }
  label: { fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif", fontSize: "0.75rem", fontWeight: 600, letterSpacing: "0.04em" }
  mono: { fontFamily: "Geist Mono, ui-monospace, monospace", fontSize: "11px" }
rounded: { sm: "4px", md: "6px", pill: "999px" }
spacing: { gutter: "20px", card: "20px", section: "56px" }
components:
  button-primary: { backgroundColor: "{colors.petrol}", textColor: "{colors.surface}", rounded: "{rounded.sm}", padding: "0.45rem 0.85rem" }
  button-primary-hover: { backgroundColor: "{colors.petrol-dark}" }
  button-secondary: { backgroundColor: "{colors.surface}", textColor: "{colors.ink}", rounded: "{rounded.sm}", padding: "0.45rem 0.85rem" }
  button-danger: { backgroundColor: "{colors.bad}", textColor: "{colors.surface}", rounded: "{rounded.sm}", padding: "0.45rem 0.85rem" }
  button-ghost: { textColor: "{colors.petrol}", rounded: "{rounded.sm}", padding: "0.25rem 0.4rem" }
  card: { backgroundColor: "{colors.surface}", rounded: "{rounded.md}", padding: "20px" }
  field: { backgroundColor: "{colors.surface}", textColor: "{colors.ink}", rounded: "{rounded.sm}", padding: "0.45rem 0.6rem" }
  nav-link-active: { backgroundColor: "{colors.petrol-soft}", textColor: "{colors.petrol}", rounded: "{rounded.sm}", padding: "6px 12px" }
---

# Design System: Gesprächsaufzeichnungen – Immotrust AG

## Overview

**Creative North Star: "Das Ablagepult"** – a calm, well-ordered work desk for the sales team. Dense, quiet and legible: cool grey canvas, white bordered surfaces, one petrol accent, small precise type. The app is a tool used daily, not a showcase; the public pages (landing, auth) speak the same restrained language and only add two photographs.

**Key Characteristics:**
- Flat white panels on a cool grey canvas, separated by 1px hairlines, not shadows.
- One accent (petrol) for action, focus and the active place; status colours only for status.
- Compact type (11–15px for working UI), Geist throughout, tabular numerals in tables.
- German (Swiss orthography: "ss", de-CH number formats), factual and complete-sentence copy.

## Colors

Cool, desaturated neutrals carrying a single deep petrol accent and a four-part status set.

### Primary
- **Petrol** (#0e5567): primary buttons, ghost buttons, links, focus outline, active nav text. **Petrol Dark** (#0a4150) is its hover. **Petrol Mist** (#e4eef1) backs active nav items, the Superuser tag, ghost hover and `notice-info`.

### Neutral
- **Ink** (#101a24): headings and primary text. **Ink Soft** (#4a5a6a): body copy, labels, table headers. **Ink Faint** (#5f6d7b): metadata, footers, placeholders, empty-value dashes; darkened to pass WCAG AA on white and canvas.
- **Line** (#dde3ea): every card border, divider and table rule. **Line Strong** (#c3ccd6): field and secondary-button borders.
- **Surface** (#ffffff): cards, headers, footers. **Canvas** (#f2f4f7): page background.

### Status
- Pairs of strong + soft: **ok** (#1c6b45 / #e2f2ea), **warn** (#8a5a06 / #fbf0d8), **busy** (#1f4f9c / #e4ecfa), **bad** (#a12b1e / #fbe6e3). Badges use soft background + strong text; notices use soft background, a mid-tone border and a darker text shade.

**The One Accent Rule.** Petrol is the only brand colour in the UI. Status colours never decorate; a neutral state without error (e.g. "Keine Sprache") uses canvas + ink-soft, not red or green.

## Typography

**Font:** Geist (via `next/font`, `--font-geist-sans`), fallback ui-sans-serif/system-ui. **Mono:** Geist Mono for file names, e-mail addresses and IDs (12px, ink-faint).

**Character:** neutral, technical grotesk; hierarchy comes from weight 600 and size, never from a second family.

### Hierarchy
- **Display** (600, 2.25rem / `text-4xl`, 1.1, tight tracking): landing hero h1 only.
- **Headline** (600, 1.25rem / `text-xl`, tight tracking): page h1 in the app and auth card, section h2 on public pages.
- **Title** (600, 13–14px): card and feature headings.
- **Body** (400, 13px, relaxed 1.625): standard running text; 15px for the hero intro, max-w-xl.
- **Meta** (400, 12px min, ink-faint): timestamps, footers, counts.
- **Label** (600, 12px, +0.04em, uppercase, ink-soft): `.label` above form fields; table headers `.th` at 11px, 700, +0.06em.

**The Tabular Rule.** Tables and numeric stats use `tabular-nums`; ratings render with de-CH decimals ("7,5 /10 · 3").

## Layout

- **Public pages** (landing, auth header, public footer): `max-w-6xl` (72rem) centred, `px-5` gutter; sections `py-14`, header `h-14`.
- **Auth pages:** content grid `max-w-5xl`, `py-12`; form card + 460px image aside from `lg`, image hidden below.
- **App:** sticky `h-14` header and main at `max-w-[1500px] px-5 py-6`; footer `py-4`, 11px.
- Rhythm on Tailwind's 4px scale: `gap-2`/`gap-3` inside controls, `space-y-4` between form groups, cards `p-5` (`p-4` dense, `p-7`/`p-8` auth/standalone).
- **Responsive:** app nav collapses below `md` (768px) into a "Menü" toggle; the recordings table becomes stacked cards below 700px (`.stack-cards`); public grids go 1 → 2 → 3 columns.

## Elevation & Depth

Flat by default. Depth is tonal (white surface on canvas) plus 1px `line` borders. Feature grids use the `gap-px` on `bg-line` technique for hairline dividers.

### Shadow Vocabulary
- **Floating** (`box-shadow: 0 8px 20px rgba(16,26,36,0.14)` / Tailwind `shadow-lg`): only for elements that float over content – the focused skip link and transient confirmation notices.

**The Flat Rest Rule.** Nothing at rest casts a shadow; cards, headers and images are bordered, not lifted.

## Shapes

Small, firm corners: 4px for controls (buttons, fields, notices, nav links), 6px (`rounded-md`) for cards and image frames, pill only for badges. Images sit in `overflow-hidden rounded-md border border-line` frames.

## Components

### Buttons
- **Shape:** 4px radius, 1px border, 13px/600, `0.45rem 0.85rem` padding, 120ms colour transition.
- **Primary:** petrol on white text, hover petrol-dark. One primary per action group.
- **Secondary:** surface with line-strong border, hover #eef1f5. **Danger:** bad, hover #86231a, only for irreversible deletion. **Ghost:** petrol text, compact, petrol-soft hover.
- **Disabled:** opacity 0.55, not-allowed cursor. Pending states change the label ("Anmeldung läuft …").

### Cards
- `.card`: surface, 1px line border, 6px radius, no shadow, padding per Layout.

### Inputs / Fields
- `.field`: full width, line-strong border, 4px radius, 14px text. Focus uses the global 2px petrol outline (offset 2px). Invalid: `aria-invalid="true"` gives border #d08b81 on #fdf5f4. Disabled: #f6f8fa, ink-faint text. Always paired with a `.label`.

### Notices and Badges
- `.notice` (`-error`, `-ok`, `-info`, `-warn`): 4px radius, 1px tinted border, 13px/1.45; form results use `role="alert"`.
- Auth pages whose link failed (`AuthShell tone="error"`): no notice box. The card heading turns bad red, the explanation stays ink body text, a 1px bad rule runs on the left, and the actions sit right below with the recovery as `btn-primary` first.
- `.badge`: pill, 11px/600; status badges lead with a 6px `bg-current` dot.

### Navigation
- Nav links 13px/500, 4px radius, `px-3 py-1.5`; inactive ink-soft with canvas hover, active petrol on petrol-soft with `aria-current="page"`. A keyboard-only skip link precedes everything.

### Imagery
- Two photographs only (hero, portal), prebuilt at build time as WebP 640w/960w in `public/bilder`, served via plain `<img srcSet sizes>` with explicit width/height and aspect-ratio; no runtime optimisation. Logo is the prebuilt `public/marke/logo-112.webp`.
- Only the LCP / above-the-fold image loads eagerly with `fetchPriority="high"`; every other image is `loading="lazy"`. Images hidden at a breakpoint use `<picture><source media>` so they download nothing where hidden.

## Do's and Don'ts

### Do:
- **Do** use the tokens and `.card`/`.btn`/`.field`/`.notice`/`.badge` classes from `globals.css` instead of ad-hoc colours.
- **Do** write copy in German with Swiss orthography ("ausschliesslich", "Schliessen"), formal "Sie", full sentences that say what happened and what to do next ("Bitte laden Sie die Seite neu.").
- **Do** keep working-UI text at 11–14px and reserve `text-xl`+ for page headings.
- **Do** give every image explicit dimensions and a descriptive German `alt`.

### Don't:
- **Don't** add shadows, gradients or a second accent to resting surfaces.
- **Don't** use status colours for decoration or emphasis.
- **Don't** add uppercase tracked kickers above headings; the existing ones on the landing and 404 pages are not part of the system.
- **Don't** load more than one image eagerly per page.
