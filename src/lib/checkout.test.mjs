// Golden tests for src/lib/checkout.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discountManual, discountPromo, totalAfterDiscount, calculateCheckoutSale,
  cashChange, isCashShort, cashSufficient, splitDiff, splitValid, paymentReady,
} from "./checkout.js";

test("manual discount: percent and flat, capped at subtotal", () => {
  assert.equal(discountManual(100, { type: "%", value: "10" }), 10);
  assert.equal(discountManual(100, { type: "flat", value: "30" }), 30);
  assert.equal(discountManual(100, { type: "flat", value: "999" }), 100); // capped
  assert.equal(discountManual(100, { type: "%", value: "200" }), 100);    // capped
  assert.equal(discountManual(100, {}), 0);
});

test("promo discount: percent uncapped, flat capped, none => 0", () => {
  assert.equal(discountPromo(100, { type: "%", value: 10 }), 10);
  assert.equal(discountPromo(100, { type: "flat", value: 30 }), 30);
  assert.equal(discountPromo(100, { type: "flat", value: 999 }), 100);
  assert.equal(discountPromo(100, null), 0);
});

test("final total never goes below zero and is rounded", () => {
  assert.equal(totalAfterDiscount(35, 0), 35);
  assert.equal(totalAfterDiscount(35, 5), 30);
  assert.equal(totalAfterDiscount(35, 999), 0); // clamped
});

test("REGRESSION: inclusive 35, no discount stays 35.00", () => {
  assert.equal(totalAfterDiscount(35, 0), 35.0);
});

test("cash change and shortfall", () => {
  assert.equal(cashChange(30, "50"), 20);
  assert.equal(cashChange(30, "30"), 0);
  assert.equal(cashChange(30, "20"), 0);       // never negative
  assert.equal(isCashShort(30, "20"), true);
  assert.equal(isCashShort(30, "30"), false);
  assert.equal(isCashShort(30, "0"), false);   // nothing entered yet is not "short"
  assert.equal(cashSufficient(30, "30"), true);
  assert.equal(cashSufficient(30, "29.99"), false);
});

test("split payment must add up to the total", () => {
  assert.equal(splitDiff(100, "60", "40"), 0);
  assert.equal(splitValid(100, "60", "40"), true);
  assert.equal(splitValid(100, "60", "41"), false);
  assert.equal(splitValid(100, "60", "39.995"), true); // within half a halala
});

test("paymentReady gates each method correctly", () => {
  assert.equal(paymentReady({ method: "Cash", total: 30, cashGiven: "30" }), true);
  assert.equal(paymentReady({ method: "Cash", total: 30, cashGiven: "29" }), false);
  assert.equal(paymentReady({ method: "Card", total: 30 }), true);
  assert.equal(paymentReady({ method: "Card", total: 0 }), false);      // nothing to pay
  assert.equal(paymentReady({ method: "Both", total: 100, splitCash: "60", splitCard: "40" }), true);
  assert.equal(paymentReady({ method: "Both", total: 100, splitCash: "60", splitCard: "30" }), false);
});


test("canonical checkout calculation reconciles line totals, net and VAT", () => {
  const sale = calculateCheckoutSale([{ id: "a", qty: 1, price: 115 }, { id: "b", qty: 2, price: 23 }], 5);
  assert.equal(sale.total, 156);
  assert.equal(sale.subtotal, 161);
  assert.equal(sale.discount, 5);
  assert.equal(sale.total, sale.net + sale.vat);
  assert.equal(sale.lines.reduce((s, l) => s + l.total, 0), sale.total);
});

test("canonical checkout calculation respects zero-rated products", () => {
  const sale = calculateCheckoutSale([{ id: "z", qty: 1, price: 100, taxCategory: "Z" }, { id: "s", qty: 1, price: 115 }], 0);
  assert.equal(sale.total, 215);
  assert.equal(sale.vat, 15);
  assert.equal(sale.lines.find(l => l.id === "z").vat, 0);
});

test("canonical checkout discount allocation remains deterministic at cent precision", () => {
  const sale = calculateCheckoutSale([{ id: "a", qty: 1, price: 1 }, { id: "b", qty: 1, price: 1 }, { id: "c", qty: 1, price: 1 }], 0.01);
  assert.deepEqual(sale.lines.map(l => l.discount), [0.01, 0, 0]);
  assert.equal(sale.total, sale.net + sale.vat);
});
