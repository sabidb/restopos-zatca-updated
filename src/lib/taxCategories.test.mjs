// Golden tests for src/lib/taxCategories.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normTaxCategory, rateForCategory, productVatRate,
  cartVat, hasNonStandard, taxSubtotals,
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
  assert.deepEqual(r.byCategory, { S: 115, Z: 50, E: 30 });
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
