# Adding a new business type

RestoPOS runs **every business type from one app and one codebase** — Restaurant,
Supermarket, and any type you add next (pharmacy, café, salon, …). The business
type is just **data on the license** (`license.businessType`); the same products,
sales, ZATCA invoicing, payments, and reports are shared by all types.

All the differences between types live in **one place**: the `BUSINESS_TYPES`
registry near the top of [`src/App.jsx`](src/App.jsx) (search for
`const BUSINESS_TYPES`). Adding a type is **one entry there** plus any screens
unique to that type — you never hunt through the code flipping `if` checks.

> Golden rule: **never** copy the app into a second repo per business type. The
> shared core (ZATCA, payments, reports) must stay one codebase so a fix or a
> law change happens once, everywhere.

---

## 1. The registry

```js
const BUSINESS_TYPES = {
  restaurant: {
    id:"restaurant", label:"Restaurant", labelAr:"مطعم", icon:"🍽️",
    posLayout:"grid", nav:"topbar",
    features:{ tables:true, dineIn:true, kot:true, kitchen:true, kds:true, recipes:true, weighing:false, barcodeFirst:false },
    orderTypes:[["takeaway","🥡","Takeaway"],["dine-in","🍽","Dine-in"],["delivery","🛵","Delivery"]],
    hideAdvancedTabs:[],
    navLabels:{},
  },
  supermarket:{
    id:"supermarket", label:"Supermarket", labelAr:"سوبرماركت", icon:"🛒",
    posLayout:"scan", nav:"sidebar",
    features:{ tables:false, dineIn:false, kot:false, kitchen:false, kds:false, recipes:false, weighing:true, barcodeFirst:true },
    orderTypes:[["takeaway","🛒","Sale"],["delivery","🛵","Delivery"]],
    hideAdvancedTabs:["kitchen","kds","recipes"],
    navLabels:{ create:"Products" },
  },
};
```

The app reads the active type through three helpers (also in `src/App.jsx`):

| Helper | Returns |
| --- | --- |
| `getBusinessType(license)` | the type id, e.g. `"supermarket"` (falls back to `restaurant` for anything unknown — a bad value can never crash the app) |
| `bizProfile(license)` | the whole profile object for the active type |
| `bizFeature("kot", license)` | a single capability flag, `true` / `false` |

`license` is optional everywhere — omit it and the helpers read the saved license.

---

## 2. What each field does

| Field | Values | Effect (where it's read) |
| --- | --- | --- |
| `id` | string | Must equal the key and match `license.businessType`. |
| `label` / `labelAr` | string | Shown in the sidebar drawer header (Arabic used when the app is in Arabic). |
| `icon` | emoji | Shown beside the label. |
| `posLayout` | `"grid"` \| `"scan"` | `"grid"` = menu-card grid + cart (restaurant). `"scan"` = barcode-first scan till with the A/B/C layouts (POS reads `posLayout === "scan"`). |
| `nav` | `"topbar"` \| `"sidebar"` | `"topbar"` = flat top bar. `"sidebar"` = ☰ drawer + logo + quick POS/Transactions tabs (App reads `nav === "sidebar"`). |
| `orderTypes` | `[[id, icon, label], …]` | The order-type buttons on the cart. |
| `hideAdvancedTabs` | `[tabId, …]` | Tabs removed from the **Advanced** screen (e.g. `"kitchen"`, `"kds"`, `"recipes"`). |
| `navLabels` | `{ navId: "Label" }` | Rename a nav item for this type (supermarket renames `create` → `Products`). |
| `features` | see below | Capability flags the UI switches on. |

### Feature flags

**Live today** — these are actively read by the app:

| Flag | When `true` |
| --- | --- |
| `tables` | Settings shows the **Tables** tab; when `false` it shows the **Checkout** (scan-layout picker) tab instead. |
| `kot` | Completed sales auto-print a **kitchen ticket (KOT)**. `false` = never (e.g. supermarket has no kitchen). |
| `weighing` | Products can be marked **weighed / per-kg**, and the ⚖ Weigh flow appears at the till. |

**Reserved / declarative** — set them truthfully for your type. They document
intent and are ready to wire to new screens: `dineIn`, `kitchen`, `kds`,
`recipes`, `barcodeFirst`. (Today the kitchen/KDS/recipes **screens** are
removed via `hideAdvancedTabs`, so set both consistently.)

---

## 3. Steps to add a type

Example: a **pharmacy**.

1. **Add the entry** to `BUSINESS_TYPES` in `src/App.jsx`:
   ```js
   pharmacy:{
     id:"pharmacy", label:"Pharmacy", labelAr:"صيدلية", icon:"💊",
     posLayout:"scan", nav:"sidebar",
     features:{ tables:false, dineIn:false, kot:false, kitchen:false, kds:false, recipes:false, weighing:false, barcodeFirst:true },
     orderTypes:[["takeaway","💊","Sale"],["delivery","🛵","Delivery"]],
     hideAdvancedTabs:["kitchen","kds","recipes"],
     navLabels:{ create:"Products" },
   },
   ```
2. **Let clients pick it.** Wherever the business type is chosen (trial signup /
   admin), add the new option so it can be written to `license.businessType`.
   Search the codebase for `"supermarket"` in the signup/mode-switch UI and add
   `"pharmacy"` alongside it.
3. **Only if the type needs something genuinely new** (a screen or rule no other
   type has), build that as its own component and show it based on the profile —
   e.g. `bizProfile().id === "pharmacy"` or a new feature flag like
   `features.prescriptions`. Reuse existing screens for everything else.
4. **Add a new feature flag** (optional) if a behaviour should be toggleable. Add it
   to every type's `features`, then read it with `bizFeature("yourFlag")` where
   it matters — never with a hard-coded `if (id === …)`.

That's it. Products, sales, ZATCA, payments, inventory, reports, backups, users
and licensing all work for the new type with no extra work.

---

## 4. Test checklist for a new type

Set a test license to the new type and confirm:

- [ ] **POS** opens in the intended layout (grid vs scan) and can complete a sale.
- [ ] **Navigation** is correct (top bar vs ☰ sidebar); the label/icon show.
- [ ] **Order types** on the cart match the profile.
- [ ] **Settings** shows the right tabs (Tables vs Checkout, etc.).
- [ ] **Advanced** hides the tabs listed in `hideAdvancedTabs`.
- [ ] **KOT**: a paid sale prints a kitchen ticket only if `features.kot` is `true`.
- [ ] **Weighing**: the per-kg product option appears only if `features.weighing`.
- [ ] **ZATCA invoice + VAT** print/report correctly (shared — should just work).
- [ ] Switching an existing account **to and from** the new type doesn't lose data.

Run `npm run build` and confirm it passes before shipping.

---

## 5. Rules of thumb

- **One entry per type; one flag per behaviour.** If you're about to write
  `if (id === "supermarket")` in a component, add a `features` flag instead so
  the next type can opt in without touching that component.
- **Shared stays shared.** ZATCA, payments, reports, inventory, backups and
  licensing are the same for every type — don't fork them.
- **Unknown types are safe.** `getBusinessType` falls back to `restaurant`, so a
  typo or an old license never white-screens a client.
