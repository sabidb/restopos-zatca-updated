import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRecordsById, isRecordArrayKey, resolveKeyOnRestore } from "./syncMerge.js";

test("union keeps records unique to each side (no data loss)", () => {
  const local = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const cloud = [{ id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }];
  const m = mergeRecordsById(local, cloud);
  assert.deepEqual(m.map((r) => r.id).sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test("the old data-loss case: cloud longer no longer overwrites local", () => {
  // Regression guard for the bug this module fixes.
  const local = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const cloud = [{ id: "x" }, { id: "y" }, { id: "z" }, { id: "w" }];
  const m = mergeRecordsById(local, cloud);
  for (const id of ["a", "b", "c"]) assert.ok(m.some((r) => r.id === id), `${id} kept`);
  assert.equal(m.length, 7);
});

test("same id on both sides collapses to the newer (by updatedAt)", () => {
  const local = [{ id: 1, v: "old", updatedAt: "2026-01-01T00:00:00Z" }];
  const cloud = [{ id: 1, v: "new", updatedAt: "2026-02-01T00:00:00Z" }];
  assert.equal(mergeRecordsById(local, cloud)[0].v, "new");
  // and the reverse
  assert.equal(mergeRecordsById(cloud, local)[0].v, "new");
});

test("sales conflict uses date+time when no updatedAt", () => {
  const local = [{ id: 9, total: 10, date: "2026-11-01", time: "09:00" }];
  const cloud = [{ id: 9, total: 12, date: "2026-11-01", time: "17:00" }];
  assert.equal(mergeRecordsById(local, cloud)[0].total, 12);
});

test("records without id are all kept and de-duped", () => {
  const local = [{ name: "x" }];
  const cloud = [{ name: "x" }, { name: "y" }];
  const m = mergeRecordsById(local, cloud);
  assert.equal(m.filter((r) => r.name === "x").length, 1);
  assert.ok(m.some((r) => r.name === "y"));
});

test("empty / non-array inputs are safe", () => {
  assert.deepEqual(mergeRecordsById(null, null), []);
  assert.deepEqual(mergeRecordsById([{ id: 1 }], undefined).map((r) => r.id), [1]);
});

test("isRecordArrayKey covers sales, customers and monthly buckets", () => {
  assert.ok(isRecordArrayKey("restopos_sales"));
  assert.ok(isRecordArrayKey("restopos_customers"));
  assert.ok(isRecordArrayKey("restopos_sales_2026-11"));
  assert.ok(!isRecordArrayKey("restopos_company"));
  assert.ok(!isRecordArrayKey("restopos_invoice_format"));
});

test("resolveKeyOnRestore unions record keys and reports change", () => {
  const r = resolveKeyOnRestore("restopos_sales", [{ id: 1 }], [{ id: 2 }]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.value.map((x) => x.id).sort(), [1, 2]);
  // no new records → no change
  const r2 = resolveKeyOnRestore("restopos_sales", [{ id: 1 }], [{ id: 1 }]);
  assert.equal(r2.changed, false);
});

test("resolveKeyOnRestore keeps local config unless cloud is newer", () => {
  const local = { a: 1 }, cloud = { a: 2 };
  assert.deepEqual(resolveKeyOnRestore("restopos_company", local, cloud, "2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z").value, local);
  assert.deepEqual(resolveKeyOnRestore("restopos_company", local, cloud, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z").value, cloud);
});
