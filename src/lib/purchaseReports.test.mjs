// Golden tests for src/lib/purchaseReports.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { purchaseRegister, supplierBalances } from "./purchaseReports.js";

const docs = [
  { id: "I1", docType: "invoice", supplierId: "S1", supplierName: "Al Noor", supplierVatNumber: "300000000000003", supplierInvoiceNo: "A-1", invoiceDate: "2026-11-01", hasValidEInvoice: true,  subtotal: 100, vatAmount: 15, total: 115 },
  { id: "I2", docType: "invoice", supplierId: "S1", supplierName: "Al Noor", invoiceDate: "2026-11-10", hasValidEInvoice: false, subtotal: 40,  vatAmount: 6,  total: 46  },
  { id: "C1", docType: "credit_note", supplierId: "S1", supplierName: "Al Noor", supplierVatNumber: "300000000000003", supplierInvoiceNo: "CN-1", invoiceDate: "2026-11-12", hasValidEInvoice: true, subtotal: 20, vatAmount: 3, total: 23 },
  { id: "I3", docType: "invoice", supplierId: "S2", supplierName: "Fresh Co", supplierVatNumber: "300000000000003", supplierInvoiceNo: "F-1", invoiceDate: "2026-10-28", hasValidEInvoice: true, subtotal: 200, vatAmount: 30, total: 230 },
];

// ── purchaseRegister ──────────────────────────────────────────────────────
test("register with no date filter includes all docs, oldest first", () => {
  const r = purchaseRegister(docs);
  assert.equal(r.count, 4);
  assert.deepEqual(r.rows.map((d) => d.id), ["I3", "I1", "I2", "C1"]); // by date asc
});

test("register totals are signed: credit notes subtract", () => {
  const r = purchaseRegister(docs);
  // net: 200 + 100 + 40 - 20 = 320 ; vat: 30 + 15 + 6 - 3 = 48 ; gross: 320+48=368? check: 230+115+46-23=368
  assert.equal(r.totals.net, 320);
  assert.equal(r.totals.vat, 48);
  assert.equal(r.totals.gross, 368);
  assert.equal(r.totals.invoices, 3);
  assert.equal(r.totals.creditNotes, 1);
});

test("register splits recoverable vs non-recoverable input VAT", () => {
  const r = purchaseRegister(docs);
  // recoverable (hasValidEInvoice): I3 30 + I1 15 - C1 3 = 42 ; non-recoverable: I2 6
  assert.equal(r.totals.recoverableVat, 42);
  assert.equal(r.totals.nonRecoverableVat, 6);
});

test("register date filter is inclusive on both bounds", () => {
  const r = purchaseRegister(docs, { from: "2026-11-01", to: "2026-11-10" });
  assert.deepEqual(r.rows.map((d) => d.id), ["I1", "I2"]);
  assert.equal(r.totals.gross, 161); // 115 + 46
});

test("register tolerates documents with only raw lines (computes totals)", () => {
  const r = purchaseRegister([
    { id: "X", docType: "invoice", supplierName: "A", invoiceDate: "2026-11-02", lines: [{ qty: 2, unitCost: 10 }] },
  ]);
  assert.equal(r.totals.net, 20);
  assert.equal(r.totals.vat, 3);
  assert.equal(r.totals.gross, 23);
});

// ── supplierBalances ──────────────────────────────────────────────────────
test("supplier balance = invoices − credit notes, per supplier", () => {
  const b = supplierBalances(docs);
  const s1 = b.find((x) => x.supplierId === "S1");
  const s2 = b.find((x) => x.supplierId === "S2");
  assert.equal(s1.invoiceTotal, 161);  // 115 + 46
  assert.equal(s1.creditTotal, 23);
  assert.equal(s1.balance, 138);       // 161 - 23
  assert.equal(s1.docCount, 3);
  assert.equal(s1.lastDate, "2026-11-12");
  assert.equal(s2.balance, 230);
});

test("supplier balances sort by balance descending", () => {
  const b = supplierBalances(docs);
  assert.deepEqual(b.map((x) => x.supplierId), ["S2", "S1"]); // 230 > 138
});

test("suppliers are matched by name when ids are absent", () => {
  const b = supplierBalances([
    { docType: "invoice", supplierName: "Al Noor", invoiceDate: "2026-11-01", subtotal: 10, vatAmount: 1.5, total: 11.5 },
    { docType: "credit_note", supplierName: "al noor", invoiceDate: "2026-11-02", subtotal: 10, vatAmount: 1.5, total: 11.5 },
  ]);
  assert.equal(b.length, 1);
  assert.equal(b[0].balance, 0);
});
