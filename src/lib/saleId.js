// Stable per-device invoice-ID prefix. Local vno counters are not safe to use
// as global sale IDs when two tills create invoices concurrently/offline.
export const DEVICE_INVOICE_PREFIX_KEY="restopos_device_invoice_prefix";
let fallbackPrefix="";
function randomPrefix(){
  const raw=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}-${Math.random()}`;
  return String(raw).replace(/[^a-z0-9]/gi,"").slice(0,6).toUpperCase().padEnd(6,"0");
}
export function getDeviceInvoicePrefix(storage=globalThis.localStorage){
  try{
    const existing=storage?.getItem(DEVICE_INVOICE_PREFIX_KEY);
    if(existing&&/^[A-Z0-9]{6}$/.test(existing))return existing;
    const next=randomPrefix();
    try{storage?.setItem(DEVICE_INVOICE_PREFIX_KEY,next);}catch(_){}
    fallbackPrefix=next;
    return next;
  }catch(_){
    if(!fallbackPrefix)fallbackPrefix=randomPrefix();
    return fallbackPrefix;
  }
}
export function buildSaleInvoiceId(vno,prefix){
  return `INV-${String(prefix||"000000").toUpperCase()}-${Number(vno)||0}`;
}
export function buildZatcaInvoiceNumber(icv,prefix){
  const n=Math.max(0,Math.trunc(Number(icv)||0));
  return `INV-${String(prefix||"000000").toUpperCase()}-${String(n).padStart(6,"0")}`;
}
export function buildDraftInvoiceId(vno,letter,prefix){
  return `D-${String(prefix||"000000").toUpperCase()}-${Number(vno)||0}${String(letter||"A").toUpperCase()}`;
}
