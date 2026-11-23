// ═══════════════════════════════════════════════════════════════════
// PURCHASE ORDER STORE — local-first, same injected-cloud-seam pattern as
// purchaseStore. POs are operational records that accumulate, so like purchase
// invoices they are NOT a SYNC_KEY (that would blow the 350 KB per-key budget);
// a Firestore subcollection adapter drops into the seam later.
// storage + cloud are injectable for tests.
// ═══════════════════════════════════════════════════════════════════
import { computePO } from "./purchaseOrders.js";

export const PO_LOCAL_KEY = "restopos_purchase_orders";

let _storage = (typeof localStorage !== "undefined") ? localStorage : null;
let _cloud = null;

export function initPOStore({ storage, cloud } = {}) {
  if (storage !== undefined) _storage = storage;
  if (cloud !== undefined) _cloud = cloud;
}

function _read() {
  try { return JSON.parse(_storage.getItem(PO_LOCAL_KEY)) || []; } catch { return []; }
}
function _writeLocal(list) {
  try { _storage.setItem(PO_LOCAL_KEY, JSON.stringify(list)); } catch (e) { /* best-effort */ }
}

export function loadPurchaseOrders() { return _read(); }

/** Replace the local list WITHOUT pushing to cloud — used for cloud hydration. */
export function setPurchaseOrdersLocal(list) {
  _writeLocal(Array.isArray(list) ? list : []);
  return _read();
}

export function newPOId() {
  return "PO-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

/** Create/edit a PO: compute it, assign id/timestamps when new, upsert, notify cloud. */
export function savePurchaseOrder(po) {
  const computed = computePO(po);
  const now = new Date().toISOString();
  const stored = { ...computed, id: po.id || newPOId(), createdAt: po.createdAt || now, updatedAt: now };
  const list = _read();
  const exists = list.some((x) => x.id === stored.id);
  const next = exists ? list.map((x) => (x.id === stored.id ? stored : x)) : [stored, ...list];
  _writeLocal(next);
  if (_cloud && typeof _cloud.persist === "function") { try { _cloud.persist(stored, next); } catch (e) {} }
  return stored;
}

export function deletePurchaseOrder(id) {
  const next = _read().filter((x) => x.id !== id);
  _writeLocal(next);
  if (_cloud && typeof _cloud.remove === "function") { try { _cloud.remove(id, next); } catch (e) {} }
  return next;
}
