# Archive Retention & Compact Snapshot Policy — Draft

## Proposed retention shape
- **Recent 90 days:** detailed per-invoice archive remains the recovery source, including line items, payments, customer/tax details, ZATCA identifiers, and response data.
- **Older than 90 days:** create a compact per-invoice snapshot that preserves sale ID/date, branch/till/cashier, financial totals (total/VAT/net/discount), payment summaries, tax categories, refunds/void status, invoice serial/UUID/hash chain references, and compact line summaries.
- **Never compact by deleting detail first.** Copy compact records, reconcile count/total/VAT/fingerprint against the source, mark the compact archive verified, and only then consider purging old detailed documents under a separate owner-approved migration.
- This PR only adds a pure compact representation and reconciliation helper. It does not write to Firestore, delete, mutate, or migrate any existing record.
- The fingerprint is a deterministic reconciliation checksum, not a cryptographic security proof. ZATCA invoice hashes are preserved separately.

## Legal / accounting review gate
Before any purge of detailed invoices, confirm KSA retention obligations, required buyer/supplier fields, ZATCA XML/QR evidence retention, credit notes/refunds, and the exact compact field list with the accountant/legal owner. Detailed documents remain untouched until approved.
