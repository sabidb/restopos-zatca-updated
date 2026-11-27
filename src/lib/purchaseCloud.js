// ═══════════════════════════════════════════════════════════════════
// PURCHASE CLOUD — Firestore subcollection persistence for purchase documents
// and purchase orders. These records grow without bound, so they must NOT live
// on the single client_data/{licenseKey} document (the 350 KB-per-key / 1 MiB
// trap that sync.js guards against). One document per record, in a subcollection
// — the same shape cloudArchive.js uses for sales:
//
//   client_data/{licenseKey}
//     ├── purchase_docs/{id}      one invoice / credit note per document
//     └── purchase_orders/{id}    one PO per document
//
// This module is the adapter that plugs into the purchaseStore / poStore cloud
// seam (initPurchaseStore({cloud}) / initPOStore({cloud})). Firestore handles
// are injected via initPurchaseCloud (same pattern as initCloudArchive), so the
// module has no direct Firebase import and is unit-testable with mock handles.
// Everything is best-effort: a cloud failure must never break local capture.
// ═══════════════════════════════════════════════════════════════════

export const PURCHASE_DOCS_COLL = "purchase_docs";
export const PURCHASE_ORDERS_COLL = "purchase_orders";

let fb = null;          // { db, doc, setDoc, deleteDoc, collection, getDocs }
let _licenseKey = null;

/** Inject the app's Firestore handles (one Firebase app / auth session). */
export function initPurchaseCloud(deps) { fb = deps; }
/** Set/clear the active client. Writes/reads are no-ops until a key is set. */
export function setPurchaseCloudLicense(key) { _licenseKey = key || null; }

function ready() { return !!(fb && _licenseKey); }

// Returns true on a confirmed cloud write, false otherwise (not ready, bad
// input, or a failed write). The caller uses this to track per-record sync
// state and retry — a cloud failure must never break local capture, but it must
// no longer be swallowed and forgotten (AUD-03).
async function persistOne(coll, item) {
  if (!ready() || !item || item.id == null) return false;
  try {
    await fb.setDoc(fb.doc(fb.db, "client_data", _licenseKey, coll, String(item.id)), item);
    return true;
  } catch (e) { console.error("[PurchaseCloud] persist", coll, "failed:", e.message); return false; }
}
async function removeOne(coll, id) {
  if (!ready() || id == null) return false;
  try {
    await fb.deleteDoc(fb.doc(fb.db, "client_data", _licenseKey, coll, String(id)));
    return true;
  } catch (e) { console.error("[PurchaseCloud] delete", coll, "failed:", e.message); return false; }
}
async function loadColl(coll) {
  if (!ready()) return [];
  try {
    const snap = await fb.getDocs(fb.collection(fb.db, "client_data", _licenseKey, coll));
    const out = [];
    snap.forEach((d) => out.push(d.data()));
    return out;
  } catch (e) { console.error("[PurchaseCloud] load", coll, "failed:", e.message); return []; }
}

// Adapters to inject into the local stores' cloud seam.
export const purchaseDocsCloud = {
  persist: (doc) => persistOne(PURCHASE_DOCS_COLL, doc),
  remove: (id) => removeOne(PURCHASE_DOCS_COLL, id),
  loadAll: () => loadColl(PURCHASE_DOCS_COLL),
};
export const purchaseOrdersCloud = {
  persist: (po) => persistOne(PURCHASE_ORDERS_COLL, po),
  remove: (id) => removeOne(PURCHASE_ORDERS_COLL, id),
  loadAll: () => loadColl(PURCHASE_ORDERS_COLL),
};

/**
 * Merge two lists of records by id, keeping the most-recently-updated version
 * of each (updatedAt, else createdAt). Pure — used to reconcile cloud + local
 * during hydration so neither device nor cloud silently wins.
 */
export function mergeById(a = [], b = []) {
  const map = new Map();
  const stamp = (x) => x.updatedAt || x.createdAt || "";
  for (const x of [...(a || []), ...(b || [])]) {
    if (!x || x.id == null) continue;
    const cur = map.get(x.id);
    if (!cur || stamp(x) >= stamp(cur)) map.set(x.id, x);
  }
  // newest-first by stamp for stable display
  return [...map.values()].sort((x, y) => (stamp(y)).localeCompare(stamp(x)));
}
