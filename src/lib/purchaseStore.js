// ═══════════════════════════════════════════════════════════════════
// PURCHASE INVOICE STORE — local-first persistence with an injected cloud seam.
//
// WHY A SEAM: purchase invoices are financial records that grow without bound
// (a busy supermarket enters ~50/week ≈ 4 MB/year). They therefore must NOT be
// added to SYNC_KEYS — a single oversized key blows the 350 KB per-key guard in
// sync.js and takes down the backup of every OTHER key with it (the exact bug
// already fixed for sales and closed_days, which moved to Firestore
// subcollections). So this store keeps invoices in localStorage only, behind a
// single injected cloud adapter. PR#2 injects a Firestore subcollection adapter
// here (one document per invoice) — a drop-in, with no change to callers and no
// new SYNC_KEY.
//
// storage and cloud are both injectable so the store is unit-testable without a
// browser or Firebase (see purchaseStore.test.mjs).
// ═══════════════════════════════════════════════════════════════════
import { computePurchaseInvoice } from "./purchases.js";

export const PURCHASE_LOCAL_KEY = "restopos_purchase_invoices";

let _storage = (typeof localStorage !== "undefined") ? localStorage : null;
let _cloud = null; // PR#2: { persist(invoice, list), remove(id, list) } → subcollection

/**
 * Inject a storage backend and/or a cloud adapter. Pass nothing in production
 * (uses window.localStorage and no cloud); tests pass an in-memory shim.
 */
export function initPurchaseStore({ storage, cloud } = {}) {
  if (storage !== undefined) _storage = storage;
  if (cloud !== undefined) _cloud = cloud;
}

function _read() {
  try { return JSON.parse(_storage.getItem(PURCHASE_LOCAL_KEY)) || []; }
  catch { return []; }
}
function _writeLocal(list) {
  try { _storage.setItem(PURCHASE_LOCAL_KEY, JSON.stringify(list)); }
  catch (e) { /* storage full / unavailable — local write is best-effort */ }
}

/** All captured purchase invoices, newest first. */
export function loadPurchaseInvoices() { return _read(); }

/**
 * Replace the local list WITHOUT pushing to the cloud — used to hydrate the
 * device from the Firestore subcollection on login (pushing back would loop).
 */
export function setPurchaseInvoicesLocal(list) {
  _writeLocal(Array.isArray(list) ? list : []);
  return _read();
}

// Unique even for two invoices saved in the same millisecond (a plain Date.now()
// collides, and the second would silently upsert the first).
export function newInvoiceId() {
  return "PINV-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

/**
 * Persist a NEW or EDITED purchase invoice: compute its totals, assign an id and
 * timestamps when new, upsert into the local list (newest first), then notify
 * the cloud adapter if one is injected. Returns the stored (computed) invoice.
 * The caller is responsible for validation and duplicate checks (see purchases.js).
 */
export function savePurchaseInvoice(inv) {
  const computed = computePurchaseInvoice(inv);
  const now = new Date().toISOString();
  const stored = {
    ...computed,
    id: inv.id || newInvoiceId(),
    createdAt: inv.createdAt || now,
    updatedAt: now,
  };
  const list = _read();
  const exists = list.some((x) => x.id === stored.id);
  const next = exists
    ? list.map((x) => (x.id === stored.id ? stored : x))
    : [stored, ...list];
  _writeLocal(next);
  if (_cloud && typeof _cloud.persist === "function") {
    try { _cloud.persist(stored, next); } catch (e) { /* cloud is best-effort */ }
  }
  return stored;
}

/** Delete a purchase invoice by id. Returns the remaining list. */
export function deletePurchaseInvoice(id) {
  const next = _read().filter((x) => x.id !== id);
  _writeLocal(next);
  if (_cloud && typeof _cloud.remove === "function") {
    try { _cloud.remove(id, next); } catch (e) { /* cloud is best-effort */ }
  }
  return next;
}
