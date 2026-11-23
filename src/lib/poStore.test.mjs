// Golden tests for src/lib/poStore.js — run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initPOStore, loadPurchaseOrders, savePurchaseOrder, deletePurchaseOrder, PO_LOCAL_KEY } from "./poStore.js";

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

let storage;
beforeEach(() => { storage = memStorage(); initPOStore({ storage, cloud: null }); });

test("save computes ordered value + receipt status, assigns id, prepends", () => {
  const a = savePurchaseOrder({ supplierName: "A", poNumber: "PO-1", lines: [{ name: "X", qty: 10, unitCost: 5 }] });
  assert.ok(a.id.startsWith("PO-"));
  assert.equal(a.orderedValue, 50);
  assert.equal(a.receiptStatus, "open");
  const b = savePurchaseOrder({ supplierName: "B", poNumber: "PO-2", lines: [{ name: "Y", qty: 1, unitCost: 1 }] });
  assert.equal(loadPurchaseOrders()[0].id, b.id); // newest first
});

test("editing receivedQty via save upserts and recomputes receipt status", () => {
  const a = savePurchaseOrder({ supplierName: "A", poNumber: "PO-1", lines: [{ name: "X", qty: 10, unitCost: 5 }] });
  const recv = savePurchaseOrder({ ...a, lines: [{ name: "X", qty: 10, unitCost: 5, receivedQty: 10 }] });
  assert.equal(loadPurchaseOrders().length, 1);
  assert.equal(recv.receiptStatus, "received");
  assert.equal(recv.createdAt, a.createdAt);
});

test("delete removes by id; lands under the dedicated local key (not a SYNC_KEY)", () => {
  const a = savePurchaseOrder({ supplierName: "A", poNumber: "PO-1", lines: [{ name: "X", qty: 1, unitCost: 1 }] });
  deletePurchaseOrder(a.id);
  assert.equal(loadPurchaseOrders().length, 0);
  assert.equal(PO_LOCAL_KEY, "restopos_purchase_orders");
});

test("cloud adapter is notified on save and delete when injected", () => {
  const calls = { persist: 0, remove: 0 };
  initPOStore({ storage, cloud: { persist: () => calls.persist++, remove: () => calls.remove++ } });
  const a = savePurchaseOrder({ supplierName: "A", poNumber: "PO-1", lines: [{ name: "X", qty: 1, unitCost: 1 }] });
  deletePurchaseOrder(a.id);
  assert.equal(calls.persist, 1);
  assert.equal(calls.remove, 1);
});
