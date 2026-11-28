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

// Purchase documents come in two kinds: a purchase INVOICE (the shop owes the
// supplier) and a supplier CREDIT NOTE (the supplier owes the shop back — a
// return or an overcharge correction). They share the same structure and line
// math; only the SIGN differs when aggregating (a credit note reduces payables
// and reduces recoverable input VAT). Default is "invoice" so documents captured
// before credit notes existed keep behaving exactly as before.
export const PURCHASE_DOC_TYPES = ["invoice", "credit_note"];
export function normDocType(v) { return v === "credit_note" ? "credit_note" : "invoice"; }

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
  const hasLines = lines.some((l) => l.qty > 0 || l.net > 0 || l.vat > 0);

  // AMOUNT-ONLY quick entry: when there are no priced lines but the merchant
  // typed a single lump-sum amount (supplier total), derive the VAT from it so
  // the document is still a usable input-VAT record without line items.
  //   • amountInclVat !== false → the amount is the VAT-INCLUSIVE grand total
  //     (what the supplier printed); VAT is extracted with rate/(1+rate).
  //   • amountInclVat === false → the amount is net (ex-VAT); VAT is added on top.
  // rate defaults to the standard KSA rate; pass 0 for a zero-rated purchase.
  const amount = num(inv.totalAmount, 0);
  const amountRate = (inv.amountRate === 0 || inv.amountRate === "0") ? 0 : num(inv.amountRate, VAT_RATE);
  let subtotal, vatAmount, total;
  if (!hasLines && amount > 0) {
    if (inv.amountInclVat === false) {
      subtotal = zr2(amount);
      vatAmount = zr2(amount * amountRate);
      total = zr2(subtotal + vatAmount);
    } else {
      total = zr2(amount);
      vatAmount = zr2(total * amountRate / (1 + amountRate));
      subtotal = zr2(total - vatAmount);
    }
  } else {
    // Totals SUM the already-rounded line figures (no penny drift).
    subtotal = zr2(lines.reduce((s, l) => s + l.net, 0));
    vatAmount = zr2(lines.reduce((s, l) => s + l.vat, 0));
    total = zr2(subtotal + vatAmount);
  }
  return {
    ...inv,
    docType: normDocType(inv.docType),
    // Amount-only quick-entry fields (null/defaults when a line-item invoice).
    totalAmount: amount > 0 ? zr2(amount) : null,
    amountInclVat: inv.amountInclVat !== false,
    amountRate,
    supplierId: inv.supplierId ?? null,
    supplierName: String(inv.supplierName ?? "").trim(),
    // Supplier tax identity captured at entry time — kept on the document so the
    // input-VAT record carries the supplier's VAT/CR even if the supplier is
    // later edited or deleted.
    supplierVatNumber: String(inv.supplierVatNumber ?? "").trim(),
    supplierCrNumber: String(inv.supplierCrNumber ?? "").trim(),
    supplierInvoiceNo: String(inv.supplierInvoiceNo ?? "").trim(),
    supplierInvoiceNoNorm: normInvoiceNo(inv.supplierInvoiceNo),
    invoiceDate: inv.invoiceDate ?? null,
    hasValidEInvoice: !!inv.hasValidEInvoice,
    // Optional accountant apportionment (0..1). null/undefined ⇒ fully recoverable.
    recoverablePortion: (inv.recoverablePortion == null || inv.recoverablePortion === "")
      ? null
      : Math.max(0, Math.min(1, Number(inv.recoverablePortion) || 0)),
    lines,
    subtotal,
    vatAmount,
    total,
  };
}

/**
 * Signed money for aggregation (reports, supplier balances, input-VAT totals).
 * An invoice counts positive; a credit note counts negative. Accepts either a
 * raw document or one already carrying computed totals.
 * @returns { subtotal, vatAmount, total, sign }
 */
export function signedAmounts(doc = {}) {
  const t = (typeof doc.total === "number" && typeof doc.vatAmount === "number" && typeof doc.subtotal === "number")
    ? { subtotal: doc.subtotal, vatAmount: doc.vatAmount, total: doc.total }
    : computePurchaseInvoice(doc);
  const sign = normDocType(doc.docType) === "credit_note" ? -1 : 1;
  return { subtotal: sign * t.subtotal, vatAmount: sign * t.vatAmount, total: sign * t.total, sign };
}

/**
 * Shape check for a Saudi VAT registration number: 15 digits, starting and
 * ending with 3. Spaces are ignored.
 *
 * ⚠️ SHAPE ONLY. This validates the documented format, NOT the internal
 * check-digit / Luhn rule, which must be confirmed against ZATCA before it is
 * treated as authoritative. A number can pass this and still be invalid; it is
 * a guard against obvious junk (a blank, a CR number, a typo'd length), not a
 * proof of a real registration.
 * @returns {boolean}
 */
export function isValidSaudiVatNumber(v) {
  const s = String(v ?? "").replace(/\s+/g, "");
  return /^3\d{13}3$/.test(s);
}

/**
 * Input-VAT eligibility for a captured purchase, with the reasons it is or is
 * not recoverable. This is the evidence-based rule (AUD-02): a user ticking
 * "supplier issued a valid e-invoice" is NECESSARY but no longer SUFFICIENT —
 * the record must also carry the evidence that backs the claim (a valid-format
 * supplier VAT number, the supplier's invoice number, and the invoice date).
 * No checkbox alone makes input tax recoverable.
 *
 * Reasons use stable codes so the UI can explain exactly what is missing:
 *   not-marked-valid-einvoice | invalid-supplier-vat-number
 *   missing-invoice-number    | missing-invoice-date
 *
 * @returns {{ recoverable: boolean, reasons: string[] }}
 */
export function inputVatEligibility(doc) {
  const reasons = [];
  if (!doc || !doc.hasValidEInvoice) reasons.push("not-marked-valid-einvoice");
  if (!isValidSaudiVatNumber(doc && doc.supplierVatNumber)) reasons.push("invalid-supplier-vat-number");
  if (!String((doc && doc.supplierInvoiceNo) ?? "").trim()) reasons.push("missing-invoice-number");
  if (!String((doc && doc.invoiceDate) ?? "").trim()) reasons.push("missing-invoice-date");
  return { recoverable: reasons.length === 0, reasons };
}

/**
 * CANONICAL input-VAT recoverability rule. The ONE place the whole app decides
 * whether a captured purchase's input VAT may be recovered. Every report path
 * (daily report, VAT bridge, purchase register) MUST call this rather than read
 * any flag directly, so the recoverable figure can never diverge between screens.
 *
 * Backed by inputVatEligibility (evidence-based, AUD-02): applied uniformly to
 * ALL purchases — existing records are re-evaluated under the same rule, so a
 * bill ticked recoverable but lacking a valid supplier VAT number / invoice
 * number / date is no longer counted.
 * @returns {boolean}
 */
export function isInputVatRecoverable(doc) {
  return inputVatEligibility(doc).recoverable;
}

/**
 * Effective recoverable FRACTION (0..1) of a purchase's input VAT (AUD-02 §5.3,
 * partial recoverability / apportionment).
 *   • 0 when the bill is not eligible at all (fails the evidence rule) — an
 *     ineligible bill recovers nothing regardless of any portion.
 *   • otherwise the accountant-set `recoverablePortion` (stored as a 0..1
 *     fraction), clamped to [0,1], defaulting to 1 (fully recoverable) when
 *     unset. Use this for partial/mixed-use bills ONLY where the applicable VAT
 *     rule permits it and the allocation is documented.
 * @returns {number} 0..1
 */
export function recoverablePortion(doc) {
  if (!isInputVatRecoverable(doc)) return 0;
  const raw = doc && doc.recoverablePortion;
  if (raw == null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

/**
 * Lists purchases the OLD checkbox-only rule counted as recoverable but the new
 * evidence rule does not — so the change to existing data is visible, not
 * silent. Each entry carries the reasons it is now disallowed.
 * @returns {Array<{id,supplierName,supplierInvoiceNo,vatAmount,reasons:string[]}>}
 */
export function recoverabilityDelta(docs = []) {
  return (docs || [])
    .filter((d) => d && d.hasValidEInvoice && !isInputVatRecoverable(d))
    .map((d) => ({
      id: d.id,
      supplierName: d.supplierName || "",
      supplierInvoiceNo: d.supplierInvoiceNo || "",
      vatAmount: d.vatAmount,
      reasons: inputVatEligibility(d).reasons,
    }));
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

  // The supplier's invoice number and date are KEPT if typed (and used for
  // duplicate detection), but are NOT required — a merchant can save a quick
  // amount-only purchase with just a supplier and an amount.
  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  const usable = lines.filter((l) => num(l.qty, 0) > 0);
  const hasAmount = num(inv.totalAmount, 0) > 0;
  // A usable document needs SOME money: either priced lines, or a lump-sum amount.
  if (usable.length === 0 && !hasAmount) errors.push("no-amount");
  if (lines.some((l) => num(l.qty, 0) < 0)) errors.push("negative-qty");
  if (lines.some((l) => num(l.unitCost, 0) < 0)) errors.push("negative-cost");
  if (num(inv.totalAmount, 0) < 0) errors.push("negative-amount");
  if (hasAmount && usable.length === 0 && ![0,0.15].includes(num(inv.amountRate,0.15))) errors.push("invalid-vat-rate");

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

  // Only compare like with like: an invoice duplicates an invoice, a credit note
  // duplicates a credit note (they can legitimately share a number otherwise).
  const pool = (existing || []).filter((a) =>
    a && a.id !== ignoreId && normDocType(a.docType) === normDocType(cand.docType));

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

/**
 * Read-only reconciliation diagnostic for a saved purchase invoice. It never
 * changes stored totals or eligibility; it compares saved fields with the
 * existing purchase calculation path and exposes recoverable input VAT.
 */
export function auditPurchaseInvoice(doc = {}) {
  const computed=computePurchaseInvoice(doc);
  const warnings=[];
  const saved={subtotal:doc.subtotal,vatAmount:doc.vatAmount,total:doc.total};
  const fields=["subtotal","vatAmount","total"];
  const hasAnySaved=fields.some(k=>doc[k]!=null);
  const hasAllSaved=fields.every(k=>doc[k]!=null&&Number.isFinite(Number(doc[k])));
  if(hasAnySaved&&!hasAllSaved)warnings.push("partial-saved-totals");
  if(hasAllSaved){
    for(const field of fields){
      if(zr2(Number(doc[field]))!==zr2(Number(computed[field])))warnings.push(`saved-${field}-mismatch`);
    }
  }
  const savedLines=Array.isArray(doc.lines)?doc.lines:[];
  if(savedLines.length!==computed.lines.length&&savedLines.length>0)warnings.push("line-count-mismatch");
  savedLines.forEach((line,i)=>{
    const expected=computed.lines[i];
    if(!expected)return;
    for(const field of ["net","vat","gross"])if(line[field]!=null&&Number.isFinite(Number(line[field]))&&zr2(Number(line[field]))!==zr2(Number(expected[field])))warnings.push(`line-${i}-${field}-mismatch`);
  });
  const eligibility=inputVatEligibility(doc);
  const portion=recoverablePortion(doc);
  const signed=signedAmounts(computed);
  return {
    id:doc.id??null,
    docType:normDocType(doc.docType),
    savedTotals:saved,
    computedTotals:{subtotal:computed.subtotal,vatAmount:computed.vatAmount,total:computed.total},
    totalDelta:hasAllSaved?zr2(Number(doc.total)-computed.total):null,
    vatDelta:hasAllSaved?zr2(Number(doc.vatAmount)-computed.vatAmount):null,
    warnings:[...new Set(warnings)],
    financiallyReconciled:hasAllSaved&&warnings.length===0,
    inputVatEligible:eligibility.recoverable,
    inputVatReasons:eligibility.reasons,
    recoverablePortion:portion,
    recoverableInputVat:zr2(signed.vatAmount*portion),
  };
}

/** Read-only register audit for duplicate invoices, financial mismatches, and
 * recoverable input VAT. No document is recalculated or mutated in-place. */
export function auditPurchaseRegister(docs=[]) {
  const list=Array.isArray(docs)?docs:[];
  const audits=list.map(auditPurchaseInvoice);
  const exactDuplicates=[],nearDuplicates=[];
  for(let i=0;i<list.length;i++){
    const dup=detectDuplicatePurchase(list[i],list.slice(0,i));
    if(dup.level==="exact")exactDuplicates.push({id:list[i]?.id,matchId:dup.match?.id,reason:dup.reason});
    else if(dup.level==="near")nearDuplicates.push({id:list[i]?.id,matchId:dup.match?.id,reason:dup.reason});
  }
  const signed=list.map(signedAmounts).reduce((a,v)=>({subtotal:zr2(a.subtotal+v.subtotal),vatAmount:zr2(a.vatAmount+v.vatAmount),total:zr2(a.total+v.total)}),{subtotal:0,vatAmount:0,total:0});
  const recoverableInputVat=zr2(list.reduce((n,doc)=>n+signedAmounts(doc).vatAmount*recoverablePortion(doc),0));
  return {
    count:list.length,
    financiallyReconciledCount:audits.filter(a=>a.financiallyReconciled).length,
    financiallyUnreconciledCount:audits.filter(a=>a.warnings.length>0).length,
    exactDuplicates,nearDuplicates,
    signedTotals:signed,
    recoverableInputVat,
    audits,
  };
}
