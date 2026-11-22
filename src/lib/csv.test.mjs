// Golden tests for src/lib/csv.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCSV, parseCSVRecords, toCSV } from "./csv.js";

test("toCSV round-trips through parseCSV, quoting commas/quotes/newlines", () => {
  const headers = ["name", "note"];
  const rows = [["Rice, Basmati", 'he said "hi"'], ["Milk", "line1\nline2"]];
  const text = toCSV(headers, rows);
  const back = parseCSV(text);
  assert.deepEqual(back.headers, ["name", "note"]);
  assert.equal(back.rows[0].name, "Rice, Basmati");
  assert.equal(back.rows[0].note, 'he said "hi"');
  assert.equal(back.rows[1].note, "line1\nline2");
});

test("basic header + rows, values trimmed", () => {
  const { headers, rows } = parseCSV("name,price\n Pepsi , 5 \nWater,2");
  assert.deepEqual(headers, ["name", "price"]);
  assert.deepEqual(rows, [{ name: "Pepsi", price: "5" }, { name: "Water", price: "2" }]);
});

test("headers are lowercased and trimmed", () => {
  const { headers } = parseCSV(" Name , NameAr ,PRICE\nx,y,1");
  assert.deepEqual(headers, ["name", "namear", "price"]);
});

test("quoted field with an embedded comma is NOT split (the Arabic/comma bug)", () => {
  const { rows } = parseCSV('name,category\n"Rice, Basmati 5kg",Grocery');
  assert.equal(rows[0].name, "Rice, Basmati 5kg");
  assert.equal(rows[0].category, "Grocery");
});

test('escaped double-quotes ("") inside a quoted field', () => {
  const { rows } = parseCSV('name\n"6"" Sub"');
  assert.equal(rows[0].name, '6" Sub');
});

test("CRLF line endings", () => {
  const { rows } = parseCSV("name,price\r\nPepsi,5\r\nWater,2\r\n");
  assert.deepEqual(rows.map((r) => r.name), ["Pepsi", "Water"]);
});

test("UTF-8 BOM is stripped from the first header", () => {
  const { headers } = parseCSV("﻿name,price\nx,1");
  assert.deepEqual(headers, ["name", "price"]);
});

test("newline inside a quoted field is preserved, not a row break", () => {
  const { rows } = parseCSV('name,note\nMilk,"line1\nline2"');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, "line1\nline2");
});

test("blank lines are skipped", () => {
  const { rows } = parseCSV("name,price\nPepsi,5\n\n\nWater,2\n");
  assert.deepEqual(rows.map((r) => r.name), ["Pepsi", "Water"]);
});

test("Arabic values survive untouched", () => {
  const { rows } = parseCSV('name,nameAr\nWater,ماء');
  assert.equal(rows[0].namear, "ماء");
});

test("empty input yields empty headers/rows", () => {
  assert.deepEqual(parseCSV(""), { headers: [], rows: [] });
  assert.deepEqual(parseCSV("   \n  "), { headers: [], rows: [] });
});
