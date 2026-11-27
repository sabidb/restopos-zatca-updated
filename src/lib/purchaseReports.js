// ═══════════════════════════════════════════════════════════════════
// PURCHASE REPORTS — read-only aggregation over captured purchase documents
// (invoices + credit notes). Costing-agnostic: these report what was BILLED,
// not stock valuation (which needs a costing method and is out of scope here).
//
//   • purchaseRegister(docs, {from,to}) — the list of documents in a period,
//     with signed totals (credit notes subtract) and an input-VAT recoverable /
//     non-recoverable split (input VAT is only recoverable when the supplier
//     issued a valid ZATCA e-invoice — the hasValidEInvoice flag).
//   • supplierBalances(docs) — net payable per supplier (invoices − credit notes).
//
// Pure + testable: no React, no Firestore. Money is summed from each document's
// already-rounded totals and the final figures are re-rounded (zr2) so display
// never shows float noise.
// ═══════════════════════════════════════════════════════════════════
import { signedAmounts, normDocType, inputVatEligibility, normInvoiceNo, recoverablePortion } from "./purchases.js";
import { zr2 } from "./tax.js";

/** Inclusive date filter on an ISO yyyy-mm-dd string. Missing bound = open end. */
function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

/** A stable supplier key: prefer id, else the trimmed lowercase name. */
function supplierKey(d) {
  if (d.supplierId != null && d.supplierId !== "") return "id:" + d.supplierId;
  return "name:" + String(d.supplierName ?? "").trim().toLowerCase();
}

/**
 * Purchase register for a period. When from/to are omitted, all documents are
 * included. Rows are returned oldest-first.
 * @returns { rows, count, totals }
 *   totals = { net, vat, gross, invoices, creditNotes, recoverableVat, nonRecoverableVat }
 *   (net/vat/gross and the vat split are SIGNED — credit notes subtract.)
 */
export function purchaseRegister(docs = [], { from, to } = {}) {
  const rows = (docs || [])
    .filter((d) => d && inRange(d.invoiceDate, from, to))
    .slice()
    .sort((a, b) => String(a.invoiceDate).localeCompare(String(b.invoiceDate)));

  const t = { net: 0, vat: 0, gross: 0, invoices: 0, creditNotes: 0, recoverableVat: 0, nonRecoverableVat: 0 };
  for (const d of rows) {
    const s = signedAmounts(d);
    t.net += s.subtotal; t.vat += s.vatAmount; t.gross += s.total;
    if (normDocType(d.docType) === "credit_note") t.creditNotes++; else t.invoices++;
    const p = recoverablePortion(d);
    t.recoverableVat += s.vatAmount * p; t.nonRecoverableVat += s.vatAmount * (1 - p);
  }
  const totals = {
    net: zr2(t.net), vat: zr2(t.vat), gross: zr2(t.gross),
    invoices: t.invoices, creditNotes: t.creditNotes,
    recoverableVat: zr2(t.recoverableVat), nonRecoverableVat: zr2(t.nonRecoverableVat),
  };
  return { rows, count: rows.length, totals };
}

/**
 * Purchase exception queue (AUD-02 §5.3) — the bills that need a human's
 * attention before their input VAT can be trusted. Pure and read-only; it flags
 * problems, it does not change any figure. Two categories today:
 *
 *   • "claimed_not_recoverable" — the bill is ticked as a valid e-invoice but
 *     fails the evidence rule (missing/invalid supplier VAT, invoice no, date).
 *     Its input VAT is NOT being recovered; the reasons say why.
 *   • "duplicate" — the same supplier + normalised invoice number appears on
 *     more than one invoice (double-counting input VAT is a real tax risk).
 *     Every member after the first is reported.
 *
 * @returns {Array<{id, supplierName, supplierInvoiceNo, invoiceDate, vatAmount, category, reasons:string[]}>}
 */
export function purchaseExceptions(docs = []) {
  const out = [];
  const seen = new Map(); // supplierKey|invoiceNo -> firstId, for duplicate detection

  for (const d of docs || []) {
    if (!d) continue;
    const base = {
      id: d.id,
      supplierName: d.supplierName || "",
      supplierInvoiceNo: d.supplierInvoiceNo || "",
      invoiceDate: d.invoiceDate || "",
      vatAmount: d.vatAmount,
    };

    // Claimed recoverable but evidence incomplete.
    if (d.hasValidEInvoice) {
      const el = inputVatEligibility(d);
      if (!el.recoverable) out.push({ ...base, category: "claimed_not_recoverable", reasons: el.reasons });
    }

    // Duplicate supplier + invoice number (invoices only; a credit note may
    // legitimately reuse a number, and it is matched to its own kind).
    const inv = normInvoiceNo(d.supplierInvoiceNo);
    if (inv && normDocType(d.docType) !== "credit_note") {
      const key = supplierKey(d) + "|" + inv;
      if (seen.has(key)) out.push({ ...base, category: "duplicate", reasons: ["duplicate-supplier-invoice-number"] });
      else seen.set(key, d.id);
    }
  }
  return out;
}

/**
 * Net payable per supplier across all documents (optionally date-filtered).
 * balance = invoices − credit notes (what the shop still owes, before payments;
 * AP payment capture is a later slice). Sorted by balance, largest first.
 * @returns [{ supplierId, supplierName, invoiceTotal, creditTotal, balance, docCount, lastDate }]
 */
export function supplierBalances(docs = [], { from, to } = {}) {
  const map = new Map();
  for (const d of docs || []) {
    if (!d) continue;
    if ((from || to) && !inRange(d.invoiceDate, from, to)) continue;
    const key = supplierKey(d);
    if (!map.has(key)) {
      map.set(key, {
        supplierId: d.supplierId ?? null,
        supplierName: String(d.supplierName ?? "").trim(),
        invoiceTotal: 0, creditTotal: 0, balance: 0, docCount: 0, lastDate: null,
      });
    }
    const e = map.get(key);
    const s = signedAmounts(d);
    if (normDocType(d.docType) === "credit_note") e.creditTotal += Math.abs(s.total);
    else e.invoiceTotal += s.total;
    e.balance += s.total;
    e.docCount++;
    if (d.invoiceDate && (!e.lastDate || d.invoiceDate > e.lastDate)) e.lastDate = d.invoiceDate;
    if (!e.supplierName && d.supplierName) e.supplierName = String(d.supplierName).trim();
  }
  return [...map.values()]
    .map((e) => ({ ...e, invoiceTotal: zr2(e.invoiceTotal), creditTotal: zr2(e.creditTotal), balance: zr2(e.balance) }))
    .sort((a, b) => b.balance - a.balance);
}
