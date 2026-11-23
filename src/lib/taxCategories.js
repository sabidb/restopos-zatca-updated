// ═══════════════════════════════════════════════════════════════════
// TAX CATEGORIES — per-product VAT treatment for KSA: Standard (15%),
// Zero-rated (0%, input VAT still recoverable), Exempt (0%, input VAT NOT
// recoverable). Default is Standard, so a product with no category set behaves
// exactly as today.
//
// BEHAVIOUR-PRESERVING CART VAT: cartVat sums the STANDARD-rated line grosses
// and takes VAT once on that sum — bit-identical to the existing
// `vatFromInclusive(totalOfAllLines)` whenever every line is standard (the only
// case that exists before this feature). Zero-rated / exempt lines contribute
// 0 VAT. So an all-standard cart's figure never moves; only a cart that
// actually contains Z/E items differs, and then correctly.
//
// This file is the SAFE core (math + classification). The ZATCA invoice-XML
// codes (S/Z/E + exemption reason) are generated elsewhere, behind a default-off
// flag, pending ZATCA-simulation validation.
//
// Pure + testable: no React, no Firestore.
// ═══════════════════════════════════════════════════════════════════
import { vatFromInclusive, vatFromInclusiveRaw, VAT_RATE } from "./tax.js";

export const TAX_CATEGORIES = {
  S: { code: "S", label: "Standard (15%)", labelAr: "أساسي ١٥٪", rate: 0.15, recoverable: true },
  Z: { code: "Z", label: "Zero-rated (0%)", labelAr: "صفري ٠٪", rate: 0, recoverable: true },
  E: { code: "E", label: "Exempt", labelAr: "معفى", rate: 0, recoverable: false },
};
export const TAX_CATEGORY_CODES = ["S", "Z", "E"];

/** Normalise to a known code; anything unset/unknown is Standard (today's behaviour). */
export function normTaxCategory(v) { return (v === "Z" || v === "E") ? v : "S"; }
export function rateForCategory(cat) { return TAX_CATEGORIES[normTaxCategory(cat)].rate; }

/** A product's tax category / VAT rate (default Standard). */
export function productTaxCategory(item) { return normTaxCategory(item && item.taxCategory); }
export function productVatRate(item) { return rateForCategory(productTaxCategory(item)); }

/** The inclusive gross of a cart line (price × qty). */
function lineGross(l) { return (Number(l.price) || 0) * (Number(l.qty) || 0); }

/**
 * Cart VAT respecting per-line tax category, without changing standard-cart math.
 * @returns { vat, standardGross, byCategory:{S,Z,E} }  (byCategory = inclusive gross per category)
 */
export function cartVat(lines = []) {
  const byCategory = { S: 0, Z: 0, E: 0 };
  let standardGross = 0;
  for (const l of lines || []) {
    const cat = productTaxCategory(l);
    const g = lineGross(l);
    byCategory[cat] += g;
    if (cat === "S") standardGross += g;
  }
  return { vat: vatFromInclusive(standardGross), standardGross, byCategory };
}

/**
 * Whether a set of cart lines contains any non-standard (Z/E) item. The POS can
 * use this to keep the untouched fast path for all-standard carts.
 */
export function hasNonStandard(lines = []) {
  return (lines || []).some((l) => productTaxCategory(l) !== "S");
}

/**
 * Per-category taxable/VAT breakdown for an invoice's lines — the data a ZATCA
 * multi-category TaxTotal needs. Unrounded VAT per category (caller rounds the
 * total the ZATCA way). Standard uses the inclusive factor; Z/E are 0.
 * @returns [{ code, rate, taxableGross, vat }]  (only categories present)
 */
export function taxSubtotals(lines = []) {
  const grossByCat = { S: 0, Z: 0, E: 0 };
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
