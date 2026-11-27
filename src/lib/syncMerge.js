// ═══════════════════════════════════════════════════════════════════
// SYNC MERGE — union two devices' record lists without losing anything.
//
// The cloud backup keeps one JSON blob per key in client_data/{licenseKey}.
// The old restore rule for arrays was "whichever list is LONGER wins, replace
// the other" — which silently DESTROYS records: if till A rang sales [1,2,3]
// and the cloud (from till B) holds [4,5,6,7], A's restore replaced its three
// sales with B's four and A's sales were gone. That is the "sync doesn't work
// between devices" symptom: records don't accumulate, they overwrite.
//
// This module merges by `id` instead, so every device ends up with the UNION
// of all records. On a genuine conflict (same id on both sides) the newer one
// wins, judged by updatedAt / createdAt / date. Pure + testable: no DOM, no
// Firestore.
// ═══════════════════════════════════════════════════════════════════

// Keys whose value is an array of records keyed by `id` — these get unioned.
// Everything else (config objects, small scalars) keeps newer-wins behaviour.
export const RECORD_ARRAY_KEYS = new Set([
  "restopos_sales",
  "restopos_customers",
  "restopos_stock_movements",
  "restopos_suppliers",
  "restopos_draft_invoices",
  "restopos_saved_invoices",
  "restopos_quotations",
  "restopos_gift_cards",
  "restopos_expenses",
]);

/** True for the record-array keys above, plus monthly sales buckets. */
export function isRecordArrayKey(key) {
  return RECORD_ARRAY_KEYS.has(key) || /^restopos_sales_\d{4}-\d{2}$/.test(String(key || ""));
}

function recTime(r) {
  const t = Date.parse(r?.syncUpdatedAt || r?.lastModifiedAt || r?.modifiedAt || r?.updatedAt || r?.createdAt || (r?.date ? r.date + " " + (r.time || "") : "") || "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * Union two record arrays by `id`. Records present on only one side are kept;
 * records on both sides collapse to the newer one (updatedAt/createdAt/date).
 * Records with no usable id are all kept (never dropped), so nothing is lost.
 * @returns {Array} merged list
 */
export function mergeRecordsById(localArr, cloudArr) {
  const local = Array.isArray(localArr) ? localArr : [];
  const cloud = Array.isArray(cloudArr) ? cloudArr : [];
  const byId = new Map();
  const loose = []; // records without an id — kept verbatim, de-duped by JSON
  const looseSeen = new Set();

  const take = (r) => {
    if (r && r.id != null && r.id !== "") {
      const k = String(r.id);
      const prev = byId.get(k);
      // Preserve local on timestamp ties: a cloud copy with no reliable edit timestamp
      // must not overwrite a local edit merely because it was processed second.
      if (!prev || recTime(r) > recTime(prev)) byId.set(k, r);
    } else {
      let s; try { s = JSON.stringify(r); } catch (_) { s = null; }
      if (s == null || !looseSeen.has(s)) { looseSeen.add(s); loose.push(r); }
    }
  };
  // Seed with local first so a tie keeps local order; cloud fills gaps / wins newer.
  for (const r of local) take(r);
  for (const r of cloud) take(r);
  return [...byId.values(), ...loose];
}

/**
 * Decide the value to keep for one key when restoring from cloud.
 * - record-array keys  → union by id (never lose a record)
 * - everything else    → the cloud value only when it is strictly newer
 *                        (localUpdatedAt / cloudUpdatedAt are ISO strings or null)
 * Returns { value, changed } where value is the parsed JS value to store, or
 * null when nothing should change locally.
 */
export function resolveKeyOnRestore(key, localParsed, cloudParsed, localUpdatedAt, cloudUpdatedAt) {
  if (isRecordArrayKey(key)) {
    const merged = mergeRecordsById(localParsed, cloudParsed);
    const before = Array.isArray(localParsed) ? localParsed.length : -1;
    return { value: merged, changed: merged.length !== before };
  }
  // Non-record key: prefer cloud only if it is newer than local.
  if (localParsed == null) return { value: cloudParsed, changed: cloudParsed != null };
  const lt = Date.parse(localUpdatedAt || "") || 0;
  const ct = Date.parse(cloudUpdatedAt || "") || 0;
  if (ct > lt) return { value: cloudParsed, changed: true };
  return { value: localParsed, changed: false };
}
