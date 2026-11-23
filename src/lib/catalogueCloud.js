// ═══════════════════════════════════════════════════════════════════
// CATALOGUE CLOUD — move the product catalogue out of the single
// client_data/{licenseKey} document (one JSON blob synced via SYNC_KEYS, capped
// at 350 KB by sync.js → ~10k products can't fit) into a Firestore SUBCOLLECTION,
// one document per product:
//
//   client_data/{licenseKey}/catalogue/{itemId}
//
// Same injected-handles pattern as cloudArchive / purchaseCloud, so this module
// has no direct Firebase import and is unit-testable with mocks. Lookup over a
// large catalogue is an in-memory barcode index built once from loadAllItems
// (a per-scan Firestore query would be slow and costly), which is why there is
// no separate index document.
//
// This is R1: near-irreversible and touches every tenant, so the live read/write
// switch is gated default-off in the app and the production cutover (backfill +
// flip) is run by the operator, not here. Everything is best-effort.
// ═══════════════════════════════════════════════════════════════════
import { productBarcodes } from "./barcode.js";

export const CATALOGUE_COLL = "catalogue";
const BATCH_LIMIT = 400; // Firestore caps a batch at 500; leave headroom.

let fb = null;     // { db, doc, setDoc, deleteDoc, collection, getDocs, writeBatch }
let _lk = null;

export function initCatalogueCloud(deps) { fb = deps; }
export function setCatalogueLicense(key) { _lk = key || null; }
function ready() { return !!(fb && _lk); }

export async function persistItem(item) {
  if (!ready() || !item || item.id == null) return;
  try { await fb.setDoc(fb.doc(fb.db, "client_data", _lk, CATALOGUE_COLL, String(item.id)), item); }
  catch (e) { console.error("[Catalogue] persist failed:", e.message); }
}
export async function removeItem(id) {
  if (!ready() || id == null) return;
  try { await fb.deleteDoc(fb.doc(fb.db, "client_data", _lk, CATALOGUE_COLL, String(id))); }
  catch (e) { console.error("[Catalogue] remove failed:", e.message); }
}
export async function loadAllItems() {
  if (!ready()) return [];
  try {
    const snap = await fb.getDocs(fb.collection(fb.db, "client_data", _lk, CATALOGUE_COLL));
    const out = []; snap.forEach((d) => out.push(d.data())); return out;
  } catch (e) { console.error("[Catalogue] load failed:", e.message); return []; }
}

/**
 * One-time backfill: copy the existing in-blob catalogue into the subcollection,
 * in batches. Idempotent — each item is written by its id, so re-running is safe.
 * @returns { written, batches }
 */
export async function backfillCatalogue(items = []) {
  if (!ready()) return { written: 0, batches: 0 };
  const list = (items || []).filter((i) => i && i.id != null);
  let written = 0, batches = 0;
  for (let i = 0; i < list.length; i += BATCH_LIMIT) {
    const chunk = list.slice(i, i + BATCH_LIMIT);
    const batch = fb.writeBatch(fb.db);
    for (const it of chunk) batch.set(fb.doc(fb.db, "client_data", _lk, CATALOGUE_COLL, String(it.id)), it);
    await batch.commit(); // let a failure propagate so the cutover halts and is retried
    written += chunk.length; batches++;
  }
  return { written, batches };
}

/** Adapter for a store seam: persist/remove per item. */
export const catalogueCloud = {
  persist: (item) => persistItem(item),
  remove: (id) => removeItem(id),
  loadAll: () => loadAllItems(),
};

/** In-memory barcode → item index for fast scan lookup over a large catalogue. */
export function buildBarcodeIndex(items = []) {
  const m = new Map();
  for (const it of items || []) {
    for (const b of productBarcodes(it)) if (!m.has(b)) m.set(b, it);
  }
  return m;
}
