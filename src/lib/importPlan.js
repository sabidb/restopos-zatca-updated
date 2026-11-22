// ═══════════════════════════════════════════════════════════════════
// IMPORT PLAN — decide create / update / skip for a product import, and make
// re-running an import idempotent (no duplicate products on a second run).
//
// Matching: by barcode first (any of a product's barcodes), else by
// name + category (case-insensitive, trimmed). A row that matches an existing
// product is UPDATED only when the caller opts in; otherwise it is skipped, so
// the default behaviour is safe and repeatable. Rows that repeat an earlier row
// in the same file are flagged as in-file duplicates and skipped.
//
// Pure + testable: no React, no Firestore. The UI renders the summary and the
// apply step turns create/update entries into catalogue writes (never touching
// stock — opening stock is a separate workflow).
// ═══════════════════════════════════════════════════════════════════
import { normCode, productBarcodes } from "./barcode.js";

const nameKey = (name, category) =>
  `${String(name ?? "").trim().toLowerCase()}|${String(category ?? "").trim().toLowerCase()}`;

/**
 * @param rows parsed import rows (objects with name/price/category/barcode/…)
 * @param existingItems current catalogue
 * @param opts.updateExisting when true, matched rows become updates; else skipped
 * @returns { create[], update[], skip[], summary } — entries carry { row, index, existing?, reason }
 */
export function classifyImport(rows = [], existingItems = [], opts = {}) {
  const updateExisting = !!opts.updateExisting;

  const byBarcode = new Map();
  const byName = new Map();
  for (const it of existingItems || []) {
    for (const b of productBarcodes(it)) if (!byBarcode.has(b)) byBarcode.set(b, it);
    const nk = nameKey(it.name, it.category);
    if (!byName.has(nk)) byName.set(nk, it);
  }

  const seenBarcode = new Set();
  const seenName = new Set();
  const create = [], update = [], skip = [];

  (rows || []).forEach((row, index) => {
    const bc = normCode(row.barcode);
    const nk = nameKey(row.name, row.category);

    // 1) duplicate of an earlier row in this same file? Dedup by barcode when the
    //    row has one, otherwise by name+category.
    const dupInFile = bc ? seenBarcode.has(bc) : seenName.has(nk);
    if (dupInFile) { skip.push({ row, index, reason: "duplicate-in-file" }); return; }
    if (bc) seenBarcode.add(bc); else seenName.add(nk);

    // 2) matches a product already in the catalogue? Barcode wins; else name+category.
    const match = (bc ? byBarcode.get(bc) : null) || byName.get(nk) || null;
    if (match) {
      if (updateExisting) update.push({ row, index, existing: match, reason: "update-existing" });
      else skip.push({ row, index, existing: match, reason: "exists-skipped" });
    } else {
      create.push({ row, index, reason: "new" });
    }
  });

  return {
    create, update, skip,
    summary: {
      total: (rows || []).length,
      create: create.length,
      update: update.length,
      skip: skip.length,
      duplicateInFile: skip.filter((s) => s.reason === "duplicate-in-file").length,
      existingSkipped: skip.filter((s) => s.reason === "exists-skipped").length,
    },
  };
}

/**
 * Merge an import row onto an existing product for an UPDATE. Never changes
 * stock, id, or active, and a blank cell never erases an existing value.
 */
export function mergeUpdate(existing, row) {
  const num = (v, fallback) => {
    const s = String(v ?? "").trim();
    if (s === "") return fallback;
    const n = parseFloat(s);
    return Number.isNaN(n) ? fallback : n;
  };
  const str = (v, fallback) => {
    const s = String(v ?? "").trim();
    return s === "" ? fallback : s;
  };
  return {
    ...existing,
    name: str(row.name, existing.name),
    nameAr: str(row.namear ?? row.nameAr, existing.nameAr),
    category: str(row.category, existing.category),
    price: num(row.price, existing.price),
    cost: num(row.cost, existing.cost),
    barcode: str(row.barcode, existing.barcode),
    // deliberately NOT touched: stock, id, active, barcodes
  };
}
