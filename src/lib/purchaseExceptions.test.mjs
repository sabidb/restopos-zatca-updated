// Tests for the purchase exception queue (AUD-02 §5.3) — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { purchaseExceptions } from "./purchaseReports.js";

const VALID_VAT = "300000000000003";

test("flags a bill claimed recoverable but missing evidence, with reasons", () => {
  const docs = [
    { id: "A", supplierName: "No VAT Co", hasValidEInvoice: true, supplierInvoiceNo: "X", invoiceDate: "2026-11-01", vatAmount: 6 }, // no VAT number
  ];
  const ex = purchaseExceptions(docs);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].category, "claimed_not_recoverable");
  assert.ok(ex[0].reasons.includes("invalid-supplier-vat-number"));
});

test("does not flag a fully-evidenced recoverable bill", () => {
  const docs = [
    { id: "A", supplierName: "Good Co", hasValidEInvoice: true, supplierVatNumber: VALID_VAT, supplierInvoiceNo: "X-1", invoiceDate: "2026-11-01", vatAmount: 6 },
  ];
  assert.deepEqual(purchaseExceptions(docs), []);
});

test("does not raise the eligibility exception for a bill that never claimed recoverability", () => {
  const docs = [
    { id: "A", supplierName: "Cash Co", hasValidEInvoice: false, supplierInvoiceNo: "", invoiceDate: "", vatAmount: 6 },
  ];
  // not claimed → no claimed_not_recoverable entry (it's simply non-recoverable, by design)
  assert.equal(purchaseExceptions(docs).some((e) => e.category === "claimed_not_recoverable"), false);
});

test("flags the second of two invoices sharing supplier + invoice number as a duplicate", () => {
  const docs = [
    { id: "A", supplierName: "Al Noor", supplierInvoiceNo: "INV-100", invoiceDate: "2026-11-01", vatAmount: 15 },
    { id: "B", supplierName: "Al Noor", supplierInvoiceNo: "inv 100", invoiceDate: "2026-11-02", vatAmount: 15 }, // same after normalisation
  ];
  const dups = purchaseExceptions(docs).filter((e) => e.category === "duplicate");
  assert.equal(dups.length, 1);
  assert.equal(dups[0].id, "B");
});

test("a credit note reusing an invoice number is not a duplicate", () => {
  const docs = [
    { id: "A", supplierName: "Al Noor", supplierInvoiceNo: "INV-100", invoiceDate: "2026-11-01", vatAmount: 15 },
    { id: "C", supplierName: "Al Noor", docType: "credit_note", supplierInvoiceNo: "INV-100", invoiceDate: "2026-11-03", vatAmount: 15 },
  ];
  assert.equal(purchaseExceptions(docs).some((e) => e.category === "duplicate"), false);
});

test("empty input is safe", () => {
  assert.deepEqual(purchaseExceptions([]), []);
});
