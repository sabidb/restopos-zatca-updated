// ═══════════════════════════════════════════════════════════════════
// VAT BRIDGE — turn captured purchase documents into the synthetic PURCHASE
// transactions the ZATCA VAT engine already aggregates, so a merchant's real
// supplier invoices flow into the input-VAT (Box 6, recoverable) side of the
// VAT return instead of being re-keyed by hand.
//
// COMPLIANCE NOTES (why the filter is what it is):
//   • Only RECOVERABLE input VAT is included — KSA lets a buyer recover input
//     VAT only when the supplier issued a valid ZATCA e-invoice (the
//     hasValidEInvoice flag). Non-recoverable purchases are left out so the
//     return's recoverable box is not overstated.
//   • Credit notes subtract (signed amounts), reducing recoverable input VAT.
//   • This feeds the IN-APP VAT RETURN SUMMARY only. It does NOT produce or
//     submit any ZATCA invoice XML — the merchant still files on ZATCA's portal.
//
// Pure + testable. The VAT engine includes these only when the merchant opts in
// (a default-off, supermarket-only toggle), so nothing here changes an existing
// filed figure unless the merchant chooses it.
// ═══════════════════════════════════════════════════════════════════
import { signedAmounts, normDocType, isInputVatRecoverable } from "./purchases.js";

/**
 * @param docs    captured purchase documents (invoices + credit notes)
 * @param period  "YYYY-MM"; when given, only docs whose invoiceDate falls in it
 * @returns synthetic { type:"PURCHASE", category:"STANDARD", net, vat, gross, … }
 *          transactions — one per recoverable document, credit notes signed.
 */
export function purchaseDocsToVatTx(docs = [], period) {
  const out = [];
  for (const d of docs || []) {
    if (!isInputVatRecoverable(d)) continue;                 // recoverable only (canonical rule)
    const ym = String(d.invoiceDate || "").slice(0, 7);
    if (period && ym !== period) continue;                   // period filter
    const s = signedAmounts(d);
    const isCN = normDocType(d.docType) === "credit_note";
    out.push({
      id: "autopur-" + (d.id ?? ym + "-" + out.length),
      date: d.invoiceDate || "",
      type: "PURCHASE",
      category: "STANDARD",
      description: (isCN ? "Credit note" : "Purchase invoice") + " — " +
        (d.supplierName || "supplier") + (d.supplierInvoiceNo ? " · " + d.supplierInvoiceNo : ""),
      net: s.subtotal,
      vat: s.vatAmount,
      gross: s.total,
      inclVAT: false,
      invoiceRef: d.supplierInvoiceNo || "",
      auto: true,
      source: "purchase-doc",
    });
  }
  return out;
}

/** Recoverable input VAT these documents contribute for a period (signed). */
export function recoverableInputVat(docs = [], period) {
  return Math.round(
    purchaseDocsToVatTx(docs, period).reduce((s, t) => s + t.vat, 0) * 100
  ) / 100;
}
