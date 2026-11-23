// Golden tests for src/lib/costing.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { weightedAverageCost, postReceiptToStock } from "./costing.js";

// ── weightedAverageCost ─────────────────────────────────────────────────────
test("averages old and received cost, weighted by quantity", () => {
  // 10 @ 5 + 10 @ 7 → 20 @ 6
  assert.deepEqual(weightedAverageCost(10, 5, 10, 7), { stock: 20, cost: 6 });
});

test("no prior stock → cost becomes the receipt cost", () => {
  assert.deepEqual(weightedAverageCost(0, 0, 8, 4.5), { stock: 8, cost: 4.5 });
});

test("receiving zero is a no-op (stock + rounded cost unchanged)", () => {
  assert.deepEqual(weightedAverageCost(12, 3.3, 0, 99), { stock: 12, cost: 3.3 });
});

test("rounds half-up to 2dp", () => {
  // 3@1 + 1@2 = (3+2)/4 = 1.25
  assert.equal(weightedAverageCost(3, 1, 1, 2).cost, 1.25);
  // 1@0.1 + 2@0.2 = (0.1+0.4)/3 = 0.1666… → 0.17
  assert.equal(weightedAverageCost(1, 0.1, 2, 0.2).cost, 0.17);
});

test("negatives are floored to zero", () => {
  assert.deepEqual(weightedAverageCost(-5, -2, 4, 3), { stock: 4, cost: 3 });
});

// ── postReceiptToStock ──────────────────────────────────────────────────────
const items = [
  { id: 1, name: "Milk 1L", stock: 10, cost: 5, price: 7 },
  { id: 2, name: "Bread", stock: 4, cost: 2, price: 3 },
];

test("posts matched lines by itemId, re-averaging cost and adding stock", () => {
  const r = postReceiptToStock(items, [{ itemId: 1, name: "whatever", qty: 10, unitCost: 7 }]);
  const milk = r.items.find((i) => i.id === 1);
  assert.equal(milk.stock, 20);
  assert.equal(milk.cost, 6);
  assert.equal(r.posted.length, 1);
  assert.equal(r.posted[0].addedQty, 10);
  // originals untouched
  assert.equal(items[0].stock, 10);
});

test("falls back to name match when no itemId", () => {
  const r = postReceiptToStock(items, [{ name: "bread", qty: 6, unitCost: 2.5 }]);
  const bread = r.items.find((i) => i.id === 2);
  assert.equal(bread.stock, 10);               // 4 + 6
  assert.equal(bread.cost, 2.3);               // (4*2 + 6*2.5)/10 = 2.3
});

test("unmatched lines are reported, not posted", () => {
  const r = postReceiptToStock(items, [{ name: "Unknown Item", qty: 5, unitCost: 1 }]);
  assert.equal(r.posted.length, 0);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].name, "Unknown Item");
});

test("zero-qty lines are skipped", () => {
  const r = postReceiptToStock(items, [{ itemId: 1, qty: 0, unitCost: 9 }]);
  assert.equal(r.posted.length, 0);
  assert.equal(r.items.find((i) => i.id === 1).stock, 10);
});
