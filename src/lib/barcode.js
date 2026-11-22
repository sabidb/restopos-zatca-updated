// ═══════════════════════════════════════════════════════════════════
// BARCODE — product barcode matching for the scan till.
//
// A product has a primary `barcode` (string, as before) and MAY also carry
// `barcodes` (string[]) of additional codes — a supermarket item often has
// several (manufacturer EAN, a store-printed label, a case code…). This module
// is the single place that knows how to match a scanned code to a product, so
// the POS scan handler and the global scan popup stay in sync.
//
// Backward-compatible: products with only `barcode` work exactly as before;
// `barcodes` is optional and absent on restaurant items, which never scan.
// ═══════════════════════════════════════════════════════════════════

/** Normalise a scanned or typed code for comparison. */
export const normCode = (c) => String(c ?? "").trim();

/** All barcodes for a product: primary `barcode` first, then `barcodes[]`, de-duped. */
export function productBarcodes(item) {
  const list = [];
  const primary = normCode(item?.barcode);
  if (primary) list.push(primary);
  if (Array.isArray(item?.barcodes)) {
    for (const b of item.barcodes) {
      const n = normCode(b);
      if (n && !list.includes(n)) list.push(n);
    }
  }
  return list;
}

/** Does this product match a scanned code (any of its barcodes)? */
export function matchesBarcode(item, code) {
  const c = normCode(code);
  return c !== "" && productBarcodes(item).includes(c);
}

/**
 * Find the product in `items` whose barcode matches `code`, else null.
 * Returns the FIRST match (same behaviour as the old `items.find`); resolving
 * genuinely duplicate barcodes across products is a separate, larger feature.
 */
export function findByBarcode(items, code) {
  const c = normCode(code);
  if (c === "") return null;
  return (items || []).find((i) => matchesBarcode(i, c)) || null;
}

/** All products in `items` matching `code` — used to detect duplicate/ambiguous barcodes. */
export function findAllByBarcode(items, code) {
  const c = normCode(code);
  if (c === "") return [];
  return (items || []).filter((i) => matchesBarcode(i, c));
}

/**
 * Parse a user-entered multi-barcode string (comma / space / semicolon / newline
 * separated) into { primary, extra[] }. The first code becomes the primary
 * `barcode`; the rest go to `barcodes[]`. De-duped, order preserved.
 */
export function parseBarcodeInput(raw) {
  const codes = String(raw ?? "")
    .split(/[\s,;]+/)
    .map(normCode)
    .filter(Boolean);
  const unique = [...new Set(codes)];
  return { primary: unique[0] || "", extra: unique.slice(1) };
}
