// Golden tests for src/lib/purchases.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normInvoiceNo, computeLine, computePurchaseInvoice,
  validatePurchaseInvoice, detectDuplicatePurchase,
  normDocType, signedAmounts,
} from "./purchases.js";

// ── line & invoice math (VAT-EXCLUSIVE, VAT added on top) ─────────────────
test("computeLine: net = qty×unitCost, VAT on top at 15%", () => {
  const l = computeLine({ qty: 3, unitCost: 10 });
  assert.equal(l.net, 30);
  assert.equal(l.vat, 4.5);
  assert.equal(l.gross, 34.5);
  assert.equal(l.rate, 0.15);
});

test("computeLine: explicit rate 0 is honoured (zero-rated/exempt purchase)", () => {
  const l = computeLine({ qty: 5, unitCost: 4, rate: 0 });
  assert.equal(l.net, 20);
  assert.equal(l.vat, 0);
  assert.equal(l.gross, 20);
});

test("computeLine: half-up rounding (zr2), not inclusive extraction", () => {
  // 1 × 0.125 net = 0.125 → 0.13 ; vat = 0.13×0.15 = 0.0195 → 0.02
  const l = computeLine({ qty: 1, unitCost: 0.125 });
  assert.equal(l.net, 0.13);
  assert.equal(l.vat, 0.02);
  assert.equal(l.gross, 0.15);
});

test("computePurchaseInvoice: totals SUM the rounded lines (no penny drift)", () => {
  const inv = computePurchaseInvoice({
    supplierName: "Al Noor Foods",
    supplierInvoiceNo: "INV-100",
    invoiceDate: "2026-11-01",
    lines: [
      { qty: 2, unitCost: 3.33 },   // net 6.66, vat 1.00, gross 7.66
      { qty: 1, unitCost: 10 },      // net 10,   vat 1.50, gross 11.50
    ],
  });
  assert.equal(inv.subtotal, 16.66);
  assert.equal(inv.vatAmount, 2.5);
  assert.equal(inv.total, 19.16);
  // lines always add up to the printed total
  const lineGross = inv.lines.reduce((s, l) => s + l.gross, 0);
  assert.equal(Math.round(lineGross * 100) / 100, inv.total);
});

test("computePurchaseInvoice: attaches normalised number for dedup", () => {
  const inv = computePurchaseInvoice({ supplierInvoiceNo: " inv/100 " });
  assert.equal(inv.supplierInvoiceNo, "inv/100"); // display trimmed only
  assert.equal(inv.supplierInvoiceNoNorm, "INV100");
});

// ── number normalisation ─────────────────────────────────────────────────
test("normInvoiceNo collapses spacing/dashes/slashes/case", () => {
  assert.equal(normInvoiceNo("INV-001"), "INV001");
  assert.equal(normInvoiceNo("inv 001"), "INV001");
  assert.equal(normInvoiceNo("INV/001"), "INV001");
  assert.equal(normInvoiceNo("  inv.001 "), "INV001");
  assert.equal(normInvoiceNo(null), "");
});

// ── validation ───────────────────────────────────────────────────────────
test("validate: a complete invoice is valid", () => {
  const r = validatePurchaseInvoice({
    supplierId: "SUP-1", supplierInvoiceNo: "A1", invoiceDate: "2026-11-01",
    lines: [{ qty: 1, unitCost: 5 }],
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test("validate: flags missing supplier / number / date / lines", () => {
  const r = validatePurchaseInvoice({ lines: [] });
  assert.ok(r.errors.includes("supplier-required"));
  assert.ok(r.errors.includes("invoice-number-required"));
  assert.ok(r.errors.includes("invoice-date-required"));
  assert.ok(r.errors.includes("no-lines"));
  assert.equal(r.valid, false);
});

test("validate: a line with qty 0 does not count; negatives are rejected", () => {
  const r = validatePurchaseInvoice({
    supplierName: "X", supplierInvoiceNo: "1", invoiceDate: "2026-11-01",
    lines: [{ qty: 0, unitCost: 5 }, { qty: -1, unitCost: 5 }],
  });
  assert.ok(r.errors.includes("no-lines"));
  assert.ok(r.errors.includes("negative-qty"));
});

// ── duplicate detection ──────────────────────────────────────────────────
const existing = [
  { id: "P1", supplierId: "SUP-1", supplierName: "Al Noor", supplierInvoiceNo: "INV-100",
    invoiceDate: "2026-11-01", lines: [{ qty: 1, unitCost: 100 }] }, // total 115
];

test("exact duplicate: same supplier + same invoice number (any formatting)", () => {
  const r = detectDuplicatePurchase(
    { supplierId: "SUP-1", supplierInvoiceNo: "inv 100", invoiceDate: "2026-11-05",
      lines: [{ qty: 2, unitCost: 9 }] }, existing);
  assert.equal(r.duplicate, true);
  assert.equal(r.level, "exact");
  assert.equal(r.match.id, "P1");
});

test("exact duplicate matches by supplier NAME when ids are absent", () => {
  const r = detectDuplicatePurchase(
    { supplierName: "al noor", supplierInvoiceNo: "INV/100", invoiceDate: "2026-11-09",
      lines: [{ qty: 1, unitCost: 1 }] },
    [{ id: "P9", supplierName: "Al Noor", supplierInvoiceNo: "INV-100", invoiceDate: "2026-11-01" }]);
  assert.equal(r.level, "exact");
});

test("near duplicate: same supplier + same total + same date, different number", () => {
  const r = detectDuplicatePurchase(
    { supplierId: "SUP-1", supplierInvoiceNo: "DIFFERENT", invoiceDate: "2026-11-01",
      lines: [{ qty: 1, unitCost: 100 }] }, existing); // total 115, same date
  assert.equal(r.duplicate, true);
  assert.equal(r.level, "near");
});

test("not a duplicate: different supplier, or different number+total", () => {
  const diffSupplier = detectDuplicatePurchase(
    { supplierId: "SUP-2", supplierInvoiceNo: "INV-100", invoiceDate: "2026-11-01",
      lines: [{ qty: 1, unitCost: 100 }] }, existing);
  assert.equal(diffSupplier.duplicate, false);

  const diffEverything = detectDuplicatePurchase(
    { supplierId: "SUP-1", supplierInvoiceNo: "INV-200", invoiceDate: "2026-12-01",
      lines: [{ qty: 1, unitCost: 5 }] }, existing);
  assert.equal(diffEverything.duplicate, false);
});

test("editing an invoice does not flag itself (ignoreId)", () => {
  const r = detectDuplicatePurchase(
    { id: "P1", supplierId: "SUP-1", supplierInvoiceNo: "INV-100", invoiceDate: "2026-11-01",
      lines: [{ qty: 1, unitCost: 100 }] }, existing, { ignoreId: "P1" });
  assert.equal(r.duplicate, false);
});

test("a blank candidate number never triggers an exact match", () => {
  const r = detectDuplicatePurchase(
    { supplierId: "SUP-1", supplierInvoiceNo: "", invoiceDate: "2026-11-20",
      lines: [{ qty: 1, unitCost: 1 }] }, existing);
  assert.equal(r.level, null);
});

// ── doc types: invoice vs credit note ────────────────────────────────────
test("normDocType defaults to invoice; only 'credit_note' is the other", () => {
  assert.equal(normDocType(undefined), "invoice");
  assert.equal(normDocType("invoice"), "invoice");
  assert.equal(normDocType("anything"), "invoice");
  assert.equal(normDocType("credit_note"), "credit_note");
});

test("computePurchaseInvoice always carries a docType (default invoice)", () => {
  assert.equal(computePurchaseInvoice({ lines: [] }).docType, "invoice");
  assert.equal(computePurchaseInvoice({ docType: "credit_note", lines: [] }).docType, "credit_note");
});

test("signedAmounts: invoice positive, credit note negative", () => {
  const inv = { docType: "invoice", subtotal: 100, vatAmount: 15, total: 115 };
  const cn = { docType: "credit_note", subtotal: 100, vatAmount: 15, total: 115 };
  assert.deepEqual(signedAmounts(inv), { subtotal: 100, vatAmount: 15, total: 115, sign: 1 });
  assert.deepEqual(signedAmounts(cn), { subtotal: -100, vatAmount: -15, total: -115, sign: -1 });
});

test("signedAmounts computes totals when the doc carries only raw lines", () => {
  const cn = { docType: "credit_note", lines: [{ qty: 2, unitCost: 10 }] }; // net 20, vat 3
  assert.deepEqual(signedAmounts(cn), { subtotal: -20, vatAmount: -3, total: -23, sign: -1 });
});

test("duplicate detection is scoped to the same doc type", () => {
  const pool = [
    { id: "I1", docType: "invoice", supplierId: "SUP-1", supplierInvoiceNo: "X1", invoiceDate: "2026-11-01", lines: [{ qty: 1, unitCost: 10 }] },
  ];
  // a CREDIT NOTE numbered X1 for the same supplier is NOT a duplicate of the invoice
  const cn = detectDuplicatePurchase(
    { docType: "credit_note", supplierId: "SUP-1", supplierInvoiceNo: "X1", invoiceDate: "2026-11-02", lines: [{ qty: 1, unitCost: 5 }] }, pool);
  assert.equal(cn.duplicate, false);
  // another invoice X1 for the same supplier IS a duplicate
  const inv = detectDuplicatePurchase(
    { docType: "invoice", supplierId: "SUP-1", supplierInvoiceNo: "X1", invoiceDate: "2026-11-09", lines: [{ qty: 1, unitCost: 1 }] }, pool);
  assert.equal(inv.level, "exact");
});
