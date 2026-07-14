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
firebase deploy --only functions:verifyLogin,functions:setClientCredentials,functions:aiChat,functions:qzSign,functions:requestPasswordReset,functions:resetPasswordWithOtp
```

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
