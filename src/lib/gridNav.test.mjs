import { test } from "node:test";
import assert from "node:assert/strict";
import { arrangeRows, nextCellId, ROW_TOLERANCE } from "./gridNav.js";

// A 3-row till: scan bar (1 cell), then two item rows each with
// [name, price, minus, qty, plus, delete] = 6 cells. Centres are synthetic.
function tillGrid() {
  const row = (y, ids) => ids.map(([id, x]) => ({ id, x, y }));
  return [
    ...row(10, [["scan", 100], ["add", 300]]),
    ...row(60, [["n1", 40], ["p1", 120], ["m1", 180], ["q1", 220], ["pl1", 260], ["d1", 320]]),
    ...row(106, [["n2", 40], ["p2", 120], ["m2", 180], ["q2", 220], ["pl2", 260], ["d2", 320]]),
  ];
}

test("arrangeRows groups by y within tolerance and sorts each row by x", () => {
  const rows = arrangeRows(tillGrid());
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].map((c) => c.id), ["scan", "add"]);
  assert.deepEqual(rows[1].map((c) => c.id), ["n1", "p1", "m1", "q1", "pl1", "d1"]);
  assert.deepEqual(rows[2].map((c) => c.id), ["n2", "p2", "m2", "q2", "pl2", "d2"]);
});

test("small y jitter inside tolerance stays one row", () => {
  const cells = [
    { id: "a", x: 0, y: 50 }, { id: "b", x: 40, y: 50 + ROW_TOLERANCE - 1 }, { id: "c", x: 80, y: 50 },
  ];
  assert.equal(arrangeRows(cells).length, 1);
});

test("ArrowRight walks along a row then serpentines to next row start", () => {
  const g = tillGrid();
  assert.equal(nextCellId(g, "n1", "ArrowRight"), "p1");
  assert.equal(nextCellId(g, "p1", "ArrowRight"), "m1");
  // end of row 2 → first cell of row 3
  assert.equal(nextCellId(g, "d1", "ArrowRight"), "n2");
});

test("ArrowLeft walks back then serpentines to previous row end", () => {
  const g = tillGrid();
  assert.equal(nextCellId(g, "m1", "ArrowLeft"), "p1");
  assert.equal(nextCellId(g, "n2", "ArrowLeft"), "d1");
});

test("ArrowDown/Up pick the x-nearest cell in the adjacent row", () => {
  const g = tillGrid();
  // qty q1 (x=220) down → nearest in row3 is q2 (x=220)
  assert.equal(nextCellId(g, "q1", "ArrowDown"), "q2");
  // from scan (x=100) down → nearest in item row is name (x=40) vs price (x=120) → price
  assert.equal(nextCellId(g, "scan", "ArrowDown"), "p1");
  assert.equal(nextCellId(g, "p2", "ArrowUp"), "p1");
});

test("vertical moves clamp at the edges (null = no-op, caller keeps default)", () => {
  const g = tillGrid();
  assert.equal(nextCellId(g, "scan", "ArrowUp"), null);
  assert.equal(nextCellId(g, "d2", "ArrowDown"), null);
});

test("horizontal moves stop at the very first/last cell", () => {
  const g = tillGrid();
  assert.equal(nextCellId(g, "scan", "ArrowLeft"), null);
  assert.equal(nextCellId(g, "d2", "ArrowRight"), null);
});

test("no active focus → entry point (first for forward, last for back)", () => {
  const g = tillGrid();
  assert.equal(nextCellId(g, null, "ArrowDown"), "scan");
  assert.equal(nextCellId(g, null, "ArrowRight"), "scan");
  assert.equal(nextCellId(g, null, "ArrowUp"), "d2");
});

test("empty / malformed input is safe", () => {
  assert.equal(nextCellId([], "x", "ArrowDown"), null);
  assert.equal(nextCellId(null, null, "ArrowRight"), null);
  assert.equal(arrangeRows([{ id: null, x: 0, y: 0 }, { id: "ok", x: NaN, y: 1 }]).length, 0);
});
