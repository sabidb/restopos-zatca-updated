// Reconciliation invariant locked by the Stage-1 checkout/report fix:
// every VAT view must aggregate the SAME deduped, completed-only sales, so the
// VAT engine / VAT liability can never disagree with the daily report or the
// Transactions screen because of two-device duplicate sales.
import test from "node:test";
import assert from "node:assert/strict";
import { uniqueSalesById, buildDailyReport } from "./dailyReport.js";

// Canonical output-VAT aggregation — the exact rule now used by aggVAT() and the
// VAT engine in App.jsx: dedup by stable ID, completed non-draft only, sum saved vat.
function outputVat(sales) {
  return uniqueSalesById(sales || [])
    .filter(s => s && !s.isDraft && (!s.status || s.status === "completed"))
    .reduce((n, s) => n + (Number(s.vat) || 0), 0);
}
const r2 = (n) => Math.round(n * 100) / 100;

test("two-device duplicate sale is counted once (no double-count of VAT)", () => {
  const sales = [
    { id: "INV-AAA-1", date: "2026-11-27", status: "completed", total: 115, vat: 15, syncUpdatedAt: "2026-11-27T10:00:00Z" },
    // same sale synced from a second device, later edit stamp — must win, not add
    { id: "INV-AAA-1", date: "2026-11-27", status: "completed", total: 115, vat: 15, syncUpdatedAt: "2026-11-27T10:05:00Z" },
    { id: "INV-AAA-2", date: "2026-11-27", status: "completed", total: 23, vat: 3, syncUpdatedAt: "2026-11-27T11:00:00Z" },
  ];
  const naiveDoubleCount = sales.reduce((n, s) => n + s.vat, 0); // the OLD, buggy behaviour
  assert.equal(naiveDoubleCount, 33);          // 15 + 15 + 3  ← duplicate inflates it
  assert.equal(r2(outputVat(sales)), 18);      // 15 + 3       ← deduped, correct
});

test("drafts and voided/refunded sales are excluded from output VAT", () => {
  const sales = [
    { id: "A", date: "2026-11-27", status: "completed", total: 115, vat: 15 },
    { id: "B", date: "2026-11-27", status: "draft", isDraft: true, total: 50, vat: 6.52 },
    { id: "C", date: "2026-11-27", status: "voided", total: 200, vat: 26.09 },
    { id: "D", date: "2026-11-27", status: "refunded", total: 30, vat: 3.91 },
  ];
  assert.equal(r2(outputVat(sales)), 15);
});

test("VAT aggregation reconciles with the daily report on the same data", () => {
  const sales = [
    { id: "INV-1", date: "2026-11-27", status: "completed", total: 115, vat: 15 },
    { id: "INV-1", date: "2026-11-27", status: "completed", total: 115, vat: 15, syncUpdatedAt: "2026-11-27T12:00:00Z" }, // dup
    { id: "INV-2", date: "2026-11-27", status: "completed", total: 46, vat: 6 },
    { id: "INV-3", date: "2026-11-27", status: "draft", isDraft: true, total: 10, vat: 1.3 },
  ];
  const report = buildDailyReport(sales, [], "2026-11-27");
  // daily report already dedups + counts completed sales; our output-VAT rule must match it
  assert.equal(r2(outputVat(sales)), r2(report.vat));
  assert.equal(r2(report.vat), 21); // 15 + 6, duplicate and draft excluded
});

test("dedup aggregation is idempotent (clean data is unchanged)", () => {
  const clean = [
    { id: "X", date: "2026-11-27", status: "completed", total: 115, vat: 15 },
    { id: "Y", date: "2026-11-27", status: "completed", total: 23, vat: 3 },
  ];
  assert.equal(r2(outputVat(clean)), 18);
  assert.equal(r2(outputVat([...clean, ...clean])), 18); // duplicating input changes nothing
});
