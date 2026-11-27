// Tests for durable purchase cloud-sync state (AUD-03) — run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  initPurchaseStore, savePurchaseInvoice, loadPurchaseInvoices,
  setPurchaseInvoicesLocal, pendingSyncIds, unsyncedPurchaseCount, flushPurchaseSync,
} from "./purchaseStore.js";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
// Let microtasks AND the promise chain settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

const INV = { supplierName: "A", supplierInvoiceNo: "1", invoiceDate: "2026-11-01", lines: [{ qty: 1, unitCost: 10 }] };

let storage, mode;
function initWith(cloud) { storage = memStorage(); initPurchaseStore({ storage, cloud }); }

beforeEach(() => { mode = "ok"; });

test("a saved purchase is 'pending' until the cloud confirms, then 'synced'", async () => {
  initWith({ persist: async () => mode !== "fail", remove: async () => true });
  const a = savePurchaseInvoice(INV);
  // Synchronously right after save, before the async outcome settles:
  assert.equal(a.syncStatus, "pending");
  assert.equal(loadPurchaseInvoices()[0].syncStatus, "pending");
  assert.deepEqual(pendingSyncIds(), [a.id]);

  await settle();
  assert.equal(loadPurchaseInvoices()[0].syncStatus, "synced");
  assert.equal(unsyncedPurchaseCount(), 0);
});

test("a failed cloud write is recorded as 'failed' and stays counted (not lost)", async () => {
  initWith({ persist: async () => mode !== "fail", remove: async () => true });
  mode = "fail";
  const a = savePurchaseInvoice(INV);
  await settle();
  assert.equal(loadPurchaseInvoices()[0].syncStatus, "failed");
  assert.equal(loadPurchaseInvoices()[0].syncError, "cloud write failed");
  assert.equal(unsyncedPurchaseCount(), 1);
  assert.deepEqual(pendingSyncIds(), [a.id]);
});

test("flushPurchaseSync retries failed records and clears them once the cloud recovers", async () => {
  initWith({ persist: async () => mode !== "fail", remove: async () => true });
  mode = "fail";
  savePurchaseInvoice(INV);
  await settle();
  assert.equal(unsyncedPurchaseCount(), 1);

  mode = "ok"; // connection restored
  const summary = await flushPurchaseSync();
  assert.equal(summary.synced, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.pending, 0);
  assert.equal(unsyncedPurchaseCount(), 0);
  assert.equal(loadPurchaseInvoices()[0].syncStatus, "synced");
});

test("with no cloud adapter, records are purely local and never counted as unsynced", async () => {
  initWith(null);
  savePurchaseInvoice(INV);
  assert.equal(loadPurchaseInvoices()[0].syncStatus, "local");
  assert.equal(unsyncedPurchaseCount(), 0);
  assert.deepEqual(await flushPurchaseSync(), { noCloud: true, synced: 0, failed: 0, pending: 0 });
});

test("records hydrated from the cloud (no syncStatus) are not counted as unsynced", () => {
  initWith({ persist: async () => true, remove: async () => true });
  setPurchaseInvoicesLocal([
    { id: "c1", supplierName: "Cloud", total: 10, updatedAt: "2026-11-01T00:00:00Z" },
    { id: "c2", supplierName: "Cloud", total: 20, updatedAt: "2026-11-02T00:00:00Z" },
  ]);
  assert.equal(unsyncedPurchaseCount(), 0);
  assert.deepEqual(pendingSyncIds(), []);
});
