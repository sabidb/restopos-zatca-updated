// ═══════════════════════════════════════════════════════════════════
// TAX / VAT — single source of truth for KSA VAT math.
//
// Why this file exists: the VAT formula `amount * (15/115)` was copy-pasted
// inline in 8+ places in App.jsx, with TWO different rounding conventions
// (`parseFloat(x.toFixed(2))` on the live transaction path, and the half-up
// `zatcaRound` on the ZATCA reporting path). They can disagree on edge cases —
// the app already carried a documented 34.99-vs-35.00 bug from exactly that
// divergence (see the old comment in PaymentModal). Centralising the math here
// removes the duplication and makes the next step — per-product tax categories
// (zero-rated / exempt) for Supermarket Mode — a change in ONE place.
//
// IMPORTANT: this extraction is deliberately BEHAVIOUR-PRESERVING. Each helper
// reproduces the exact arithmetic of the site it replaced, so outputs are
// bit-identical to before (locked by tax.test.mjs). Converging the two rounding
// conventions into one would CHANGE reported tax figures, so it is intentionally
// NOT done here — that is a separate decision that needs accountant/owner
// sign-off, not a silent refactor.
// ═══════════════════════════════════════════════════════════════════

/** Standard KSA VAT rate (since 1 Jul 2020). */
export const VAT_RATE = 0.15;
export const VAT_RATE_PCT = 15;

// The inclusive-extraction factor, written exactly as the old inline code did
// (`15 / 115`) so floating-point results are identical to the originals.
export const VAT_INCLUSIVE_FACTOR = 15 / 115;

/**
 * Transaction-path rounding: `parseFloat(x.toFixed(2))`.
 * This is what POS cart, PaymentModal, and invoice generation have always used.
 * Preserved verbatim for behaviour-equivalence.
 */
export const round2tx = (v) => parseFloat((Number(v) || 0).toFixed(2));

/**
 * ZATCA reporting-path rounding: explicit half-up `Math.floor(v*100 + 0.5)/100`.
 * This is the existing `zatcaRound`, moved here so there is one definition.
 */
export const zatcaRound = (v, dp = 2) => {
  const f = Math.pow(10, dp);
  return Math.floor((Number(v) || 0) * f + 0.5) / f;
};
export const zr2 = (v) => zatcaRound(v, 2);

/**
 * VAT portion of a VAT-INCLUSIVE amount, rounded the transaction way.
 * Replaces: `parseFloat((inclusive * (15/115)).toFixed(2))`.
 */
export const vatFromInclusive = (inclusive) =>
  round2tx((Number(inclusive) || 0) * VAT_INCLUSIVE_FACTOR);

/**
 * Net (ex-VAT) amount from a VAT-INCLUSIVE amount, rounded the transaction way.
 * Replaces: `parseFloat((inclusive - vat).toFixed(2))` where vat = vatFromInclusive.
 */
export const netFromInclusive = (inclusive) => {
  const inc = Number(inclusive) || 0;
  return round2tx(inc - vatFromInclusive(inc));
};

/**
 * UNROUNDED VAT portion of an inclusive amount — for accumulation sites that
 * sum many lines and round only the total (reports, aggregates).
 * Replaces inline `lineTotal * 15/115` with no per-line rounding.
 */
export const vatFromInclusiveRaw = (inclusive) =>
  (Number(inclusive) || 0) * VAT_INCLUSIVE_FACTOR;

/**
 * Split an inclusive total into { net, vat, total }, ZATCA-rounded.
 * Supports zero-rated / exempt via rate=0. This is the existing
 * `extractVATInclusive`, moved here; it is the seam the Supermarket per-product
 * tax-category work (Phase 2b) will build on.
 */
export const extractVATInclusive = (total, rate = VAT_RATE) => {
  const t = Number(total) || 0;
  if (rate === 0) return { net: zr2(t), vat: 0, total: zr2(t) };
  const net = zr2(t / (1 + rate));
  return { net, vat: zr2(t - net), total: zr2(t) };
};
