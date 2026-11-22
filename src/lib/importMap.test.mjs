// Golden tests for src/lib/importMap.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestMapping, applyMapping, mappingComplete, validateRows, IMPORT_FIELDS } from "./importMap.js";

test("suggestMapping auto-maps common headers (exact + fuzzy), no double-use", () => {
  const m = suggestMapping(["Product Name", "Selling Price", "Cost Price", "EAN", "Dept"]);
  assert.equal(m.name, 0);
  assert.equal(m.price, 1);
  assert.equal(m.cost, 2);
  assert.equal(m.barcode, 3);
  assert.equal(m.category, 4); // "dept" alias
  assert.equal(m.nameAr, -1);  // no Arabic column
});

test("applyMapping builds product-field objects from raw rows", () => {
  const mapping = { name: 0, price: 1, barcode: 2, nameAr: -1, category: -1, cost: -1 };
  const rows = applyMapping([["Pepsi", "5", "6281000"], ["Water", "2", ""]], mapping);
  assert.deepEqual(rows[0], { name: "Pepsi", nameAr: "", category: "", price: "5", cost: "", barcode: "6281000" });
  assert.equal(rows[1].name, "Water");
});

test("mappingComplete requires all required fields mapped", () => {
  assert.equal(mappingComplete({ name: 0, price: 1 }), true);
  assert.equal(mappingComplete({ name: 0, price: -1 }), false);
  assert.equal(mappingComplete({ name: -1, price: 1 }), false);
});

test("validateRows flags missing name, missing/invalid price and invalid cost", () => {
  const { valid, errors } = validateRows([
    { name: "Pepsi", price: "5", cost: "2" },
    { name: "", price: "5" },
    { name: "X", price: "abc" },
    { name: "Y", price: "9", cost: "notnum" },
  ]);
  assert.equal(valid.length, 1);
  assert.equal(errors.length, 3);
  assert.deepEqual(errors[0].messages, ["Missing name"]);
  assert.match(errors[1].messages[0], /Invalid price/);
  assert.match(errors[2].messages[0], /Invalid cost/);
});

test("every required field exists in IMPORT_FIELDS", () => {
  const req = IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key);
  assert.deepEqual(req, ["name", "price"]);
});
