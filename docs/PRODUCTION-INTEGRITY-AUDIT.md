# Production Integrity Forensic Audit — Initial Findings
Date: 2026-11-28
Scope: POS main repository, ZATCA service, Admin repository. This is a code-architecture audit; no live tenant data or two-device reconciliation was performed.

## Findings (confirmed from repository source)
### POS — high risk
1. **Multiple rounding paths exist.** `src/lib/tax.js` documents transaction rounding via `toFixed(2)` and a separate ZATCA half-up path. Both are explicitly behavior-preserving, not unified. This means convergence requires owner/accountant approval and golden historic fixtures.
2. **Purchase calculation paths differ.** `src/lib/purchases.js` line-item entry uses VAT-exclusive unit cost, while amount-only entry supports VAT-inclusive grand totals. This is a different convention from VAT-inclusive POS item prices. Integration must reconcile supplier documents and keep purchase calculations distinct from sales.
3. **Daily reports consume stored sale VAT and separately calculate category VAT from item gross.** These may differ at edge cases, discounts, mixed tax rates, or per-line rounding. A report should reconcile against the same canonical stored/derived ledger totals.
4. **Cross-device integrity is in active PRs.** PR #81 has a sales-union/dedup/report path; #82 and #83 are similarly titled follow-ups with overlapping persistence/sync/archive/purchase changes but different file sets. They must be reconciled to avoid duplicate or conflicting work. PR #84 separately addresses an oversized legacy archive sync payload.
5. **Cloud sync is a bounded single-document backup model for many keys, with a per-key payload budget.** A large legacy archived-sales blob can block sync for that key; PR #84 is the intended bypass and the per-invoice archive path must be verified.
6. **Historical completeness cannot be proven by code.** Requires a live, read-only reconciliation of each client/till local records, cloud working records, archive invoices/index, transactions, report totals and VAT. No live tenant data was inspected.

### ZATCA service — high risk
7. **Reporting outbox is persistent, but current claim query is not transactional.** `claimDueOutboxEntries` queries due entries and returns pending rows without atomically changing/claiming them. Multiple service instances can process the same row concurrently. A claim/lease mechanism and recovery of stale processing rows is needed.
8. **Service signing chain allocation is transactional and order references have reservation locks.** These are positive existing safeguards; preserve them and test crash/retry boundaries.
9. **ZATCA production readiness is not evidenced.** The README correctly requires simulation compliance checks; no external simulation results were run in this audit.

### Admin — high risk
10. **Integrity diagnostics are not yet a dedicated owner dashboard.** Existing admin app has operational controls but no confirmed end-to-end reconciliation/retention/recovery dashboard from the audited source.
11. **Admin activity logging is client-side best effort.** Source comments acknowledge it is not tamper-proof and should be moved server-side or protected by append-only rules. Financial/admin operations need stronger audit semantics.

## Work started
- Added an isolated integer-cent financial calculation foundation with reconciliation assertions and golden tests. It is NOT yet integrated into the live POS, reports, VAT, or ZATCA invoice path.
- This engine is a proposed versioned policy; it must be compared against current historic behavior and approved before adoption. No historical records are recalculated.

## Required next gates
- Reconcile/resolve PR #82 vs #83 overlap; review #84 archive payload fix and #81 baseline.
- Run build, unit tests, Firebase emulator/security rules tests and Vercel preview.
- Add golden fixtures for discount VAT allocation, mixed rates, refunds/voids, split payments, date boundaries, daily/monthly/archive totals.
- Integrate canonical engine in a separate small reviewed PR only after comparison/sign-off.
- Add atomic outbox claim/lease tests in the service.
- Admin diagnostics/recovery implementation with tenant scoping, role restrictions and audit.
- Live read-only tenant reconciliation before any migration/retention action.
