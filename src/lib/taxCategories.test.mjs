// Golden tests for src/lib/taxCategories.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normTaxCategory, rateForCategory, productVatRate,
  cartVat, hasNonStandard, taxSubtotals,
  reasonsForCategory, exemptionReasonText, invoiceTaxGroups, categoryNeedsReason,
} from "./taxCategories.js";

test("unset / unknown category defaults to Standard", () => {
  assert.equal(normTaxCategory(undefined), "S");
  assert.equal(normTaxCategory("x"), "S");
  assert.equal(normTaxCategory("Z"), "Z");
  assert.equal(normTaxCategory("E"), "E");
  assert.equal(rateForCategory(undefined), 0.15);
  assert.equal(rateForCategory("Z"), 0);
  assert.equal(rateForCategory("E"), 0);
});

test("productVatRate reads the product's category (default standard)", () => {
  assert.equal(productVatRate({ price: 10 }), 0.15);
  assert.equal(productVatRate({ taxCategory: "Z" }), 0);
});

// ── cartVat: the behaviour-preservation guarantee ──────────────────────────
test("all-standard cart VAT equals vatFromInclusive(total) — unchanged", () => {
  const lines = [{ price: 11.5, qty: 2 }, { price: 5, qty: 1 }]; // total 28 incl
  const r = cartVat(lines);
  // 28 * 15/115 rounded = 3.65
  assert.equal(r.vat, 3.65);
  assert.equal(r.standardGross, 28);
});

test("zero-rated and exempt lines contribute no VAT", () => {
  const lines = [
    { price: 115, qty: 1 },                 // standard, 15 VAT
    { price: 50, qty: 1, taxCategory: "Z" },// zero-rated, 0
    { price: 30, qty: 1, taxCategory: "E" },// exempt, 0
  ];
  const r = cartVat(lines);
  assert.equal(r.standardGross, 115);
  assert.equal(r.vat, 15);
  assert.deepEqual(r.byCategory, { S: 115, Z: 50, E: 30, O: 0 });
});

// ── ZATCA reason codes + out-of-scope ──────────────────────────────────────
test("O (out of scope) is a known category, rate 0, needs a reason", () => {
  assert.equal(normTaxCategory("O"), "O");
  assert.equal(rateForCategory("O"), 0);
  assert.equal(categoryNeedsReason("O"), true);
  assert.equal(categoryNeedsReason("S"), false);
});

test("reasonsForCategory returns the VATEX-SA codes for that category only", () => {
  const z = reasonsForCategory("Z").map((r) => r.code);
  assert.ok(z.includes("VATEX-SA-32"));
  assert.ok(z.includes("VATEX-SA-35"));
  assert.ok(!z.includes("VATEX-SA-29"));           // that's an E code
  const e = reasonsForCategory("E").map((r) => r.code);
  assert.deepEqual(e, ["VATEX-SA-29", "VATEX-SA-29-7", "VATEX-SA-30"]);
  assert.deepEqual(reasonsForCategory("S"), []);    // Standard has no reasons
});

test("exemptionReasonText maps a code to its official text", () => {
  assert.equal(exemptionReasonText("VATEX-SA-32"), "Export of goods");
  assert.equal(exemptionReasonText("VATEX-SA-OOS"), ""); // free text
  assert.equal(exemptionReasonText("nope"), "");
});

test("invoiceTaxGroups: all-standard → one S group, no reason", () => {
  const g = invoiceTaxGroups([{ price: 115, qty: 1 }, { price: 5, qty: 1 }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].code, "S");
  assert.equal(g[0].reasonCode, "");
  assert.equal(g[0].vat > 0, true);
});

test("invoiceTaxGroups: distinct exemption reasons → separate subtotals", () => {
  const g = invoiceTaxGroups([
    { price: 115, qty: 1 },                                              // S
    { price: 50, qty: 1, taxCategory: "Z", taxExemptionReasonCode: "VATEX-SA-32" },
    { price: 20, qty: 1, taxCategory: "Z", taxExemptionReasonCode: "VATEX-SA-35" },
    { price: 30, qty: 1, taxCategory: "E", taxExemptionReasonCode: "VATEX-SA-29" },
  ]);
  // S + two different Z reasons + one E reason = 4 groups
  assert.equal(g.length, 4);
  const z32 = g.find((x) => x.reasonCode === "VATEX-SA-32");
  assert.equal(z32.code, "Z");
  assert.equal(z32.vat, 0);
  assert.equal(z32.reasonText, "Export of goods");
  const e = g.find((x) => x.reasonCode === "VATEX-SA-29");
  assert.equal(e.reasonText, "Financial services mentioned in Article 29 of the VAT Regulations");
});

test("hasNonStandard flags mixed carts", () => {
  assert.equal(hasNonStandard([{ price: 1, qty: 1 }]), false);
  assert.equal(hasNonStandard([{ price: 1, qty: 1, taxCategory: "E" }]), true);
});

// ── taxSubtotals: ZATCA multi-category breakdown data ──────────────────────
test("taxSubtotals returns only present categories with correct VAT", () => {
  const lines = [
    { price: 115, qty: 1 },                  // S
    { price: 50, qty: 1, taxCategory: "Z" }, // Z
  ];
  const subs = taxSubtotals(lines);
  assert.equal(subs.length, 2);
  const s = subs.find((x) => x.code === "S");
  const z = subs.find((x) => x.code === "Z");
  assert.equal(s.rate, 0.15);
  assert.ok(Math.abs(s.vat - 15) < 1e-9); // 115 * 15/115 = 15 (unrounded)
  assert.equal(z.rate, 0);
  assert.equal(z.vat, 0);
});

test("taxSubtotals omits categories with no lines", () => {
  const subs = taxSubtotals([{ price: 10, qty: 1 }]);
  assert.deepEqual(subs.map((s) => s.code), ["S"]);
});
