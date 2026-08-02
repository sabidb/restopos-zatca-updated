# Business types

RestoPOS runs **every business type from one app and one codebase**. The shared
core — cart, barcode/menu till, ZATCA invoicing, payments, reports, cloud sync —
is identical for all types and lives **outside** this folder. Everything that
makes a type look or feel different is data and lives **inside** it, one
sub-folder per type.

```
businessTypes/
  index.js          registry (single source of truth) + helpers
  <type>/
    index.js        the type's registry entry (label, icon, layout, features)
    theme.js        the type's colour override (front design)
    screens/        screens unique to this type (optional)
    README.md       (optional) notes for this type
```

## Add a new type

1. `mkdir src/businessTypes/<type>` and add `index.js` + `theme.js` (copy an
   existing type as a template).
2. Import the entry in `businessTypes/index.js` and drop it into
   `BUSINESS_TYPES`.

That's it. The registration picker, the trial validator, the till layout and
the theme all read from the registry, so a new type appears everywhere
automatically — nothing else to touch.

## What each type can vary

| Field | Effect |
| --- | --- |
| `posLayout` | `"grid"` (menu grid + cart) or `"scan"` (barcode-first till) |
| `nav` | `"topbar"` (flat bar) or `"sidebar"` (☰ drawer + quick tabs) |
| `icon` / `label` / `labelAr` / `desc` | shown in pickers and the drawer header |
| `navLabels` | per-type wording, e.g. `{ create: "Products" }` |
| `orderTypes` | the cart's order-type toggle |
| `hideAdvancedTabs` | Advanced-screen tabs this type doesn't use |
| `theme` | colour override — the front design (see `../lib/theme.js`) |
| `features` | capability flags (`tables`, `kot`, `loyalty`, …) |

> **Golden rule:** the shared core (ZATCA, payments, reports) stays one
> codebase. Never copy the app into a second repo per type — a fix or a law
> change must happen once, everywhere.

## How theming works

`src/lib/theme.js` exports one shared palette `C`. At boot, `main.jsx` calls
`applyBizTheme(bizTheme())`, which swaps **only the colour values** in `C` for
the active type's `theme.js` — so every existing `C.primary` read picks up the
type's colour without touching a single inline style. It never changes layout
or logic. A type change takes effect on the next load.

The colour override intentionally covers only accent colours (`primary*`,
`accent*`); the neutral `bg` / `card` / `text` stay shared so contrast and
readability are guaranteed for every type.
