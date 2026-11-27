// Golden tests for src/lib/purchaseStore.js — run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  initPurchaseStore, loadPurchaseInvoices, savePurchaseInvoice,
  deletePurchaseInvoice, PURCHASE_LOCAL_KEY,
} from "./purchaseStore.js";

// In-memory storage shim so the store is testable without a browser.
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => m,
  };
}

let storage, cloudCalls;
beforeEach(() => {
  storage = memStorage();
  cloudCalls = { persist: [], remove: [] };
  initPurchaseStore({
    storage,
    cloud: {
      persist: (inv, list) => cloudCalls.persist.push({ inv, list }),
      remove: (id, list) => cloudCalls.remove.push({ id, list }),
    },
  });
});

test("save computes totals, assigns id/timestamps, prepends newest-first", () => {
  const a = savePurchaseInvoice({
    supplierName: "A", supplierInvoiceNo: "1", invoiceDate: "2026-11-01",
    lines: [{ qty: 2, unitCost: 10 }],
  });
  assert.ok(a.id.startsWith("PINV-"));
  assert.ok(a.createdAt && a.updatedAt);
  assert.equal(a.subtotal, 20);
  assert.equal(a.vatAmount, 3);
  assert.equal(a.total, 23);

  const b = savePurchaseInvoice({
    supplierName: "B", supplierInvoiceNo: "2", invoiceDate: "2026-11-02",
    lines: [{ qty: 1, unitCost: 5 }],
  });
  const list = loadPurchaseInvoices();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id); // newest first
});

test("save with an existing id upserts (edits in place), does not duplicate", () => {
  const a = savePurchaseInvoice({
    supplierName: "A", supplierInvoiceNo: "1", invoiceDate: "2026-11-01",
    lines: [{ qty: 1, unitCost: 10 }],
  });
  const edited = savePurchaseInvoice({
    ...a, lines: [{ qty: 3, unitCost: 10 }],
  });
  const list = loadPurchaseInvoices();
  assert.equal(list.length, 1);
  assert.equal(edited.id, a.id);
  assert.equal(list[0].total, 34.5); // 30 net + 4.5 vat
  assert.equal(list[0].createdAt, a.createdAt); // createdAt preserved on edit
});

test("delete removes by id and returns the remaining list", () => {
  const a = savePurchaseInvoice({ supplierName: "A", supplierInvoiceNo: "1", invoiceDate: "2026-11-01", lines: [{ qty: 1, unitCost: 1 }] });
  savePurchaseInvoice({ supplierName: "B", supplierInvoiceNo: "2", invoiceDate: "2026-11-02", lines: [{ qty: 1, unitCost: 1 }] });
  const remaining = deletePurchaseInvoice(a.id);
  assert.equal(remaining.length, 1);
  assert.equal(loadPurchaseInvoices().length, 1);
  assert.ok(!loadPurchaseInvoices().some((x) => x.id === a.id));
});

test("cloud adapter is notified on save and delete", () => {
  const a = savePurchaseInvoice({ supplierName: "A", supplierInvoiceNo: "1", invoiceDate: "2026-11-01", lines: [{ qty: 1, unitCost: 1 }] });
  assert.equal(cloudCalls.persist.length, 1);
  assert.equal(cloudCalls.persist[0].inv.id, a.id);
  deletePurchaseInvoice(a.id);
  assert.equal(cloudCalls.remove.length, 1);
  assert.equal(cloudCalls.remove[0].id, a.id);
});

test("no cloud adapter → local still works (no throw)", () => {
  initPurchaseStore({ storage, cloud: null });
  const a = savePurchaseInvoice({ supplierName: "A", supplierInvoiceNo: "1", invoiceDate: "2026-11-01", lines: [{ qty: 1, unitCost: 2 }] });
  assert.equal(loadPurchaseInvoices().length, 1);
  assert.equal(a.total, 2.3);
});

test("data lands under the dedicated local key (never a SYNC_KEY blob)", () => {
  savePurchaseInvoice({ supplierName: "A", supplierInvoiceNo: "1", invoiceDate: "2026-11-01", lines: [{ qty: 1, unitCost: 1 }] });
  assert.ok(storage.getItem(PURCHASE_LOCAL_KEY));
  assert.equal(PURCHASE_LOCAL_KEY, "restopos_purchase_invoices");
});


test("purchase revision increments on save, delete, and cloud hydration", () => {
  const before = getPurchaseRevision();
  const a = savePurchaseInvoice({ supplierName: "A", supplierInvoiceNo: "1", invoiceDate: "2026-11-01", lines: [{ qty: 1, unitCost: 1 }] });
  assert.equal(getPurchaseRevision(), before + 1);
  setPurchaseInvoicesLocal([a]);
  assert.equal(getPurchaseRevision(), before + 2);
  deletePurchaseInvoice(a.id);
  assert.equal(getPurchaseRevision(), before + 3);
});
