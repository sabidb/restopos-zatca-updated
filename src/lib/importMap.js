// ═══════════════════════════════════════════════════════════════════
// IMPORT MAP — map arbitrary spreadsheet columns onto the product fields the
// catalogue understands, auto-suggesting a mapping from the header row and
// validating the mapped rows. Pure + testable; the UI drives it and the
// resulting row objects feed classifyImport()/mergeUpdate() unchanged.
// ═══════════════════════════════════════════════════════════════════

/** Target product fields and the header names we auto-match them to. */
export const IMPORT_FIELDS = [
  { key: "name",     label: "Product name (English)", required: true,  aliases: ["name", "product", "item", "english name", "name en", "product name", "item name", "description"] },
  { key: "nameAr",   label: "Arabic name",            required: false, aliases: ["namear", "name ar", "arabic", "arabic name", "name arabic", "الاسم", "اسم", "الاسم بالعربي"] },
  { key: "category", label: "Category",               required: false, aliases: ["category", "cat", "group", "department", "dept", "type"] },
  { key: "price",    label: "Selling price",          required: true,  aliases: ["price", "sell price", "selling price", "sale price", "retail", "retail price", "mrp", "unit price"] },
  { key: "cost",     label: "Cost",                   required: false, aliases: ["cost", "purchase price", "buy price", "cost price", "buying price", "wholesale"] },
  { key: "barcode",  label: "Barcode",                required: false, aliases: ["barcode", "bar code", "ean", "ean13", "upc", "sku", "code", "item code"] },
];

export const norm = (s) =>
  String(s ?? "").trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");

/**
 * Suggest a mapping from a header row: field key -> column index (or -1 if no
 * match). Prefers an exact alias match, then a contains-match.
 */
export function suggestMapping(headers = []) {
  const nh = headers.map(norm);
  const used = new Set();
  const mapping = {};
  const pick = (test) => {
    for (let i = 0; i < nh.length; i++) if (!used.has(i) && test(nh[i])) return i;
    return -1;
  };
  for (const f of IMPORT_FIELDS) {
    let idx = pick((h) => f.aliases.includes(h));
    if (idx < 0) idx = pick((h) => h !== "" && f.aliases.some((a) => h.includes(a) || a.includes(h)));
    if (idx >= 0) used.add(idx);
    mapping[f.key] = idx;
  }
  return mapping;
}

/** Turn raw data rows (arrays of cells) into product-field objects via the mapping. */
export function applyMapping(dataRows = [], mapping = {}) {
  return dataRows.map((cells) => {
    const obj = {};
    for (const f of IMPORT_FIELDS) {
      const ci = mapping[f.key];
      obj[f.key] = ci != null && ci >= 0 ? String(cells[ci] ?? "").trim() : "";
    }
    return obj;
  });
}

/** True when every required field has a column mapped. */
export function mappingComplete(mapping = {}) {
  return IMPORT_FIELDS.filter((f) => f.required).every((f) => mapping[f.key] != null && mapping[f.key] >= 0);
}

/** Validate mapped rows. Returns { valid:[], errors:[{index,row,messages[]}] }. */
export function validateRows(rows = []) {
  const valid = [];
  const errors = [];
  rows.forEach((r, index) => {
    const messages = [];
    if (!String(r.name ?? "").trim()) messages.push("Missing name");
    const p = String(r.price ?? "").trim();
    if (!p) messages.push("Missing price");
    else if (Number.isNaN(parseFloat(p))) messages.push(`Invalid price "${p}"`);
    const c = String(r.cost ?? "").trim();
    if (c !== "" && Number.isNaN(parseFloat(c))) messages.push(`Invalid cost "${c}"`);
    if (messages.length) errors.push({ index, row: r, messages });
    else valid.push(r);
  });
  return { valid, errors };
}
