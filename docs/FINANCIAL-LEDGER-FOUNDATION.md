# Financial Ledger Store Foundation (Draft)

This module introduces an additive, single-key local ledger prototype:
- New sale totals are calculated with the canonical financial engine.
- Sale and transaction entries share the same sale ID and are persisted in one localStorage key, so the new ledger entry is not split across independent keys.
- Repeated sale IDs are idempotent for identical details and reject conflicting reuse.
- Ledger audit reports duplicate/missing IDs, missing transactions, amount mismatches, and sale-vs-transaction totals.
- Device ledger merge deduplicates by stable IDs, chooses newer versions, and reports equal-time conflicts.
- Legacy migration preserves saved historical totals and VAT without recalculating.

**Not integrated into the live POS.** Existing App.jsx still writes legacy keys; no current sale is moved to this new key by this PR. Integration and reconciliation are a separate gate. The module does not purge or rewrite historical records.
