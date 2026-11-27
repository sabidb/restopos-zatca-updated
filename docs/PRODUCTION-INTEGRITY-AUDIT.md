# Production Integrity Forensic Audit — Initial Findings
Date: 2026-11-28
Scope: POS main repository, ZATCA service, Admin repository. This is a code-architecture audit; no live tenant data or two-device reconciliation was performed.

## Dependency security finding (2026-11-28)
- POS CI install reported **28 vulnerabilities: 1 critical, 10 high, 15 moderate, 2 low**. The POS package declares Vite 5 (`^5.0.8`), an unsupported vulnerable line.
- Admin also declares Vite 5 (`^5.0.8`); no exact Admin npm-audit count has been captured yet.
- Current Vite advisory GHSA-p4f5-76q4-ffq7 affects Vite 4.0.0 through 6.4.5 and describes critical dev-server RCE only when the development server is explicitly network-exposed. The fixed Vite 6 line begins at 6.4.6. Production builds/deployments are not the affected dev-server condition, but dev servers must not be exposed to the network.
- Tracking issues: POS #87 and Admin #17. Exact lockfile audit reports, compatible upgrades, regenerated locks, tests/build/preview, and an audit gate remain outstanding. No dependency upgrade has been applied yet.

## Findings (confirmed from repository source)
### POS — high risk
1. **Multiple rounding paths exist.** `src/lib/tax.js` documents transaction rounding via `toFixed(2)` and a separate ZATCA half-up path. Both are explicitly behavior-preserving, not unified. This means convergence requires owner/accountant approval and golden historic fixtures.
2. **Purchase calculation paths differ.** `src/lib/purchases.js` line-item entry uses VAT-exclusive unit cost, while amount-only entry supports VAT-inclusive grand totals. This is a different convention from VAT-inclusive POS item prices. Integration must reconcile supplier documents and keep purchase calculations distinct from sales.
3. **Daily reports consume stored sale VAT and separately calculate category VAT from item gross.** These may differ at edge cases, discounts, mixed tax rates, or per-line rounding. A diagnostic warning has now been added to daily and period print reports; category VAT respects product tax categories, but saved sale VAT remains authoritative and the warning does not recalculate financial records.
4. **Cross-device integrity follow-up is in main.** PR #81 and #83 are merged; PR #82 was overlapping work and is no longer open. The merged follow-up includes persistence verification, sync retry, archive fingerprint reconciliation, and purchase VAT-entry safeguards. PR #84 separately addresses an oversized legacy archive sync payload and remains under review.
5. **Cloud sync is a bounded single-document backup model for many keys, with a per-key payload budget.** A large legacy archived-sales blob can block sync for that key; PR #84 is the intended bypass. The per-invoice archive module and PR #83 integration are present; PR #84 still requires CI and end-to-end archive/backfill verification.
6. **Historical completeness cannot be proven by code.** Requires a live, read-only reconciliation of each client/till local records, cloud working records, archive invoices/index, transactions, report totals and VAT. No live tenant data was inspected.

### ZATCA service — high risk
7. **Reporting outbox is persistent, but current claim query is not transactional.** `claimDueOutboxEntries` queries due entries and returns pending rows without atomically changing/claiming them. Multiple service instances can process the same row concurrently. A claim/lease mechanism and recovery of stale processing rows is needed.
8. **Service signing chain allocation is transactional and order references have reservation locks.** These are positive existing safeguards; preserve them and test crash/retry boundaries.
9. **ZATCA production readiness is not evidenced.** The README correctly requires simulation compliance checks; no external simulation results were run in this audit.

### Admin — high risk
10. **Integrity diagnostics are not yet a dedicated owner dashboard.** Existing admin app has operational controls but no confirmed end-to-end reconciliation/retention/recovery dashboard from the audited source.
11. **Admin activity logging is client-side best effort.** Source comments acknowledge it is not tamper-proof and should be moved server-side or protected by append-only rules. Financial/admin operations need stronger audit semantics.

## Work started
- Added an isolated integer-cent financial calculation foundation with reconciliation assertions and golden/edge tests. It is NOT yet integrated into live checkout, transaction VAT, ZATCA XML, or archive.
- Added a report diagnostic: daily and period category VAT now respects product tax categories, and print reports warn when category VAT differs from saved invoice-level output VAT. Saved VAT and net payable are not changed by this warning.
- This engine is a proposed versioned policy; it must be compared against current historic behavior and approved before adoption. No historical records are recalculated.

## Required next gates
- Reconcile/resolve PR #82 vs #83 overlap; review #84 archive payload fix and #81 baseline.
- Run build, unit tests, Firebase emulator/security rules tests and Vercel preview.
- Add golden fixtures for discount VAT allocation, mixed rates, refunds/voids, split payments, date boundaries, daily/monthly/archive totals.
- Integrate canonical engine in a separate small reviewed PR only after comparison/sign-off.
- Add atomic outbox claim/lease tests in the service.
- Admin diagnostics/recovery implementation with tenant scoping, role restrictions and audit.
- Live read-only tenant reconciliation before any migration/retention action.
