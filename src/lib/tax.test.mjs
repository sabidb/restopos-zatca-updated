// Golden tests for src/lib/tax.js — run with: npm test
// These lock the CURRENT VAT behaviour. If a future change alters a number here,
// that is a change to reported tax and must be a conscious, signed-off decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VAT_RATE, VAT_INCLUSIVE_FACTOR,
  vatFromInclusive, netFromInclusive, vatFromInclusiveRaw,
  round2tx, zatcaRound, zr2, extractVATInclusive,
} from "./tax.js";

test("VAT_RATE and factor are the KSA standard", () => {
  assert.equal(VAT_RATE, 0.15);
  assert.equal(VAT_INCLUSIVE_FACTOR, 15 / 115);
});

test("vatFromInclusive matches the old inline parseFloat((x*15/115).toFixed(2))", () => {
  const golden = [
    [0, 0], [5, 0.65], [10, 1.3], [28, 3.65], [35, 4.57],
    [52, 6.78], [85, 11.09], [100, 13.04], [999.99, 130.43],
  ];
  for (const [inc, want] of golden) {
    assert.equal(vatFromInclusive(inc), want, `vat(${inc})`);
    // equivalence to the exact original expression:
    assert.equal(vatFromInclusive(inc), parseFloat((inc * (15 / 115)).toFixed(2)));
  }
});

test("netFromInclusive = inclusive - rounded VAT (transaction path)", () => {
  const golden = [[28, 24.35], [35, 30.43], [100, 86.96], [52, 45.22]];
  for (const [inc, want] of golden) {
    assert.equal(netFromInclusive(inc), want, `net(${inc})`);
  }
});

test("REGRESSION: inclusive 35 with no discount stays 35.00, VAT 4.57 (not 34.99/4.56)", () => {
  // This is the exact bug the old PaymentModal comment documented.
  const origTotal = 35;
  const finalTotal = round2tx(Math.max(0, origTotal - 0));
  const finalVat = vatFromInclusive(finalTotal);
  const subtotal = netFromInclusive(finalTotal);
  assert.equal(finalTotal, 35.0);
  assert.equal(finalVat, 4.57);
  assert.equal(subtotal, 30.43);
  assert.equal(round2tx(subtotal + finalVat), 35.0); // parts reconcile to the whole
});

test("vatFromInclusiveRaw is unrounded (accumulation sites)", () => {
  assert.equal(vatFromInclusiveRaw(28), 28 * (15 / 115));
  // summing raw then rounding the total, as reports do:
  const lines = [28, 35, 52];
  const rawSum = lines.reduce((s, x) => s + vatFromInclusiveRaw(x), 0);
  assert.equal(zr2(rawSum), zr2(lines.reduce((s, x) => s + x * 15 / 115, 0)));
});

test("zatcaRound is half-up and matches the old inline definition", () => {
  const oldZatcaRound = (v, dp = 2) => { const f = Math.pow(10, dp); return Math.floor(v * f + 0.5) / f; };
  for (const v of [0, 1.005, 2.675, 13.043478, 99.999, 100 / 3]) {
    assert.equal(zatcaRound(v), oldZatcaRound(v), `zatcaRound(${v})`);
  }
});

test("extractVATInclusive: standard and zero-rated/exempt (rate 0)", () => {
  assert.deepEqual(extractVATInclusive(115), { net: 100, vat: 15, total: 115 });
  assert.deepEqual(extractVATInclusive(100, 0), { net: 100, vat: 0, total: 100 }); // zero-rated / exempt
});
