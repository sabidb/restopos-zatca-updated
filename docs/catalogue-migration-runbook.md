# R1 — Catalogue → Firestore subcollection: cutover runbook

**Why:** the catalogue (`restopos_items`) syncs as one JSON field inside
`client_data/{licenseKey}`. `src/lib/sync.js` refuses any field over **350 KB**
(a Firestore document is capped at 1 MiB and one oversized field would stop
*all* backup for that client). A ~10k-product catalogue exceeds that, so it
silently stops backing up. R1 moves the catalogue into a **subcollection**, one
document per product:

```
client_data/{licenseKey}/catalogue/{itemId}
```

**Safety model:** everything ships **off by default** (`restopos_catalogue_subcollection`
is unset → the app loads/syncs the catalogue from the blob exactly as before).
Nothing changes for any tenant until *you* backfill and flip the flag, per
tenant. This is near-irreversible and touches live product data, so validate on
the emulator and one pilot tenant before any large tenant.

## 0. Prerequisites
- This PR merged to `main` and deployed.
- Security rules: **no change needed** — the existing
  `client_data/{licenseKey}/{document=**}` rule already covers the new
  subcollection with the same `ownsLicenseKey` (authUids) gating as sales.
- Verify the adapter on the emulator first:
  ```
  firebase emulators:start --only firestore
  npm run test:emulator      # catalogue + purchase suites must pass
  ```

## 1. Pilot on ONE small tenant (staging or a willing small shop)
1. Open the app signed in as that tenant on a device that holds the full catalogue.
2. In the browser console, back the catalogue up into the subcollection
   (idempotent — safe to re-run):
   ```js
   await window.__restoposCatalogueBackfill()
   // → { written: <n>, batches: <m> }
   ```
3. In the Firestore console, confirm `client_data/{licenseKey}/catalogue` holds
   `written` documents and a few spot-checked products look correct.
4. Flip the flag ON for this device/tenant, then reload:
   ```js
   localStorage.setItem('restopos_catalogue_subcollection','true'); location.reload()
   ```
5. Verify after reload: the catalogue loads, a barcode scan finds products,
   adding/editing/deleting a product reflects in the subcollection (one doc
   changes, not the blob), and the Sync-Health tab no longer flags
   `restopos_items` as oversized.

## 2. Roll out per tenant
Repeat step 1 for each tenant **on a device that has their full catalogue**
(the backfill reads this device's `restopos_items`). Confirm the subcollection
count matches the product count before flipping the flag for that tenant.

## 3. Rollback
Flip the flag off and reload — the app returns to the blob catalogue
immediately:
```js
localStorage.removeItem('restopos_catalogue_subcollection'); location.reload()
```
The subcollection documents are left in place (harmless); the blob copy in
`restopos_items` is still maintained locally, so no data is lost by toggling.

## What this PR does and does NOT do
- **Does:** ship the adapter (`src/lib/catalogueCloud.js`), the idempotent
  batched backfill, the operator backfill hook, a default-off flag that routes
  catalogue writes (changed items only) and boot-hydration through the
  subcollection, and an in-memory barcode index helper for fast scan lookup.
- **Does NOT:** remove `restopos_items` from `SYNC_KEYS` or delete the blob.
  While the flag is on, the catalogue simply isn't blob-synced (the per-item
  subcollection writes replace it); the `SYNC_KEYS` entry stays so rollback is
  instant. Dropping it permanently is a later, deliberate step once every tenant
  is migrated and verified.
- **Not runtime-tested by Claude** (no Firebase creds): the adapter is covered by
  mock unit tests + the emulator suite; the live wiring must be validated via the
  pilot above before production rollout.
