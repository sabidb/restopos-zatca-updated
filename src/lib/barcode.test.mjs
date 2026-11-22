// Golden tests for src/lib/barcode.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { normCode, productBarcodes, matchesBarcode, findByBarcode, findAllByBarcode, parseBarcodeInput } from "./barcode.js";

const items = [
  { id: 1, name: "Pepsi Can", barcode: "6281000", barcodes: ["12345678", "6281000"] },
  { id: 2, name: "Water 500ml", barcode: "  6299777  " }, // untrimmed primary, no array
  { id: 3, name: "Loose apples", barcode: "" },            // no barcode (weighed/lookup by name)
];

test("normCode trims and stringifies", () => {
  assert.equal(normCode("  99 "), "99");
  assert.equal(normCode(42), "42");
  assert.equal(normCode(null), "");
});

test("productBarcodes lists primary then extras, de-duped", () => {
  assert.deepEqual(productBarcodes(items[0]), ["6281000", "12345678"]); // dup collapsed
  assert.deepEqual(productBarcodes(items[1]), ["6299777"]);             // trimmed
  assert.deepEqual(productBarcodes(items[2]), []);
});

test("matchesBarcode matches primary OR any secondary; empty never matches", () => {
  assert.ok(matchesBarcode(items[0], "6281000"));   // primary
  assert.ok(matchesBarcode(items[0], "12345678"));  // secondary
  assert.ok(matchesBarcode(items[1], "6299777"));   // trimmed primary
  assert.equal(matchesBarcode(items[0], "000"), false);
  assert.equal(matchesBarcode(items[2], ""), false);
});

test("findByBarcode returns the product (primary or secondary), else null", () => {
  assert.equal(findByBarcode(items, "12345678")?.id, 1); // via secondary
  assert.equal(findByBarcode(items, "6299777")?.id, 2);
  assert.equal(findByBarcode(items, "nope"), null);
  assert.equal(findByBarcode(items, ""), null);
  assert.equal(findByBarcode([], "6281000"), null);
});

test("findByBarcode preserves old single-barcode behaviour", () => {
  const legacy = [{ id: 9, barcode: "111" }, { id: 10, barcode: "222" }];
  assert.equal(findByBarcode(legacy, "222")?.id, 10);
});

test("findAllByBarcode returns every matching product (for ambiguity detection)", () => {
  const dup = [
    { id: 1, name: "Milk A", barcode: "777" },
    { id: 2, name: "Milk B", barcode: "777", active: false },
    { id: 3, name: "Juice", barcode: "888" },
  ];
  assert.deepEqual(findAllByBarcode(dup, "777").map((i) => i.id), [1, 2]); // both, incl. inactive
  assert.deepEqual(findAllByBarcode(dup, "888").map((i) => i.id), [3]);
  assert.deepEqual(findAllByBarcode(dup, "000"), []);
  assert.deepEqual(findAllByBarcode(dup, ""), []);
});

test("parseBarcodeInput splits on comma/space/semicolon/newline, de-dupes, first = primary", () => {
  assert.deepEqual(parseBarcodeInput("6281000, 12345678 999"), { primary: "6281000", extra: ["12345678", "999"] });
  assert.deepEqual(parseBarcodeInput("abc\nabc; def"), { primary: "abc", extra: ["def"] });
  assert.deepEqual(parseBarcodeInput("   "), { primary: "", extra: [] });
  assert.deepEqual(parseBarcodeInput("solo"), { primary: "solo", extra: [] });
});
