// Golden tests for src/lib/sync.js status tracking — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSync, syncKeyToFirestore, getSyncStatus, SYNC_FIELD_BUDGET_BYTES } from "./sync.js";

// Minimal Firestore handle mocks (same shape initSync expects).
const okHandles = { db: {}, doc: () => ({}), setDoc: async () => {} };
const failHandles = { db: {}, doc: () => ({}), setDoc: async () => { throw new Error("network down"); } };

test("a successful sync records ok + byte size", async () => {
  initSync(okHandles);
  await syncKeyToFirestore("LK", "restopos_items", [{ a: 1 }]);
  const s = getSyncStatus().restopos_items;
  assert.equal(s.ok, true);
  assert.ok(s.sizeBytes > 0);
  assert.ok(s.at);
});

test("an oversized key is refused and recorded with reason 'oversize'", async () => {
  initSync(okHandles);
  const huge = "x".repeat(SYNC_FIELD_BUDGET_BYTES + 1000);
  await syncKeyToFirestore("LK", "restopos_archived_sales", huge);
  const s = getSyncStatus().restopos_archived_sales;
  assert.equal(s.ok, false);
  assert.equal(s.reason, "oversize");
  assert.equal(s.budgetBytes, SYNC_FIELD_BUDGET_BYTES);
  assert.ok(s.sizeBytes > SYNC_FIELD_BUDGET_BYTES);
});

test("a write failure is recorded with reason 'error' and the message", async () => {
  initSync(failHandles);
  await syncKeyToFirestore("LK", "restopos_customers", [{ b: 2 }]);
  const s = getSyncStatus().restopos_customers;
  assert.equal(s.ok, false);
  assert.equal(s.reason, "error");
  assert.equal(s.message, "network down");
});

test("getSyncStatus returns a copy (callers can't mutate internals)", async () => {
  initSync(okHandles);
  await syncKeyToFirestore("LK", "restopos_users", [{ c: 3 }]);
  const snap = getSyncStatus();
  snap.restopos_users.ok = "tampered";
  assert.equal(getSyncStatus().restopos_users.ok, true);
});

test("no license key is a no-op (nothing recorded)", async () => {
  initSync(okHandles);
  await syncKeyToFirestore("", "restopos_should_not_appear", [{ d: 4 }]);
  assert.equal(getSyncStatus().restopos_should_not_appear, undefined);
});


test("transactional sync unions cloud and local sales before writing", async () => {
  let written = null;
  const cloud = [{id:"sale-cloud",total:80,updatedAt:"2026-11-28T01:00:00Z"}];
  const txHandles = {
    db: {},
    doc: () => ({}),
    setDoc: async () => {},
    runTransaction: async (_db, callback) => callback({
      get: async () => ({exists:()=>true,data:()=>({restopos_sales:JSON.stringify(cloud)})}),
      set: (_ref, payload) => { written = payload; }
    })
  };
  initSync(txHandles);
  await syncKeyToFirestore("LK", "restopos_sales", [{id:"sale-local",total:50,updatedAt:"2026-11-28T02:00:00Z"}]);
  const merged = JSON.parse(written.restopos_sales);
  assert.equal(merged.length,2);
  assert.deepEqual(new Set(merged.map(s=>s.id)),new Set(["sale-cloud","sale-local"]));
  assert.equal(getSyncStatus().restopos_sales.ok,true);
});
