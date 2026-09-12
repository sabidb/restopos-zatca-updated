# Deploying the Phase 2 correctness fixes

Four repositories changed. This is the order to deploy them in, what to check
between steps, and how to back out.

Everything here needs credentials this runbook does not contain: a Firebase
login with owner rights on `restopos-db`, and `gcloud` authenticated against the
same project.

## Before anything reaches a merchant

The signing changes alter what gets signed — amounts are now rounded half-up
instead of truncated, and written to two decimals. Only ZATCA can confirm the
resulting hash is accepted, and nothing here has asked it yet.

```bash
cd restopos-zatca-service
node scripts/sandbox-check.js
```

No credentials, no merchant, no Firestore. It runs the whole compliance sequence
against ZATCA's sandbox with a throwaway EGS. **A failure here is a real defect
and stops the deploy.** A pass is a smoke test, not production readiness — the
sandbox is more permissive than simulation and hands back a fake certificate.

## Order

The repositories are independent: the service claims submissions on a
per-document UUID, and a till that has not been upgraded yet simply does not
send one and falls back to the older behaviour. Deploy in whatever order suits,
with one exception noted under Firestore below.

### 1. Firestore indexes — before the functions

```bash
cd restopos-zatca-updated
firebase deploy --only firestore:indexes
```

The reconciliation queries `zatca_invoices` on `zatca_reported` and `timestamp`,
and fails with `FAILED_PRECONDITION` until that index exists. Deploy it first
and let it finish building; a large archive takes a few minutes.

`firestore.indexes.json` reconciles the **entire** index set and deletes
anything live in the project but missing from the file. The new entry was
appended rather than the file rewritten, so this is additive. If the CLI refuses
because it would delete something, that means an index exists in the project
that nobody wrote down — add it to the file. **Never pass `--force`**; that
means "yes, delete the ones I forgot".

### 2. Firestore rules

```bash
firebase deploy --only firestore:rules
```

Adds `zatca_unreported_status`: readable by the admin account, writable by
nobody in a browser. Verify first with `cd rules-test && npm test` — 63 tests,
no emulator setup needed beyond the CLI.

### 3. Cloud Functions

```bash
firebase deploy --only functions
```

Two new exports, `zatcaReconcileUnreported` and `zatcaReconcileNow`; the other
ten are unchanged. The scheduled one needs the Cloud Scheduler API enabled on
the project — the deploy will say so if it is not.

Check it is scheduled, then run it once by hand from the admin panel's **Scan
now** button rather than waiting for 05:30:

```bash
gcloud scheduler jobs list --location us-central1 | grep zatcaReconcile
```

The first run will likely report a backlog. That is the point of it: those
invoices were always unreported, nothing was looking.

### 4. The POS web app

Deployed however it normally is (Vercel, from `main`). Tills pick it up on
reload; the service worker means a till that stays open overnight may need one.

After this, new invoice numbers carry a per-terminal segment —
`INV-A7F3-001042` rather than `INV-001042`. Numbers already issued keep their
shape. Tell the merchants before they ask.

### 5. The admin panel

Deployed however it normally is. Shows the new **Invoices never sent to ZATCA**
panel below device health. It reads a collection nothing has written yet, so it
will say "Nothing scanned yet" until step 3 has run.

### 6. The signing service — simulation first

```bash
cd restopos-zatca-service
gcloud run deploy zatca-service --source . --region me-central1 \
  --service-account zatca-service@restopos-db.iam.gserviceaccount.com \
  --allow-unauthenticated --min-instances 1 \
  --set-env-vars "^@^ZATCA_ENV=simulation@KMS_KEY_NAME=…"
```

The full command with every variable is in `docs/DEPLOY-CLOUDRUN.md`. Deploy
with `ZATCA_ENV=simulation` and run a compliance check against a real merchant's
device before going near production:

```bash
curl -X POST "$SERVICE_URL/zatca/compliance-check" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"licenseKey":"…"}'
```

Read the per-document results. Simulation enforces the real BR-KSA rules;
sandbox does not. Only once that passes should the same deploy run again with
`ZATCA_ENV=production`.

### 7. The two Cloud Scheduler jobs

Separate from everything above and easy to forget, because nothing fails
loudly without them: the retry queue never drains on a service that scales to
zero, and certificate expiry goes unnoticed until a till stops reporting.

```bash
gcloud scheduler jobs list --location me-central1
```

If `zatca-outbox-drain` and `zatca-fleet-sweep` are not there, create them —
commands are in the service's README and `docs/DEPLOY-CLOUDRUN.md`.

## Backing out

| Step | Reverting |
| --- | --- |
| Indexes | Leave them. An unused index costs storage and breaks nothing. |
| Rules | `git revert` and redeploy. The new rule only grants an admin read. |
| Functions | `firebase deploy --only functions` from the previous commit. Delete the schedule with `gcloud scheduler jobs delete`. |
| POS / admin | Redeploy the previous build. Invoice numbers issued with a terminal segment stay valid — they are already in the archive and reported under those numbers, so nothing needs rewriting. |
| Service | `gcloud run services update-traffic zatca-service --to-revisions PREVIOUS=100`. Instant, and the safest thing on this list. |

The one thing that does not revert is a document already reported to ZATCA.
That is what the sandbox and simulation checks are for.

## What this deploy does not fix

- **VAT is hard-coded at 15%.** No zero-rated or exempt items.
- **Debit notes are never generated**, though the service accepts them.
- **Historical collisions.** Two tills that issued the same invoice number
  before this deploy have already overwritten each other in the archive; one
  copy is gone and no code change recovers it. Worth checking whether any
  merchant runs more than one till before treating the archive as complete.
