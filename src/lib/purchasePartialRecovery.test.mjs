// Tests for partial input-VAT recoverability / apportionment (AUD-02 §5.3)
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverablePortion, computePurchaseInvoice } from "./purchases.js";
import { buildDailyReport } from "./dailyReport.js";
import { purchaseRegister } from "./purchaseReports.js";

const VAT = "300000000000003";
const eligible = (extra = {}) => ({
  id: "P", hasValidEInvoice: true, supplierVatNumber: VAT, supplierInvoiceNo: "INV-1",
  invoiceDate: "2026-11-01", subtotal: 100, vatAmount: 15, total: 115, ...extra,
});

test("recoverablePortion: 0 when ineligible, 1 by default, clamped otherwise", () => {
  assert.equal(recoverablePortion({ hasValidEInvoice: false, recoverablePortion: 0.5 }), 0); // ineligible → nothing
  assert.equal(recoverablePortion(eligible()), 1);                 // eligible, unset → full
  assert.equal(recoverablePortion(eligible({ recoverablePortion: 0.4 })), 0.4);
  assert.equal(recoverablePortion(eligible({ recoverablePortion: 1.7 })), 1);   // clamp high
  assert.equal(recoverablePortion(eligible({ recoverablePortion: -0.2 })), 0);  // clamp low
  assert.equal(recoverablePortion(eligible({ recoverablePortion: "x" })), 1);   // invalid → full
});

test("computePurchaseInvoice normalises recoverablePortion to a 0..1 fraction (null when unset)", () => {
  assert.equal(computePurchaseInvoice(eligible()).recoverablePortion, null);
  assert.equal(computePurchaseInvoice(eligible({ recoverablePortion: 0.5 })).recoverablePortion, 0.5);
  assert.equal(computePurchaseInvoice(eligible({ recoverablePortion: 2 })).recoverablePortion, 1);
});

test("daily report splits one bill's VAT by its portion; only the recoverable part lowers net VAT", () => {
  const sales = [{ id: 1, date: "2026-11-01", status: "completed", total: 230, vat: 30, items: [] }];
  const purchases = [eligible({ recoverablePortion: 0.5 })]; // 15 VAT, half recoverable
  const r = buildDailyReport(sales, purchases, "2026-11-01");
  assert.equal(r.recoverableVat, 7.5);
  assert.equal(r.nonRecoverableVat, 7.5);
  assert.equal(r.netVat, 22.5); // output 30 − recoverable 7.5
});

test("purchase register splits recoverable/non-recoverable by portion", () => {
  const r = purchaseRegister([eligible({ recoverablePortion: 0.6 })]);
  assert.equal(r.totals.recoverableVat, 9);     // 15 × 0.6
  assert.equal(r.totals.nonRecoverableVat, 6);  // 15 × 0.4
});
