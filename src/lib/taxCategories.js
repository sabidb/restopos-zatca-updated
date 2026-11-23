// ═══════════════════════════════════════════════════════════════════
// TAX CATEGORIES — per-product VAT treatment for KSA ZATCA e-invoicing.
// Category codes follow ZATCA / EN-16931 (BR-KSA-18): S, Z, E, O.
//   S = Standard rate (15%)
//   Z = Zero-rated (0%, input VAT still recoverable)         → needs a reason code
//   E = Exempt (0%, input VAT NOT recoverable)               → needs a reason code
//   O = Not subject to / outside the scope of VAT            → needs a reason code
// Default is Standard, so a product with no category set behaves exactly as today.
//
// EXEMPTION REASON CODES (VATEX-SA-*) below are compiled from ZATCA-aligned
// public references (the ZATCA XML Implementation Standard code-list annex).
// ⚠️ The exact current list and official reason TEXT must be confirmed against
// ZATCA's live standard, and every Z/E/O invoice must pass ZATCA's simulation
// before production. ZATCA rules: a Standard (S) tax breakdown must NOT carry an
// exemption reason; Z/E/O breakdowns MUST carry one (code + text); O uses
// VATEX-SA-OOS with free text (BR-KSA-23 / BR-KSA-CL-04).
//
// BEHAVIOUR-PRESERVING: for an all-Standard cart/invoice (the only case unless a
// product is tagged Z/E/O) cartVat == vatFromInclusive(total) and the tax
// breakdown is a single S subtotal — bit-identical to before this feature.
//
// Pure + testable: no React, no Firestore.
// ═══════════════════════════════════════════════════════════════════
import { vatFromInclusive, vatFromInclusiveRaw, VAT_RATE } from "./tax.js";

export const TAX_CATEGORIES = {
  S: { code: "S", label: "Standard (15%)", labelAr: "أساسي ١٥٪", rate: 0.15, recoverable: true, needsReason: false },
  Z: { code: "Z", label: "Zero-rated (0%)", labelAr: "صفري ٠٪", rate: 0, recoverable: true, needsReason: true },
  E: { code: "E", label: "Exempt", labelAr: "معفى", rate: 0, recoverable: false, needsReason: true },
  O: { code: "O", label: "Out of scope", labelAr: "خارج النطاق", rate: 0, recoverable: false, needsReason: true },
};
export const TAX_CATEGORY_CODES = ["S", "Z", "E", "O"];

// ZATCA VAT exemption reason codes, by category. Verify against ZATCA's live
// code list before production use.
export const EXEMPTION_REASONS = [
  // Zero-rated (Z)
  { code: "VATEX-SA-32", category: "Z", text: "Export of goods" },
  { code: "VATEX-SA-33", category: "Z", text: "Export of services" },
  { code: "VATEX-SA-34-1", category: "Z", text: "The international transport of Goods" },
  { code: "VATEX-SA-34-2", category: "Z", text: "International transport of passengers" },
  { code: "VATEX-SA-34-3", category: "Z", text: "Services directly connected and incidental to a Supply of international passenger transport" },
  { code: "VATEX-SA-34-4", category: "Z", text: "Supply of a qualifying means of transport" },
  { code: "VATEX-SA-34-5", category: "Z", text: "Any services relating to Goods or passenger transportation, as defined in article twenty five of the VAT Regulations" },
  { code: "VATEX-SA-35", category: "Z", text: "Medicines and medical equipment" },
  { code: "VATEX-SA-36", category: "Z", text: "Qualifying metals" },
  { code: "VATEX-SA-EDU", category: "Z", text: "Private education to citizen" },
  { code: "VATEX-SA-HEA", category: "Z", text: "Private healthcare to citizen" },
  { code: "VATEX-SA-MLTRY", category: "Z", text: "Supply of qualified military goods" },
  // Exempt (E)
  { code: "VATEX-SA-29", category: "E", text: "Financial services mentioned in Article 29 of the VAT Regulations" },
  { code: "VATEX-SA-29-7", category: "E", text: "Life insurance services mentioned in Article 29 of the VAT Regulations" },
  { code: "VATEX-SA-30", category: "E", text: "Real estate transactions mentioned in Article 30 of the VAT Regulations" },
  // Out of scope (O) — free text reason
  { code: "VATEX-SA-OOS", category: "O", text: "" },
];

/** Normalise to a known category code; anything unset/unknown is Standard. */
export function normTaxCategory(v) { return (v === "Z" || v === "E" || v === "O") ? v : "S"; }
export function rateForCategory(cat) { return TAX_CATEGORIES[normTaxCategory(cat)].rate; }
export function categoryNeedsReason(cat) { return !!TAX_CATEGORIES[normTaxCategory(cat)].needsReason; }

/** Exemption reason codes valid for a category (empty for Standard). */
export function reasonsForCategory(cat) {
  const c = normTaxCategory(cat);
  return EXEMPTION_REASONS.filter((r) => r.category === c);
}
/** Official reason text for a VATEX-SA code (empty string if unknown/free-text). */
export function exemptionReasonText(code) {
  const r = EXEMPTION_REASONS.find((x) => x.code === code);
  return r ? r.text : "";
}

/** A product's tax category / VAT rate (default Standard). */
export function productTaxCategory(item) { return normTaxCategory(item && item.taxCategory); }
export function productVatRate(item) { return rateForCategory(productTaxCategory(item)); }

/** The inclusive gross of a cart line (price × qty). */
function lineGross(l) { return (Number(l.price) || 0) * (Number(l.qty) || 0); }

/**
 * Cart VAT respecting per-line tax category, without changing standard-cart math.
 * @returns { vat, standardGross, byCategory:{S,Z,E,O} }  (byCategory = inclusive gross per category)
 */
export function cartVat(lines = []) {
  const byCategory = { S: 0, Z: 0, E: 0, O: 0 };
  let standardGross = 0;
  for (const l of lines || []) {
    const cat = productTaxCategory(l);
    const g = lineGross(l);
    byCategory[cat] += g;
    if (cat === "S") standardGross += g;
  }
  return { vat: vatFromInclusive(standardGross), standardGross, byCategory };
}

/** Whether any line is non-Standard (Z/E/O) — lets the POS keep the fast path. */
export function hasNonStandard(lines = []) {
  return (lines || []).some((l) => productTaxCategory(l) !== "S");
}

/**
 * ZATCA tax breakdown: group invoice lines by (category, reason code) — a
 * distinct TaxSubtotal per group, as ZATCA expects (two exempt reasons → two
 * subtotals). Standard has no reason. Returns inclusive gross, ex-VAT taxable
 * and unrounded VAT per group (the caller rounds the ZATCA way).
 * @returns [{ code, rate, reasonCode, reasonText, gross, taxable, vat }]
 */
export function invoiceTaxGroups(lines = []) {
  const groups = new Map(); // key → accumulator
  for (const l of lines || []) {
    const code = productTaxCategory(l);
    const reasonCode = code === "S" ? "" : (l.taxExemptionReasonCode || "");
    const key = code + "|" + reasonCode;
    if (!groups.has(key)) groups.set(key, { code, reasonCode, gross: 0, order: groups.size });
    groups.get(key).gross += lineGross(l);
  }
  const out = [];
  for (const g of [...groups.values()].sort((a, b) => a.order - b.order)) {
    if (g.gross <= 0) continue;
    const rate = TAX_CATEGORIES[g.code].rate;
    const vat = rate ? vatFromInclusiveRaw(g.gross) : 0;
    const taxable = rate ? (g.gross - vat) : g.gross; // net; at 0% net == gross
    out.push({
      code: g.code, rate, reasonCode: g.reasonCode,
      reasonText: g.code === "S" ? "" : (exemptionReasonText(g.reasonCode) || ""),
      gross: g.gross, taxable, vat,
    });
  }
  return out;
}

/**
 * Back-compat: per-category breakdown (no reason grouping). Retained for callers
 * that only need category totals.
 * @returns [{ code, rate, taxableGross, vat }]
 */
export function taxSubtotals(lines = []) {
  const grossByCat = { S: 0, Z: 0, E: 0, O: 0 };
  for (const l of lines || []) grossByCat[productTaxCategory(l)] += lineGross(l);
  const out = [];
  for (const code of TAX_CATEGORY_CODES) {
    const gross = grossByCat[code];
    if (gross <= 0) continue;
    const rate = TAX_CATEGORIES[code].rate;
    out.push({ code, rate, taxableGross: gross, vat: rate ? vatFromInclusiveRaw(gross) : 0 });
  }
  return out;
}
