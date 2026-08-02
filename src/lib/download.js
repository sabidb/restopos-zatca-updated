// ═══════════════════════════════════════════════════
// FILE EXPORT HELPERS — trigger a browser download, and format one ZATCA
// archive invoice as a CSV row (+ the matching header). Pure / browser-only.
// Extracted verbatim from App.jsx.
// ═══════════════════════════════════════════════════

export function archiveCsvRow(inv){
  const esc=v=>`"${String(v??"").replace(/"/g,'""')}"`;
  return [
    inv.invoice_number,inv.icv,inv.uuid,(inv.timestamp||"").slice(0,10),(inv.timestamp||"").slice(11,19),
    inv.is_credit_note?"Credit Note":(inv.invoice_type||(inv.is_b2b?"B2B":"B2C")),
    inv.seller_name,inv.seller_vat,inv.buyer_name||"",inv.buyer_vat||"",
    (inv.subtotal??"").toString(),(inv.vat_amount??"").toString(),(inv.total??"").toString(),
    inv.payMethod||"",inv.zatca_reported?"Yes":"No",inv.zatca_cleared?"Yes":"No",inv.invoice_hash||""
  ].map(esc).join(",");
}
export const ARCHIVE_CSV_HEADER=["Invoice Number","ICV","UUID","Date","Time","Type","Seller","Seller VAT","Buyer Name","Buyer VAT","Subtotal","VAT Amount","Total","Payment Method","ZATCA Reported","ZATCA Cleared","Invoice Hash"].join(",");

export function downloadBlob(blob,filename){
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
