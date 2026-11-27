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
let _cloud = null; // { persist(invoice, list), remove(id, list) } → subcollection
let _purchaseRevision = 0;

/** Revision of the local purchase-document collection. */
export function getPurchaseRevision() { return _purchaseRevision; }

/** Subscribe to purchase-document mutations; returns an unsubscribe function. */
export function subscribePurchaseChanges(listener) {
  if (typeof window === "undefined" || !window.addEventListener) return () => {};
  window.addEventListener("restopos-purchase-docs-change", listener);
  return () => window.removeEventListener("restopos-purchase-docs-change", listener);
}

/** Notify mounted reports/VAT screens after purchase-document mutations. */
function _emitPurchaseChange(action) {
  _purchaseRevision += 1;
  try {
    if (typeof window !== "undefined" && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent("restopos-purchase-docs-change", {
        detail: { revision: _purchaseRevision, action }
      }));
    }
  } catch (e) { /* non-browser or event unsupported */ }
}

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
  _emitPurchaseChange("hydrate");
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
    // Sync state travels WITH the record so a failed cloud write is durable and
    // visible, not swallowed (AUD-03). "pending" until the cloud confirms;
    // "synced" once it does; "failed" if the write errored (retried later).
    // With no cloud adapter the record is purely local — not counted as unsynced.
    syncStatus: (_cloud && typeof _cloud.persist === "function") ? "pending" : "local",
    syncError: null,
  };
  const list = _read();
  const exists = list.some((x) => x.id === stored.id);
  const next = exists
    ? list.map((x) => (x.id === stored.id ? stored : x))
    : [stored, ...list];
  _writeLocal(next);
  _emitPurchaseChange(exists ? "update" : "create");
  // Invoke the cloud write synchronously (so a caller/test sees it fire), but
  // record its OUTCOME asynchronously so the record ends up "synced" or "failed"
  // rather than optimistically assumed-saved.
  if (_cloud && typeof _cloud.persist === "function") {
    try {
      Promise.resolve(_cloud.persist(stored, next))
        .then((ok) => _applySyncResult(stored.id, ok !== false))
        .catch(() => _applySyncResult(stored.id, false));
    } catch (e) { _applySyncResult(stored.id, false); }
  }
  return stored;
}

// Records whose input VAT / supplier bill has not been confirmed saved to the
// cloud — the ones at risk of loss if this device is cleared.
export function pendingSyncIds(list = _read()) {
  return (list || [])
    .filter((x) => x && (x.syncStatus === "pending" || x.syncStatus === "failed"))
    .map((x) => x.id);
}

/** How many captured purchases are not yet confirmed in the cloud. */
export function unsyncedPurchaseCount() { return pendingSyncIds().length; }

// Stamp one record's sync outcome and persist locally. Re-reads around the
// write so a concurrent save during an await is not clobbered.
function _applySyncResult(id, ok) {
  const cur = _read();
  const i = cur.findIndex((x) => x && x.id === id);
  if (i < 0) return;
  cur[i] = {
    ...cur[i],
    syncStatus: ok ? "synced" : "failed",
    syncError: ok ? null : "cloud write failed",
    lastSyncAttempt: new Date().toISOString(),
  };
  _writeLocal(cur);
  _emitSync();
}

function _emitSync() {
  try {
    if (typeof window !== "undefined" && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent("restopos-purchase-sync", { detail: { pending: pendingSyncIds().length } }));
    }
  } catch (e) { /* non-browser or event unsupported */ }
}

/**
 * Retry every purchase not yet confirmed in the cloud (pending or failed).
 * Idempotent and safe to call on reconnect, after hydration, or on a timer.
 * Returns a summary. A no-op (noCloud) when no cloud adapter is configured.
 */
export async function flushPurchaseSync() {
  if (!_cloud || typeof _cloud.persist !== "function") {
    return { noCloud: true, synced: 0, failed: 0, pending: 0 };
  }
  let synced = 0, failed = 0;
  for (const id of pendingSyncIds()) {
    const cur = _read();
    const rec = cur.find((x) => x && x.id === id);
    if (!rec) continue;
    let ok = false;
    try { ok = (await Promise.resolve(_cloud.persist(rec, cur))) !== false; } catch (e) { ok = false; }
    _applySyncResult(id, ok);
    ok ? synced++ : failed++;
  }
  return { synced, failed, pending: pendingSyncIds().length };
}

/** Delete a purchase invoice by id. Returns the remaining list. */
export function deletePurchaseInvoice(id) {
  const next = _read().filter((x) => x.id !== id);
  _writeLocal(next);
  _emitPurchaseChange("delete");
  if (_cloud && typeof _cloud.remove === "function") {
    try { _cloud.remove(id, next); } catch (e) { /* cloud is best-effort */ }
  }
  return next;
}
