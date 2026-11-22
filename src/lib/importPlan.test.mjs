// Golden tests for src/lib/importPlan.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImport, mergeUpdate } from "./importPlan.js";

const existing = [
  { id: 1, name: "Pepsi Can", category: "Drinks", price: 5, cost: 2, stock: 120, barcode: "6281000", active: true },
  { id: 2, name: "Water 500ml", category: "Drinks", price: 2, cost: 1, stock: 50, barcode: "", active: true },
];

test("new rows are created; matches are skipped by default (idempotent)", () => {
  const rows = [
    { name: "Pepsi Can", category: "Drinks", price: "6", barcode: "6281000" }, // matches by barcode
    { name: "Water 500ml", category: "Drinks", price: "3" },                   // matches by name+category
    { name: "Juice", category: "Drinks", price: "7", barcode: "9999" },        // new
  ];
  const plan = classifyImport(rows, existing);
  assert.equal(plan.summary.create, 1);
  assert.equal(plan.summary.existingSkipped, 2);
  assert.equal(plan.summary.update, 0);
  assert.equal(plan.create[0].row.name, "Juice");
});

test("re-running the SAME import twice creates nothing the second time", () => {
  const rows = [{ name: "Juice", category: "Drinks", price: "7", barcode: "9999" }];
  const first = classifyImport(rows, existing);
  assert.equal(first.summary.create, 1);
  // simulate the catalogue after applying the first run:
  const after = [...existing, { id: 3, name: "Juice", category: "Drinks", price: 7, barcode: "9999", stock: 0 }];
  const second = classifyImport(rows, after);
  assert.equal(second.summary.create, 0);
  assert.equal(second.summary.existingSkipped, 1);
});

test("updateExisting=true turns matches into updates", () => {
  const rows = [{ name: "Pepsi Can", category: "Drinks", price: "6", barcode: "6281000" }];
  const plan = classifyImport(rows, existing, { updateExisting: true });
  assert.equal(plan.summary.update, 1);
  assert.equal(plan.summary.create, 0);
  assert.equal(plan.update[0].existing.id, 1);
});

test("in-file duplicates are detected and skipped", () => {
  const rows = [
    { name: "New A", category: "X", price: "1", barcode: "111" },
    { name: "New A again", category: "X", price: "1", barcode: "111" }, // same barcode in file
    { name: "No Barcode", category: "X", price: "1" },
    { name: "No Barcode", category: "X", price: "9" },                   // same name+cat, no barcode
  ];
  const plan = classifyImport(rows, []);
  assert.equal(plan.summary.duplicateInFile, 2);
  assert.equal(plan.summary.create, 2);
});

test("mergeUpdate never touches stock/id/active and blanks don't erase", () => {
  const merged = mergeUpdate(existing[0], { name: "", price: "7", cost: "", barcode: "6281000" });
  assert.equal(merged.id, 1);
  assert.equal(merged.stock, 120);     // untouched
  assert.equal(merged.active, true);   // untouched
  assert.equal(merged.name, "Pepsi Can"); // blank kept existing
  assert.equal(merged.cost, 2);         // blank kept existing
  assert.equal(merged.price, 7);        // updated
});
