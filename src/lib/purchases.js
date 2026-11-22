// ═══════════════════════════════════════════════════════════════════
// PURCHASES — supplier (purchase) invoice capture, totals, validation, and
// duplicate detection. Supermarket/Hypermarket "buy side" accounting.
//
// WHAT THIS IS (and is NOT):
//   A purchase invoice is a document a SUPPLIER issues TO the shop for goods
//   bought. It is an accounts-payable / input-VAT record. It is NOT a ZATCA
//   sales invoice and is NEVER signed or reported to ZATCA — the shop is the
//   buyer here, not the seller. (The supplier did their own ZATCA reporting.)
//   We only recover INPUT VAT from it, and only when the supplier issued a
//   valid ZATCA Phase-2 e-invoice (hasValidEInvoice flag; see App.jsx VAT tab).
//
// MONEY CONVENTION (deliberately different from the POS, flagged for review):
//   • The POS cart is VAT-INCLUSIVE and rounds with round2tx (parseFloat/toFixed).
//   • A purchase invoice is entered the way suppliers actually print them:
//     each line carries a VAT-EXCLUSIVE unit cost, and VAT is added ON TOP.
//     Line net = qty × unitCost; line VAT = net × rate; line gross = net + VAT.
//   • Rounding uses the half-up zr2 from tax.js (the reporting-path rounding),
//     because these figures feed the input-VAT report — NOT the POS round2tx.
//   This is a THIRD, self-contained money path. It does not touch, and must not
//   be converged with, the two existing conventions without owner sign-off.
//
// PURE + testable: no React, no Firestore. The UI renders what these return and
// the persistence layer decides where invoices are stored (that tier is a
// separate decision — these functions don't care).
// ═══════════════════════════════════════════════════════════════════
import { VAT_RATE, zr2 } from "./tax.js";

/** Coerce to a finite number, else fallback (default 0). */
const num = (v, fallback = 0) => {
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Normalise a supplier's invoice NUMBER for comparison: trim, uppercase, and
 * drop spaces, dashes and slashes so "INV-001", "inv 001" and "INV/001" all
 * collide. Used for duplicate detection — never shown to the user.
 */
export function normInvoiceNo(v) {
  return String(v ?? "").trim().toUpperCase().replace(/[\s\-/\\.]+/g, "");
}

/**
 * Compute one purchase-invoice line's money from a raw entered line.
 * unitCost is VAT-EXCLUSIVE. rate defaults to the standard KSA VAT rate; pass
 * 0 for a zero-rated / exempt purchase line.
 * @returns { ...line, qty, unitCost, rate, net, vat, gross }
 */
export function computeLine(line = {}) {
  const qty = num(line.qty, 0);
  const unitCost = num(line.unitCost, 0);
  // rate: honour an explicit 0; only fall back to standard when truly unset.
  const rate = (line.rate === 0 || line.rate === "0") ? 0 : num(line.rate, VAT_RATE);
  const net = zr2(qty * unitCost);
  const vat = zr2(net * rate);
  const gross = zr2(net + vat);
  return { ...line, qty, unitCost, rate, net, vat, gross };
}

/**
 * Normalise + total a whole purchase invoice. Behaviour-defining:
 *   • lines are computed with computeLine (net/vat/gross each zr2-rounded)
 *   • invoice totals SUM the already-rounded line figures (so the printed
 *     invoice's lines always add up to its total — no penny drift)
 *   • supplierInvoiceNoNorm is attached for duplicate detection
 * @returns a normalised invoice object with { lines, subtotal, vatAmount, total }
 */
export function computePurchaseInvoice(inv = {}) {
  const lines = (Array.isArray(inv.lines) ? inv.lines : []).map(computeLine);
  const subtotal = zr2(lines.reduce((s, l) => s + l.net, 0));
  const vatAmount = zr2(lines.reduce((s, l) => s + l.vat, 0));
  const total = zr2(subtotal + vatAmount);
  return {
    ...inv,
    supplierId: inv.supplierId ?? null,
    supplierName: String(inv.supplierName ?? "").trim(),
    supplierInvoiceNo: String(inv.supplierInvoiceNo ?? "").trim(),
    supplierInvoiceNoNorm: normInvoiceNo(inv.supplierInvoiceNo),
    invoiceDate: inv.invoiceDate ?? null,
    hasValidEInvoice: !!inv.hasValidEInvoice,
    lines,
    subtotal,
    vatAmount,
    total,
  };
}

/**
 * Validate a purchase invoice for capture. Returns { valid, errors[] }.
 * Rules are the minimum that makes the document a usable AP/VAT record.
 */
export function validatePurchaseInvoice(inv = {}) {
  const errors = [];
  const hasSupplier = (inv.supplierId != null && inv.supplierId !== "") ||
    String(inv.supplierName ?? "").trim() !== "";
  if (!hasSupplier) errors.push("supplier-required");
  if (String(inv.supplierInvoiceNo ?? "").trim() === "") errors.push("invoice-number-required");
  if (!inv.invoiceDate) errors.push("invoice-date-required");

  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  const usable = lines.filter((l) => num(l.qty, 0) > 0);
  if (usable.length === 0) errors.push("no-lines");
  if (lines.some((l) => num(l.qty, 0) < 0)) errors.push("negative-qty");
  if (lines.some((l) => num(l.unitCost, 0) < 0)) errors.push("negative-cost");

  return { valid: errors.length === 0, errors };
}

/**
 * Detect whether a candidate purchase invoice duplicates one already captured.
 * This is the key safety control: entering the same supplier invoice twice
 * double-counts input VAT (a real tax-compliance risk), so the UI should BLOCK
 * an exact match and WARN on a near match.
 *
 *   • "exact": same supplier AND same normalised invoice number. Hard block.
 *   • "near" : same supplier AND same total AND same invoice date, when the
 *              number is blank or differs — likely a re-key with a typo'd/absent
 *              number. Soft warning (let the user confirm it's genuinely new).
 *
 * Supplier identity matches on supplierId when both sides have one, else on a
 * trimmed case-insensitive supplierName (older suppliers were tagged by name).
 *
 * @param candidate a raw or computed invoice
 * @param existing  already-captured invoices (raw or computed)
 * @param opts.ignoreId skip this invoice id in `existing` (so editing an
 *        invoice doesn't flag itself)
 * @returns { duplicate, level: "exact"|"near"|null, match, reason }
 */
export function detectDuplicatePurchase(candidate = {}, existing = [], opts = {}) {
  const cand = computePurchaseInvoice(candidate);
  const ignoreId = opts.ignoreId ?? null;

  const sameSupplier = (a) => {
    if (cand.supplierId != null && cand.supplierId !== "" &&
        a.supplierId != null && a.supplierId !== "") {
      return String(a.supplierId) === String(cand.supplierId);
    }
    const an = String(a.supplierName ?? "").trim().toLowerCase();
    const cn = cand.supplierName.toLowerCase();
    return an !== "" && an === cn;
  };

  const pool = (existing || []).filter((a) => a && a.id !== ignoreId);

  // 1) exact: supplier + invoice number (only when the candidate HAS a number)
  if (cand.supplierInvoiceNoNorm) {
    const exact = pool.find((a) =>
      sameSupplier(a) && normInvoiceNo(a.supplierInvoiceNo) === cand.supplierInvoiceNoNorm);
    if (exact) {
      return { duplicate: true, level: "exact", match: exact,
        reason: "same-supplier-and-invoice-number" };
    }
  }

  // 2) near: supplier + same total + same date (number blank or different)
  const near = pool.find((a) => {
    if (!sameSupplier(a)) return false;
    const at = computePurchaseInvoice(a);
    return at.total === cand.total && cand.total > 0 &&
      !!at.invoiceDate && at.invoiceDate === cand.invoiceDate;
  });
  if (near) {
    return { duplicate: true, level: "near", match: near,
      reason: "same-supplier-total-and-date" };
  }

  return { duplicate: false, level: null, match: null, reason: null };
}
