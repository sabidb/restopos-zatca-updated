# RestoPOS — Complete Setup, Registration, Billing & Printer Guide

This is the end-to-end guide for RestoPOS: from deploying the system, through
customer registration and admin approval, to daily billing, ZATCA e-invoicing,
and thermal-printer setup.

It reflects the current architecture, including the server-side credential,
AI, and QZ-signing Cloud Functions and the version-controlled Firestore rules.

> **Audiences.** Part 1 is for the **operator/owner** deploying the platform.
> Parts 2–7 are for **restaurant staff** using the app day to day.

---

## Contents

1. [Architecture & repositories](#1-architecture--repositories)
2. [Operator deployment (one-time)](#2-operator-deployment-one-time)
3. [First run: activation → registration → approval → login](#3-first-run-activation--registration--approval--login)
4. [Configure your business](#4-configure-your-business)
5. [Printer connection (QZ Tray & ESC/POS)](#5-printer-connection-qz-tray--escpos)
6. [Billing / running the POS](#6-billing--running-the-pos)
7. [ZATCA Phase 1 & Phase 2 e-invoicing](#7-zatca-phase-1--phase-2-e-invoicing)
8. [Reports, accounting & inventory](#8-reports-accounting--inventory)
9. [Admin panel & manager app](#9-admin-panel--manager-app)
10. [Backup, security & troubleshooting](#10-backup-security--troubleshooting)
11. [Gaps & what to build next](#11-gaps--what-to-build-next)

---

## 1. Architecture & repositories

RestoPOS is one Firebase project (`restopos-db`) shared by several apps:

| Repo | Role | Hosting |
|------|------|---------|
| `restopos-zatca-updated` | POS PWA (React/Vite) **+ Cloud Functions** | Vercel (frontend) + Firebase (functions/rules) |
| `restopos-admin` | Admin/owner console | Vercel |
| `restopos-manager-app` | Manager analytics console **+ `getManagerData`** | Vercel + Firebase |
| `restopos-zatca-service` | ZATCA Phase 2 signing/reporting microservice | Railway |
| `restopos-desktop` | Electron desktop wrapper (offline SQLite cache) | Local install |

**Cloud Functions** (`restopos-zatca-updated/functions`):
`verifyLogin`, `setClientCredentials`, `aiChat`, `qzSign`,
`requestPasswordReset`, `resetPasswordWithOtp` (+ `getManagerData` lives in the
manager repo). These use the Admin SDK and **bypass** Firestore rules — they are
the trusted server layer.

**Data model (Firestore collections):** `pending_activations` (accounts),
`licenses`, `zatca_invoices`, `zatca_egs` (Phase 2 keys — locked),
`config/ai` (locked), `client_data` (sales rollups), `manager_logins`,
`orgs`, `live_chats`, `support_tickets`, `vat_index`, `email_index`.

---

## 2. Operator deployment (one-time)

Do these steps **in order** — the pieces depend on each other.

### 2.1 Firebase project
1. Create/confirm the Firebase project `restopos-db`.
2. Enable **Authentication** → Anonymous and **Custom token** (Admin SDK).
   Enable **Email/Password** for the admin account.
3. Enable **Cloud Firestore** and **Storage**.
4. Create the admin user (`8742sabithsaleem@gmail.com`) in Auth. This email is
   the single admin identity referenced by the rules and `setClientCredentials`.

### 2.2 Frontend env vars (all three web apps)
Each web app reads a Firebase web config from Vite env vars. Create a
`.env` (or set them in Vercel → Project → Settings → Environment Variables):

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=restopos-db.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=restopos-db
VITE_FIREBASE_STORAGE_BUCKET=restopos-db.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

> The web API key is **not** a secret (it identifies the project). Real
> protection comes from Firestore rules + Cloud Functions.

### 2.3 Cloud Functions + secrets
From `restopos-zatca-updated`:

```bash
# One-time secrets (Google Secret Manager)
firebase functions:secrets:set QZ_PRIVATE_KEY      # QZ Tray RSA private key (PEM)
firebase functions:secrets:set EMAILJS_PRIVATE_KEY # EmailJS private key (server-side password-reset email)
firebase functions:secrets:set AI_API_KEY          # optional: Anthropic key (else config/ai is used)

# Deploy the functions
firebase deploy --only functions:verifyLogin,functions:setClientCredentials,functions:aiChat,functions:qzSign,functions:requestPasswordReset,functions:resetPasswordWithOtp,functions:zatcaArchive,functions:zatcaArchiveBatch,functions:zatcaChain,functions:zatcaExport
```

> Deploy is **scoped by name on purpose** — the manager app's `getManagerData`
> lives in a separate repo under the same `default` codebase, so an unscoped
> `firebase deploy --only functions` would delete it. Keep every function the POS
> frontend calls in this list; the ZATCA archive/chain/export functions belong
> here too.

Or run the **Deploy Firebase Functions** GitHub Action (`workflow_dispatch`).
It needs the `FIREBASE_SERVICE_ACCOUNT` repo secret.

> **Without `QZ_PRIVATE_KEY`, thermal-printer signing falls back to the QZ trust
> popup** (printing still works). Without `AI_API_KEY`, the AI assistant reads
> the key from the `config/ai` Firestore doc instead.

### 2.4 Firestore rules
```bash
firebase deploy --only firestore:rules
```
The canonical `firestore.rules` lives in this repo (and is mirrored in the
manager repo). It hard-locks secrets and prevents clients from self-approving.
**Test with the emulator against your real flows before production** — a wrong
rule can lock out live tills.

### 2.5 ZATCA signing service (Railway)
Deploy `restopos-zatca-service` and set env vars:

| Var | Value |
|-----|-------|
| `FIREBASE_SERVICE_ACCOUNT` | JSON service-account for `restopos-db` |
| `ZATCA_ENV` | `sandbox` or `production` |
| `ALLOWED_ORIGINS` | `https://restopos.store,https://restopos-admin.vercel.app` |

The service **requires a Firebase ID token** and license ownership on all
`/zatca/*` action endpoints. **Deploy it after the POS frontend** so the
frontend is already sending tokens.

### 2.6 Frontend apps (Vercel)
Deploy `restopos-zatca-updated` (→ restopos.store), `restopos-admin`, and
`restopos-manager-app`. Set the Firebase env vars on each. Point
`ZATCA_SERVICE_URL` in the POS app at your Railway URL if it differs.

### 2.7 Desktop app (optional)
`restopos-desktop` wraps the site in Electron with an offline SQLite cache.
Build with `npm run build`/`electron-builder`. It loads the bundled build or
falls back to the live site; ZATCA certs are encrypted at rest via the OS
keychain.

### Recommended deploy order (to avoid an outage window)
**Functions + secrets → Firestore rules → POS frontend → ZATCA service → admin/manager/desktop.**

---

## 3. First run: activation → registration → approval → login

This is the customer onboarding lifecycle.

### Step 0 — Free 14-day trial (optional, before any of the above)

The registration screen leads with **Start a free 14-day trial**. A prospect
picks Restaurant or Supermarket, gives a business name, their name and a
**10-digit mobile number** (mandatory), and lands straight in the POS as Admin
with a clean till — no license key, no CR/VAT, no admin approval.

**The mobile number is the account.** It is the Firestore doc id
(`TRIAL-<10 digits>`), the cloud-backup key, and how the client resumes on a
second device via **↩ Continue my trial**. One trial per number: signing up
again with the same number resumes the running trial rather than restarting
the clock, and a finished trial is told to register.

**Both business modes run in full.** The trial licence carries `businessType`,
so Supermarket mode gets barcode-first checkout and weighed items while
Restaurant mode gets tables, dine-in and KOT. The banner's **⇄ mode** button
switches between them mid-trial — products and sales are untouched, only the
till layout changes, and the new mode is written back to the trial document so
the admin panel and any other device follow.

A trial is **completely empty on entry** — no demo products, no fake sales,
nothing to delete before the client can start. The first thing in the till is
their own menu. Anyone who wants to see a stocked system looks at the preview
gallery on the landing page instead (`landing/shots/`), which is real
screenshots of a sample business and is labelled as such.

**What the operator sees.** Signup writes `pending_activations/TRIAL-<mobile>`
with `isTrial: true`, `trialSource: "self-serve"`, `businessType`,
`trialStartedAt` and `customExpiryDate` = start + 14 days. It appears in the
admin panel's **Trials** tab — mobile number, business type, owner, city, days
remaining — and is deliberately kept out of the Pending approval queue, which
is for license activations. **Extend +7/+14/+30** and **Convert to paid** work
on it: extend edits `customExpiryDate`, which the client's kill-switch watchdog
picks up live; converting also flips `status` to approved so the client isn't
locked out.

No Firestore rules change was needed: a client may only create an activation
with `status: "pending"` and `credentialsApproved: false`, which is exactly
what the trial does. `client_data/TRIAL-<mobile>` is gated on the device UID
being in the document's `authUids`, set at creation and topped up by
`registerDeviceUid` on each new device.

**Seeing trial data in Firebase** (`src/trialMirror.js`). `client_data/{key}`
stores each localStorage key as one long JSON *string* — it restores a device
perfectly and is unreadable in the console. So a trial also mirrors itself into
a `trials` collection as real documents:

```
trials/TRIAL-05xxxxxxxx            ← usage summary (read this one)
  ├── sales/{INV-1042}             ← every invoice, one document each
  ├── products/{itemId}            ← their catalogue
  └── customers/{customerId}       ← their CRM
```

The summary carries who signed up (mobile, business, owner, city, mode), where
they are in the 14 days (`daysUsed`, `daysLeft`, `expired`) and what they have
actually done: `productCount`, `invoiceCount`, `revenueTotal`, `vatTotal`,
`averageOrder`, `activeDays`, `firstSaleAt`/`lastSaleAt`, `salesByDay`,
`paymentMix`, `topProducts` and `lastActiveAt` — enough to tell a live trial
from an abandoned one at a glance.

Writes are debounced (6 s), diffed against a per-row fingerprint so unchanged
rows are never rewritten, batched under Firestore's 500-op cap, and flushed
when the tab is hidden. Every path is best-effort: a failed mirror write logs
and is dropped, it never interrupts the till. `client_data` remains the restore
path — this is a readable view alongside it, not a replacement.

> **This needs a rules deploy.** `trials` is a new collection, and the default
> rule denies everything not matched, so until the rules are deployed every
> mirror write is rejected and the admin panel's Trials tab shows "No activity
> mirrored yet". Nothing else breaks — the trial itself and the `client_data`
> backup are unaffected.
>
> Deploy by running the **Deploy Firestore Rules** GitHub Action
> (Actions → Deploy Firestore Rules → Run workflow). It runs the rules test
> suite first and refuses to deploy if anything fails. Locally the equivalent
> is `firebase deploy --only firestore:rules --project restopos-db`.

### Testing firestore.rules

`firestore.rules` guards live tills — a wrong rule can lock a shop out
mid-service or expose one client's data to another — so it is tested like
code, against the real Firestore emulator:

```bash
cd rules-test && npm install && npm test
```

23 cases cover the trial collection (the owning device can read and write its
own trial and subcollections; another signed-in device can do neither; the
admin can read everything) and guard the existing rules against regression
(a client cannot self-approve an activation, extend its own expiry, or read
another account's `client_data`; secrets stay locked; unmatched paths stay
denied). CI runs it on every push and pull request. **Add a case here whenever
you change a rule.**

**Data retention** (`src/trial.js`):

- `main.jsx` calls `installTrialWorkspace()` **before** `App.jsx` — and therefore
  Firebase — is imported, prefixing every localStorage key with
  `restopos_trial::<key>::`. Existing code is unchanged; it just reads and
  writes an isolated namespace. A trial can never overwrite a real account's
  menu, sales or ZATCA hash chain on the same browser, and two trials don't
  collide.
- Everything syncs to `client_data` exactly like a paid client. Monthly sales
  archive buckets (`restopos_sales_YYYY-MM`) are synced **for trials only** —
  a trial is capped at 14 days so the buckets stay small, and restoring them is
  what lets a resumed trial still show its earlier days. Real clients keep the
  old behaviour, because their archives can span years and would risk
  Firestore's 1 MB document limit.
- **Register now** runs `promoteTrialWorkspace()`, lifting the namespace into
  the real one so 14 days of work survives becoming a paying client. It refuses
  when another account already occupies the real namespace, and says so.

**What a trial cannot do.** It has no CSID, so `reportToFatoora` and
`clearanceB2BInvoice` run `simulateZatcaSubmission()` — the queue and VAT
dashboard behave, records are flagged `trial_simulated`, nothing reaches
FATOORA — and every printed document is stamped **TRIAL RECEIPT — NOT A VALID
TAX INVOICE** (bilingual). Trial invoices are also kept out of the shared
`zatca_invoices` archive, so the 5-year store holds only real tax invoices.
Phase 2 onboarding, archive export, the paid AI assistant and the owner console
are blocked. Live chat and support tickets stay open — trial clients are leads.

**Expiry.** `customExpiryDate` is enforced by the existing kill-switch watchdog
when online, and by a local one-minute ticker against the stored end date when
offline, so a till left running overnight still locks on time. The client sees
a trial-specific screen making clear nothing was deleted.

**In the admin panel.** The Trials tab shows each trial's usage inline —
products, invoices, revenue, VAT, active days, last seen — and **🔍 View their
data** opens their actual invoices and catalogue, read straight from the
`trials` subcollections.

**Preview gallery.** `landing/shots/*.jpg` are real screenshots of the app —
POS, dashboard, transactions, reports, VAT, inventory, customers, financials —
captured from a seeded sample business. To refresh them after a UI change,
re-run the capture against a local dev server rather than editing images.

**Optional: a trial-only deployment.** Building with `VITE_TRIAL_MODE=true`
makes a whole deployment a trial — useful for `try.restopos.store` on a second
Vercel project. Set `VITE_TRIAL_EXIT_URL=https://restopos.store` so the
Register button sends visitors to the real site.

### Step 1 — License activation
1. Open the app. On first run you're on the **License** screen.
2. **Choose your business type — Restaurant or Supermarket** (top of the
   registration form). This sets the app's mode (see
   [Business modes](#business-modes)) and is stored on the account.
3. Enter the **license key** (issued by the operator, e.g. `RESTODD8HY7E`) and
   your business details: **business name, CR number, 15-digit VAT number,
   email, city, address, phone**.
3. Submitting creates a `pending_activations/{LICENSEKEY}` document with
   `status: "pending"`, `credentialsApproved: false`, and registers this
   device (its anonymous UID is added to `authUids`, making it the trusted
   device for this license).

### Step 2 — Set login credentials
1. After activation you land on **Set Credentials**.
2. Choose a **username** (≥3 chars) and **password** (≥6 chars).
3. This calls the **`setClientCredentials` Cloud Function**, which hashes the
   password with **bcrypt server-side** and stores it. The browser never
   writes the hash. A device-local PBKDF2 verifier is stored for **offline
   unlock** only.

### Step 3 — Admin approval
The account is now **pending**. In the **admin panel**, the owner reviews it
under *Pending* and clicks **Approve** (sets `credentialsApproved: true`,
`isActive: true`). Until approved, login is blocked with "Account pending
admin approval."

### Step 4 — Login
1. Enter **username + password** (license key is remembered).
2. Online: the **`verifyLogin`** function checks the bcrypt hash + approval +
   active flags, then mints a Firebase **custom token** (uid == license key).
   Legacy sha256 passwords still work and are auto-upgraded to bcrypt.
3. Offline: the app matches the **device-local PBKDF2 verifier** and only
   unlocks if the account was **approved + active** at last sync.

### Step 5 — Device approval gate
A **new/second device** logging in with correct credentials still waits for the
admin to approve that device (anti-account-sharing). The original activation
device is trusted automatically. Approve extra devices from the admin panel
(*Devices*).

**Password reset:** *Forgot password* → the **`requestPasswordReset`** function
generates a code, stores it hashed, and emails it (server-side EmailJS). The
**`resetPasswordWithOtp`** function verifies the code (5-attempt / 10-minute cap)
and sets the new bcrypt hash. Because the emailed code proves ownership, reset
now works **from any device** (the code is never checked in the browser).

---

## 4. Configure your business

From **Settings** / the relevant tabs:

- **Company** — legal name (Arabic + English), CR, VAT TRN, logo, address,
  phone. These print on receipts and go into ZATCA invoices.
- **Items / Categories / Prices** — build your menu: categories (with colors),
  items (name, price incl. VAT, barcode, image), favourites, recipes/BOM.
- **Tables** — define dine-in tables and layout (*Map*) for real-time status.
- **Users** — staff accounts and **roles** (Admin / Manager / Cashier) with a
  per-user **PIN**. Roles gate access to sensitive tabs.
- **Templates / Presets** — receipt layouts (Modern, Classic, Minimal, Arabic
  RTL), KOT format, invoice format.
- **Delivery** — enable HungerStation / Jahez / Marsool / Careem and store each
  provider's API key + branch ID.
- **Terms** — receipt footer / T&Cs.

---

## 5. Printer connection (QZ Tray & ESC/POS)

RestoPOS supports **two bill/kitchen printers** and prints via a fallback chain:
**QZ Tray → ESC/POS (Web Serial) → browser print**.

### Option A — QZ Tray (recommended for silent auto-print)
1. Install **QZ Tray** on the till PC (*Settings → Printer → Download QZ Tray*).
2. Start QZ Tray (it runs a local service on `localhost`).
3. In RestoPOS, open **Settings → Printer / QZ Tray**. The app connects and
   signs each request via the **`qzSign` Cloud Function** (the signing key is
   server-side). With the RestoPOS certificate trusted on the machine, the
   "untrusted website" popup disappears.
4. Select your **Bill printer** and **Kitchen printer** from the QZ device list
   (`restopos_qz_bill_printer`, `restopos_qz_kitchen_printer`).
5. **Test Print** to confirm.

> If `qzSign` isn't deployed / `QZ_PRIVATE_KEY` isn't set, QZ still works but
> shows its trust prompt (unsigned mode).

### Option B — ESC/POS over Web Serial (USB)
1. **Settings → Printer → Connect Bill Printer** → pick the USB serial device
   in the browser prompt (Chrome/Edge). Repeat for **Connect Kitchen Printer**.
2. The app remembers ports (`restopos_bill_port_hint`, `..._kitchen_port_hint`)
   and auto-reconnects to previously approved devices.
3. Native ESC/POS features: **auto-cut** after each receipt/KOT, and a
   **native ZATCA QR** printed via `GS ( k`.

### Option C — Browser print (fallback)
If no printer is connected, RestoPOS opens the browser print dialog with the
formatted receipt (including the ZATCA QR).

**Kitchen tickets (KOT)** print to the kitchen printer on order send; **bill
receipts** print on payment (respecting the **Print & Save** toggle).

---

## Business modes

RestoPOS runs in one of two modes, chosen at registration and stored on the
account (`businessType`), so it follows the login on any device.

| | 🍽️ Restaurant (default) | 🛒 Supermarket |
|---|---|---|
| Order types | Dine-in · Takeaway · Delivery | **Sale** · Delivery (no dine-in) |
| Tables | Yes | Hidden |
| Kitchen ticket (KOT) | Yes | Hidden |
| Checkout focus | Item grid | **Barcode-first** (scan box auto-focused) |
| Weighed items | — | **Yes** — items priced per kg; cashier enters weight |

**Setting up weighed items (supermarket):** Create → Items → edit an item →
tick **"⚖️ Weighed item — price is per kilogram"**. Its price is then treated as
SAR/kg. When added at the POS, the cashier enters the weight and the line total
is `price × weight`.

To change an existing account's type, an operator updates `businessType` on the
`pending_activations` document (admin panel / Firestore).

## 6. Billing / running the POS

### Taking an order
1. **Order type:** Dine-in (pick a table), Takeaway, or Delivery (capture
   customer name / phone / address).
2. **Add items:** search or tap categories; adjust quantities in the cart.
3. **Discounts:** apply a coupon code or a manual discount. **VAT (15%) is
   calculated after discount** (ZATCA-compliant).
4. **Hold / recall:** park an order and recall it later.
5. **KOT:** send to kitchen — prints a Kitchen Order Ticket.

### Payment
1. Choose **Cash**, **Card**, **Mada**, **Apple Pay**, or **Split (Cash+Card)**.
2. Cash: enter tendered amount → change is calculated (quick-amount buttons);
   the cash drawer auto-opens on cash payments.
3. Split: validate that cash + card equals the total.
4. **Print & Save** (toggle persists): saves the invoice, generates the ZATCA
   QR/hash, increments the ICV counter, and prints the receipt.

Every sale produces a **sequential, gap-free invoice number**, a **SHA-256 hash
chained** to the previous invoice, and a **scannable ZATCA QR**.

---

## 7. ZATCA Phase 1 & Phase 2 e-invoicing

### Phase 1 (default, all accounts)
Every receipt carries a **Phase-1 TLV QR** (5 tags: seller name, VAT number,
timestamp, total, VAT amount), Base64-encoded. Nothing to configure.

### Phase 2 (integrated e-invoicing) — for mandated businesses
1. **Settings → ZATCA Setup**. The **eligibility check** compares your yearly
   taxable revenue against the **SAR 375,000** threshold.
2. Enter your **15-digit VAT number** (must start with `3`), **company name**,
   branch name, and the **OTP from the FATOORA portal**.
3. Click **Activate**. The `restopos-zatca-service` runs the full chain:
   - Generate cryptographic keys & CSR
   - Issue **compliance certificate** (using your OTP)
   - Run 3 **compliance test invoices**
   - Issue the **production certificate**
   - Save the EGS to the locked `zatca_egs` collection
4. Once active, simplified (B2C) invoices are **signed (ECDSA) and reported to
   FATOORA** through the service. The **Transactions → ZATCA Invoices** tab
   shows the reporting queue with a **Report** button and retry.

### Notes & documents
- **Credit / Debit notes** must reference the original invoice and be issued
  within 15 days.
- **UBL 2.1 XML** is downloadable per invoice (Transactions tab).
- **Records** must be retained 5 years.

---

## 8. Reports, accounting & inventory

RestoPOS is a full back office. Key tabs:

- **Sales / Reports / Analytics / Hourly / Revenue** — sales dashboards.
- **VAT** — VAT liability dashboard + period reports and FATOORA submission
  tracking.
- **EOD / Close Day / Day History** — official close-day with cash/card
  breakdown; feeds the manager analytics.
- **Expenses / Suppliers / Purchase** — cost tracking.
- **Accounting: GL, Balance Sheet, P&L, Cash Flow, Aging** — double-entry
  reporting.
- **Stock / Stocktakes / Movements / Low-stock** — inventory.
- **Clients / Loyalty / Segments / Gift Cards / Credit** — CRM & house accounts.
- **Quotations / Proforma / Recurring** — non-sale documents.
- **KDS / Kitchen** — kitchen display system.
- **Backup / Export** — data backup and CSV/XML export.

---

## 9. Admin panel & manager app

### Admin panel (`restopos-admin`)
Signs in with the single admin Firebase account. Capabilities: approve /
reject / deactivate / restore accounts, force-logout a device, reset a
client's password, set subscription **plan** and custom expiry, add admin
notes, manage licenses, run live chat/support, and build **manager logins**.

### Manager app (`restopos-manager-app`)
Branch/group analytics for owners. Login = **license key + 4-digit PIN**
(set in the admin panel). Data is served exclusively by the **`getManagerData`
Cloud Function** (the browser reads nothing directly). The PIN is protected by
a **server-side lockout** (5 wrong tries → 15-minute lock). The raw PIN is
never stored on the device.

---

## 10. Backup, security & troubleshooting

- **Backups:** use *Backup / Export* regularly. Firestore + Storage should also
  have project-level backups (operator responsibility).
- **Security posture:** secrets (Anthropic key, ZATCA private keys, manager PIN
  hashes) are Admin-SDK-only via Firestore rules; passwords are bcrypt;
  the ZATCA service and manager PINs are auth- and rate-limited.
- **Kill switch:** the admin can force-logout or deactivate an account in real
  time (watchdog listener); a deactivated account can't unlock offline either.
- **Common issues:**
  - *"Account pending admin approval"* → approve it in the admin panel.
  - *Login write blocked (Firestore rules)* → confirm rules are deployed and
    the device is on `authUids` / logged in.
  - *ZATCA report fails after service deploy* → the POS frontend must be the
    token-sending version (deploy frontend before service).
  - *Printer shows QZ trust popup* → set `QZ_PRIVATE_KEY` and deploy `qzSign`.
  - *New registration fails* → deploy the `setClientCredentials` function.
- **Error logs:** the app keeps a rolling local error log (*Settings → Error
  Log*).

---

## 11. Gaps & what to build next

### ✅ Recently built
- **B2B `/zatca/clearance` + standard-invoice UBL** — the service now builds a
  true standard invoice (type code `0100000` + populated buyer
  `AccountingCustomerParty`) on top of the library's line-item/signing machinery,
  and the POS sends the buyer party on clearance. ⚠️ Validate against the ZATCA
  **sandbox** compliance API before production — ZATCA's standard-invoice
  business rules (BR-KSA) are strict and can't be verified without a sandbox EGS.
- **Server-side `verifyLogin` lockout** — 8 failed logins → 15-minute lock,
  enforced in a transaction (mirrors the manager PIN lockout).
- **Server-side password-reset OTP** — `requestPasswordReset` +
  `resetPasswordWithOtp`; the code is generated, hashed, emailed and verified
  server-side and can't be skipped in the browser.

### Still open (prioritized)
1. **No automated tests / CI on push** (workflows are manual). Add a CI workflow
   that builds + lints every PR, plus rules unit tests and function/auth tests.
2. **No `.env.example`** documenting required env vars/secrets per app.
3. **`restopos-manager-app` has no `.gitignore`** (risk of committing
   `node_modules`).
4. **Validate standard-invoice clearance in the ZATCA sandbox** — the UBL is
   built; it needs a real sandbox EGS run to confirm ZATCA accepts it.
5. **Monolithic 16k-line `App.jsx`** — split into modules for maintainability.
6. **No error monitoring** (errors only go to localStorage). Add Sentry or similar.
7. **No documented Firestore/Storage backup & restore runbook.**
