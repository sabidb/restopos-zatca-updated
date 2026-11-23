// Golden tests for src/lib/vatBridge.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { purchaseDocsToVatTx, recoverableInputVat } from "./vatBridge.js";

const docs = [
  { id: "I1", docType: "invoice", supplierName: "Al Noor", supplierInvoiceNo: "A-1", invoiceDate: "2026-11-01", hasValidEInvoice: true,  subtotal: 100, vatAmount: 15, total: 115 },
  { id: "I2", docType: "invoice", supplierName: "Cash Co", supplierInvoiceNo: "C-9", invoiceDate: "2026-11-03", hasValidEInvoice: false, subtotal: 40,  vatAmount: 6,  total: 46  }, // NOT recoverable
  { id: "C1", docType: "credit_note", supplierName: "Al Noor", supplierInvoiceNo: "CN-1", invoiceDate: "2026-11-10", hasValidEInvoice: true, subtotal: 20, vatAmount: 3, total: 23 },
  { id: "I3", docType: "invoice", supplierName: "Old Co", supplierInvoiceNo: "O-1", invoiceDate: "2026-10-20", hasValidEInvoice: true, subtotal: 50, vatAmount: 7.5, total: 57.5 }, // other month
];

test("only recoverable (valid e-invoice) docs become PURCHASE transactions", () => {
  const tx = purchaseDocsToVatTx(docs, "2026-11");
  const ids = tx.map((t) => t.id);
  assert.ok(ids.includes("autopur-I1"));
  assert.ok(ids.includes("autopur-C1"));
  assert.ok(!ids.includes("autopur-I2")); // non-recoverable excluded
  assert.ok(!ids.includes("autopur-I3")); // other month excluded
  assert.ok(tx.every((t) => t.type === "PURCHASE"));
});

test("credit notes carry signed (negative) amounts", () => {
  const tx = purchaseDocsToVatTx(docs, "2026-11");
  const cn = tx.find((t) => t.id === "autopur-C1");
  assert.equal(cn.vat, -3);
  assert.equal(cn.net, -20);
});

test("recoverableInputVat nets invoices minus credit notes for the period", () => {
  // Nov: I1 +15, C1 -3  → 12 (I2 excluded non-recoverable, I3 other month)
  assert.equal(recoverableInputVat(docs, "2026-11"), 12);
});

test("no period → all recoverable docs across months", () => {
  // I1 +15, C1 -3, I3 +7.5 → 19.5
  assert.equal(recoverableInputVat(docs), 19.5);
});

test("tx shape matches what the VAT engine aggregates", () => {
  const t = purchaseDocsToVatTx([docs[0]], "2026-11")[0];
  assert.equal(t.type, "PURCHASE");
  assert.equal(t.category, "STANDARD");
  assert.equal(t.net, 100);
  assert.equal(t.vat, 15);
  assert.equal(t.gross, 115);
  assert.ok(t.auto && t.source === "purchase-doc");
});

test("empty / missing input is safe", () => {
  assert.deepEqual(purchaseDocsToVatTx(undefined, "2026-11"), []);
  assert.equal(recoverableInputVat([], "2026-11"), 0);
});
