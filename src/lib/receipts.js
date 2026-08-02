// ═══════════════════════════════════════════════════
// RECEIPT / PRINT HTML BUILDERS — pure string builders for thermal and
// A4 receipts, KOT tickets and draft/summary print-outs. Shared by every
// business type. Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════
import { LS } from "./storage.js";
import { _escHTML, _escMultiline } from "./html.js";

export function buildDraftSummaryHTML(drafts,dateFrom,dateTo){
  const total=drafts.reduce((s,d)=>s+(d.total||0),0);
  const vat=drafts.reduce((s,d)=>s+(d.vat||0),0);
  const lic=LS.get("restopos_license_v2")||{};
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;font-size:12px;max-width:700px;margin:20px auto;padding:20px;color:#111}
h1{font-size:18px;font-weight:900;color:#A07000;margin:0}
table{width:100%;border-collapse:collapse;margin:16px 0}
th{background:#FFF8E8;padding:8px 10px;text-align:left;font-weight:700;font-size:10px;text-transform:uppercase;border-bottom:2px solid #F0E0A0}
td{padding:7px 10px;border-bottom:1px solid #F5EDD0;font-size:11px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:14px;border-bottom:3px solid #F0A500}
.badge{background:#F0A500;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px}
</style></head><body>
<div class="hdr">
  <div><h1>📋 DRAFT INVOICES SUMMARY</h1>
  <div style="font-size:11px;color:#666;margin-top:4px">${lic.businessName||"Restaurant"} · VAT: ${lic.vatNumber||""}</div></div>
  <div style="text-align:right">
    <div class="badge">D-INVOICES</div>
    <div style="font-size:11px;color:#888;margin-top:4px">Period: ${dateFrom} → ${dateTo}</div>
    <div style="font-size:11px;color:#888">Printed: ${new Date().toLocaleString("en-SA")}</div>
  </div>
</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
  ${[["Total Drafts",drafts.length],["Total Amount","SAR "+total.toFixed(2)],["VAT Collected","SAR "+vat.toFixed(2)]].map(([l,v])=>`<div style="background:#FFF8E8;border-radius:8px;padding:10px;border-left:3px solid #F0A500"><div style="font-size:10px;color:#888">${l}</div><div style="font-size:16px;font-weight:900;color:#A07000">${v}</div></div>`).join("")}
</div>
<table>
<thead><tr><th>Invoice#</th><th>Date</th><th>Time</th><th>Customer</th><th>Items</th><th>Discount</th><th>VAT</th><th>Total</th><th>Method</th><th>Note</th></tr></thead>
<tbody>
${drafts.map(d=>`<tr>
  <td style="font-family:monospace;font-weight:700;color:#A07000">${d.id}</td>
  <td>${d.date}</td><td>${d.time}</td>
  <td>${d.customer||"—"}</td>
  <td style="font-size:10px;color:#666">${(d.items||[]).map(i=>i.qty+"x "+i.name).join(", ").slice(0,35)}</td>
  <td>${d.discount>0?"-SAR "+(d.discount||0).toFixed(2):"—"}</td>
  <td>SAR ${(d.vat||0).toFixed(2)}</td>
  <td style="font-weight:700">SAR ${(d.total||0).toFixed(2)}</td>
  <td>${d.payMethod||"—"}</td>
  <td style="font-style:italic;color:#888">${d.note||"—"}</td>
</tr>`).join("")}
</tbody>
<tfoot><tr style="background:#FFF8E8;font-weight:900">
  <td colspan="7">TOTAL (${drafts.length} drafts)</td>
  <td style="color:#A07000">SAR ${total.toFixed(2)}</td>
  <td colspan="2"></td>
</tr></tfoot>
</table>
<div style="margin-top:12px;font-size:10px;color:#aaa;text-align:center">DRAFT BILLS — Not official tax invoices · هذه فواتير مسودة وليست فواتير ضريبية رسمية</div>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// RECEIPT HTML BUILDER — single source of truth for the printed receipt.
// Honours the saved Invoice Format (template, fonts, colours, toggles)
// AND embeds the ZATCA QR (qrImgSrc) so the printout matches the preview.
// Used by: checkout print (QZ/ESC-POS/browser), receipt modal and the
// Invoice Format live preview. Draft invoices use a separate builder.
// ═══════════════════════════════════════════════════════════════════
// Only fonts that render BOTH Arabic and English correctly on thermal printers.
// Old/English-only ids (courier, georgia, etc.) are mapped to a safe Arabic font.
const RECEIPT_FONT_MAP={
  "tajawal":"'Tahoma','Arial','Segoe UI',sans-serif",
  "cairo":"'Tahoma','Arial','Segoe UI',sans-serif",
  "amiri":"'Tahoma','Arial','Times New Roman',serif",
  "noto-naskh":"'Tahoma','Arial','Segoe UI',sans-serif",
  // legacy fallbacks → system Arabic-safe fonts
  "courier":"'Tahoma','Arial','Segoe UI',sans-serif",
  "georgia":"'Tahoma','Arial','Times New Roman',serif",
  "trebuchet":"'Tahoma','Arial','Segoe UI',sans-serif",
  "arial-narrow":"'Tahoma','Arial','Segoe UI',sans-serif",
  "impact":"'Tahoma','Arial','Segoe UI',sans-serif",
  "scheherazade":"'Tahoma','Arial','Times New Roman',serif",
};
export function buildReceiptHTML(order,license,zatcaInvoice,fmt,qrImgSrc){
  fmt=fmt||{};
  // If a preset style is active for invoices, use the preset builder (preview === print).
  if(fmt.usePreset&&fmt.presetStyle){
    return buildPresetHTML(order,license,zatcaInvoice,fmt,qrImgSrc,{draft:false});
  }
  order=order||{};
  const items=order.items||[];
  const paperWidth=fmt.paperWidth||"80mm";
  const fontSize=parseInt(fmt.fontSize)||12;
  const fontFamily=RECEIPT_FONT_MAP[fmt.font]||"'Tahoma','Arial','Times New Roman',serif";
  const template=fmt.template||"modern";
  const headerColor=fmt.headerColor||"#1A6B4A";
  const footer=fmt.footer||"Thank you for your visit!";
  const footerAr=fmt.footerAr||"شكراً لزيارتكم";
  const shopName=fmt.shopNameOverride||license?.businessName||"Restaurant";
  const address=license?.address||"";
  const vatNo=license?.vatNumber||"";
  const show=(k,def)=>fmt[k]===undefined?def:fmt[k];
  const showVat=show("showVat",true);
  const showCategories=show("showCategories",true);
  const showCustomer=show("showCustomer",true);
  const showOrderType=show("showOrderType",true);
  const showArabicName=show("showArabicName",true);
  const boldItems=!!fmt.boldItems;
  const totalSize=fmt.totalSize==="xl"?fontSize+6:fmt.totalSize==="small"?fontSize:fontSize+3;
  // Client-adjustable sizes (with safe defaults). logoSize px, qrSize px.
  const logoSize=parseInt(fmt.logoSize)||46;
  const qrSize=parseInt(fmt.qrSize)||120;
  const dateSize=fmt.dateSize!==undefined?parseInt(fmt.dateSize):(fontSize-1); // date/time text size
  const nameGap=fmt.nameGap!==undefined?parseInt(fmt.nameGap):2; // vertical gap between Arabic & English name (px)
  const sep=fmt.separator==="solid"?"1px solid #000":fmt.separator==="double"?"3px double #000":fmt.separator==="none"?"none":"1px dashed #000";
  const SEP=`<div style="border-top:${sep};margin:5px 0"></div>`;
  // Header — template aware
  let header="";
  const logoHTML=fmt.logoUrl?`<img src="${_escHTML(fmt.logoUrl)}" style="max-width:100%;max-height:${logoSize}px;display:block;margin:0 auto 4px"/>`:"";
  if(template==="modern"){
    header=`<div style="background:${headerColor};color:#fff;margin:-4mm -4mm 8px;padding:10px 8px;text-align:center;border-radius:0 0 6px 6px">${logoHTML}<div style="font-size:${fontSize+5}px;font-weight:900">${_escHTML(shopName)}</div>${address?`<div style="font-size:${fontSize-2}px;opacity:.9">${_escHTML(address)}</div>`:""}<div style="font-size:${fontSize-2}px;opacity:.9">TRN: ${_escHTML(vatNo)}</div>${fmt.tagline?`<div style="font-size:${fontSize-2}px;font-style:italic;opacity:.85">${_escMultiline(fmt.tagline)}</div>`:""}</div>`;
  }else if(template==="arabic"){
    header=`<div style="text-align:center;direction:rtl;font-family:'Tahoma','Arial','Segoe UI',sans-serif">${logoHTML}<div style="font-size:${fontSize+5}px;font-weight:900">${_escHTML(shopName)}</div>${address?`<div style="font-size:${fontSize-2}px">${_escHTML(address)}</div>`:""}<div style="font-size:${fontSize-2}px">الرقم الضريبي: ${_escHTML(vatNo)}</div>${fmt.tagline?`<div style="font-size:${fontSize-2}px;font-style:italic">${_escMultiline(fmt.tagline)}</div>`:""}</div>`;
  }else if(template==="minimal"){
    header=`<div style="text-align:center">${logoHTML}<div style="font-size:${fontSize+3}px;font-weight:900">${_escHTML(shopName)}</div><div style="font-size:${fontSize-2}px">TRN: ${_escHTML(vatNo)}</div></div>`;
  }else{ // classic
    header=`<div style="text-align:center">${logoHTML}<div style="font-size:${fontSize+3}px;font-weight:900;letter-spacing:.08em">${_escHTML(shopName)}</div>${address?`<div style="font-size:${fontSize-2}px">${_escHTML(address)}</div>`:""}<div style="font-size:${fontSize-2}px">TRN: ${_escHTML(vatNo)}</div>${fmt.tagline?`<div style="font-size:${fontSize-2}px;font-style:italic">${_escMultiline(fmt.tagline)}</div>`:""}</div>`;
  }
  // Meta row
  let meta=`<div style="display:flex;justify-content:space-between;font-size:${dateSize}px;gap:6px"><span style="word-break:break-word">${_escHTML(order.displayNumber||order.id||"")}</span><span style="white-space:nowrap">${_escHTML(order.date||"")} ${_escHTML(order.time||"")}</span></div>`;
  if(showOrderType&&(order.type||order.payMethod))meta+=`<div style="font-size:${fontSize-2}px;color:#555">${_escHTML(order.type||"Sale")}${order.table?" · Table "+_escHTML(order.table):""}${order.payMethod?" · "+_escHTML(order.payMethod):""}</div>`;
  if(showCustomer&&(order.customer||order.customerPhone))meta+=`<div style="font-size:${fontSize-2}px;word-break:break-word">Customer: ${_escHTML([order.customer,order.customerPhone].filter(Boolean).join(" · "))}</div>`;
  if(order.note)meta+=`<div style="font-size:${fontSize-2}px;font-style:italic;word-break:break-word">Note: ${_escHTML(order.note)}</div>`;
  // Items — Arabic name printed directly ABOVE the English name (stacked, same column).
  // Long names wrap; price stays right-aligned and never overflows.
  function lineHTML(it){
    const arTop=(showArabicName&&it.nameAr)?`<div style="direction:rtl;font-family:'Tahoma','Arial','Times New Roman',serif;font-size:${fontSize}px;font-weight:700;word-break:break-word;margin-bottom:${nameGap}px">${_escHTML(it.nameAr)}</div>`:"";
    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin:3px 0;gap:6px${boldItems?";font-weight:700":""}"><span style="flex:1 1 auto;min-width:0;padding-right:4px;word-break:break-word;overflow-wrap:anywhere">${arTop}<span style="display:block">${_escHTML(it.name)}<span style="color:#777"> x${it.qty}</span></span></span><span style="flex:0 0 auto;white-space:nowrap;text-align:right">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`;
  }
  let itemsHTML="";
  if(showCategories){
    const cats=[...new Set(items.map(i=>i.category||OTHER_CAT))];
    itemsHTML=cats.map(cat=>{
      const ci=items.filter(i=>(i.category||OTHER_CAT)===cat);
      if(!ci.length)return"";
      return `<div style="font-size:${fontSize-3}px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#888;margin:5px 0 2px;word-break:break-word">${_escHTML(cat)}</div>`+ci.map(lineHTML).join("");
    }).join("");
  }else{
    itemsHTML=items.map(lineHTML).join("");
  }
  // ZATCA QR block — printed on every (non-draft) invoice. QR is ALWAYS auto-generated (legally required) — size is adjustable only.
  const qrBlock=qrImgSrc
    ? `<div style="text-align:center;margin:8px 0">${zatcaInvoice?`<div style="font-size:${fontSize-3}px;color:#444;word-break:break-word">Invoice: ${_escHTML(zatcaInvoice.invoice_number||"")}${zatcaInvoice.icv?" · ICV: "+_escHTML(zatcaInvoice.icv):""}</div>`:""}<img src="${qrImgSrc}" style="width:${qrSize}px;height:${qrSize}px;max-width:100%;display:block;margin:4px auto"/><div style="font-size:${fontSize-3}px;font-weight:700;letter-spacing:.08em">ZATCA PHASE 2 · QR</div><div style="font-size:${fontSize-4}px;color:#777">TLV Base64 · Scan to verify</div></div>`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&display=swap" rel="stylesheet">
<style>
@page{size:${paperWidth} auto;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:${paperWidth};overflow-x:hidden}
body{font-family:${fontFamily};font-size:${fontSize}px;width:${paperWidth};padding:4mm;color:#000;background:#fff;line-height:1.45;word-break:break-word;overflow-wrap:anywhere}
img{max-width:100%}
</style></head><body>
${header}
${SEP}
${meta}
${SEP}
${itemsHTML}
${SEP}
${order.discount>0?`<div style="display:flex;justify-content:space-between;color:#b00;gap:6px"><span>Discount</span><span style="white-space:nowrap">-SAR ${order.discount.toFixed(2)}</span></div>`:""}
${showVat?`<div style="display:flex;justify-content:space-between;font-size:${fontSize-1}px;color:#666;gap:6px"><span>VAT 15% (incl.)</span><span style="white-space:nowrap">SAR ${(order.vat||0).toFixed(2)}</span></div>`:""}
<div style="display:flex;justify-content:space-between;font-weight:900;font-size:${totalSize}px;border-top:2px solid #000;padding-top:4px;margin-top:3px;gap:6px"><span>TOTAL</span><span style="white-space:nowrap">SAR ${(order.total||0).toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div style="display:flex;justify-content:space-between;font-size:${fontSize-1}px;gap:6px"><span>Cash Given</span><span style="white-space:nowrap">SAR ${(order.given||0).toFixed(2)}</span></div><div style="display:flex;justify-content:space-between;font-size:${fontSize-1}px;font-weight:700;gap:6px"><span>Change</span><span style="white-space:nowrap">SAR ${(order.change||0).toFixed(2)}</span></div>`:""}
${SEP}
${qrBlock}
${fmt.website?`<div style="text-align:center;font-size:${fontSize-2}px;color:#666;word-break:break-word">${_escHTML(fmt.website)}</div>`:""}
${fmt.social?`<div style="text-align:center;font-size:${fontSize-2}px;color:#666;word-break:break-word">${_escHTML(fmt.social)}</div>`:""}
<div style="text-align:center;font-weight:700;font-size:${fontSize}px;margin-top:4px;word-break:break-word">${_escMultiline(footer)}</div>
${footerAr?`<div style="text-align:center;direction:rtl;font-family:'Tahoma','Arial','Segoe UI',sans-serif;font-size:${fontSize}px;font-weight:700;word-break:break-word">${_escMultiline(footerAr)}</div>`:""}
${_brandingHTML(fmt)}
<br/><br/>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// BUILD DRAFT RECEIPT HTML — reusable for QZ and browser print
// ═══════════════════════════════════════════════════════════════════
// Draft bills use their OWN independent format (restopos_draft_format).
// They can show a custom image (logo OR QR) added via URL — persists until removed.
// They NEVER show the ZATCA QR (drafts are not tax invoices).
export function buildDraftReceiptHTML(order,license,fmt){
  fmt=fmt||{};
  // If a preset style is active for drafts, use the preset builder (preview === print).
  if(fmt.usePreset&&fmt.presetStyle){
    return buildPresetHTML(order,license,null,fmt,null,{draft:true});
  }
  const paperWidth=fmt.paperWidth||"80mm";
  const fontSize=parseInt(fmt.fontSize)||12;
  const fontFamily=RECEIPT_FONT_MAP[fmt.font]||"'Tahoma','Arial','Times New Roman',serif";
  const footer=fmt.footer||"Thank you for your visit!";
  const footerAr=fmt.footerAr||"شكراً لزيارتكم";
  const shopName=fmt.shopNameOverride||license?.businessName||"Restaurant";
  const items=order.items||[];
  const logoSize=parseInt(fmt.logoSize)||46;
  const dateSize=fmt.dateSize!==undefined?parseInt(fmt.dateSize):(fontSize-1);
  const nameGap=fmt.nameGap!==undefined?parseInt(fmt.nameGap):2;
  // Custom image for drafts — client decides if it's a logo or a QR; shown at the position they choose.
  const imgSize=parseInt(fmt.imageSize)||100;
  const imgHTML=fmt.imageUrl?`<div class="c" style="margin:6px 0"><img src="${_escHTML(fmt.imageUrl)}" style="max-width:100%;max-height:${imgSize}px;display:block;margin:0 auto"/>${fmt.imageCaption?`<div style="font-size:${fontSize-3}px;color:#666;margin-top:2px;word-break:break-word">${_escMultiline(fmt.imageCaption)}</div>`:""}</div>`:"";
  const imgPos=fmt.imagePosition||"bottom"; // "top" | "bottom"
  const logoHTML=fmt.logoUrl?`<div class="c"><img src="${_escHTML(fmt.logoUrl)}" style="max-width:100%;max-height:${logoSize}px;display:block;margin:0 auto 4px"/></div>`:"";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Tajawal:wght@400;700&family=Cairo:wght@400;700&family=Amiri:wght@400;700&family=Scheherazade+New:wght@400;700&display=swap" rel="stylesheet">
<style>
@page{size:${paperWidth} auto;margin:0}
*{box-sizing:border-box}
html,body{max-width:${paperWidth};overflow-x:hidden}
body{font-family:${fontFamily};font-size:${fontSize}px;width:${paperWidth};padding:4mm;color:#000;margin:0;word-break:break-word;overflow-wrap:anywhere;line-height:1.45}
img{max-width:100%}
.c{text-align:center}.b{font-weight:bold}
.hr{border:none;border-top:1px dashed #000;margin:4px 0}
.row{display:flex;justify-content:space-between;margin:2px 0;gap:6px}
.row span:last-child{white-space:nowrap;flex:0 0 auto;text-align:right}
.item{display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin:2px 0}
.item .nm{flex:1 1 auto;min-width:0;word-break:break-word;overflow-wrap:anywhere}
.item .pr{flex:0 0 auto;white-space:nowrap;text-align:right}
.badge{background:#F0A500;color:#fff;padding:2px 8px;border-radius:3px;font-weight:900;font-size:${fontSize}px}
</style></head><body>
${logoHTML}
<div class="c b" style="font-size:${fontSize+4}px;word-break:break-word">${_escHTML(shopName)}</div>
<div class="c" style="font-size:${fontSize-1}px;word-break:break-word">${_escHTML(license?.address||"")}</div>
<div class="c" style="font-size:${fontSize-1}px">VAT: ${_escHTML(license?.vatNumber||"")}</div>
<div class="c" style="margin:4px 0"><span class="badge">D-INVOICE</span></div>
${imgPos==="top"?imgHTML:""}
<div class="hr"/>
<div class="row" style="font-size:${dateSize}px"><span style="word-break:break-word">${_escHTML(order.displayNumber||order.id||"")}</span><span>${_escHTML(order.date||"")} ${_escHTML(order.time||"")}</span></div>
<div style="font-size:${fontSize-1}px;word-break:break-word">${_escHTML(order.type||"Sale")}${order.table?" · Table "+_escHTML(order.table):""}</div>
${(order.customer||order.customerPhone)?`<div style="font-size:${fontSize-1}px;word-break:break-word">Customer: ${_escHTML([order.customer,order.customerPhone].filter(Boolean).join(" · "))}</div>`:""}
${order.note?`<div style="font-size:${fontSize-1}px;font-style:italic;word-break:break-word">Note: ${_escHTML(order.note)}</div>`:""}
<div class="hr"/>
${items.map(it=>`<div class="item"><span class="nm">${it.nameAr?`<div style="direction:rtl;font-family:'Tahoma','Arial','Times New Roman',serif;font-weight:700;word-break:break-word;margin-bottom:${nameGap}px">${_escHTML(it.nameAr)}</div>`:""}<div>${it.qty}x ${_escHTML(it.name)}</div></span><span class="pr">SAR ${(it.qty*it.price).toFixed(2)}</span></div>`).join("")}
<div class="hr"/>
${order.discount>0?`<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${(order.vat||0).toFixed(2)}</span></div>
<div class="row b" style="font-size:${fontSize+2}px"><span>TOTAL</span><span>SAR ${(order.total||0).toFixed(2)}</span></div>
${order.payMethod==="Cash"?`<div class="row"><span>Cash</span><span>SAR ${(order.given||0).toFixed(2)}</span></div><div class="row"><span>Change</span><span>SAR ${(order.change||0).toFixed(2)}</span></div>`:""}
<div class="hr"/>
${imgPos==="bottom"?imgHTML:""}
<div class="c" style="font-size:${fontSize-1}px;word-break:break-word">${_escMultiline(footer)}</div>
${footerAr?`<div class="c" style="direction:rtl;font-family:'Tahoma','Arial','Segoe UI',sans-serif;font-size:${fontSize-1}px;word-break:break-word">${_escMultiline(footerAr)}</div>`:""}
<div class="c" style="font-size:9px;color:#aaa;margin-top:4px">DRAFT — Not a tax invoice</div>
${_brandingHTML(fmt)}
<br/><br/>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// PRESET INVOICE / DRAFT BUILDER  — 4 ready-made styles, fixed layout order
// Layout order (ALL styles, never changes):
//   Logo → Business name (Ar over En) → Address (Ar over En) → Mobile/Tel
//   → VAT/TRN → Invoice-type box → Token+OrderType box → Voucher No
//   → User/Date | Payment/Time → Items (Ar over En) → TOTAL/VAT/GRAND TOTAL
//   → Amount in words → Received/Balance → ZATCA QR → Footer
// Styles differ ONLY in visual treatment (boxes/borders/weights/spacing).
// preview === print: the same function feeds the live preview and the printer.
// ═══════════════════════════════════════════════════════════════════
const PRESET_STYLES=[
  {id:"s1",label:"Style 1 — Classic Boxed",desc:"Standard Saudi thermal receipt — boxed sections, monospace look."},
  {id:"s2",label:"Style 2 — Modern Band",desc:"Coloured header band with logo, clean body."},
  {id:"s3",label:"Style 3 — Minimal",desc:"No boxes, light dividers, airy spacing."},
  {id:"s4",label:"Style 4 — Bold Large",desc:"Big bold fonts, heavy separators — easy to read."},
  {id:"s5",label:"Style 5 — Minimal, Left Item Name",desc:"Same minimal look as Style 3. Item names: Arabic above English, both left-aligned, own sizes. Optional divider line between items."},
];
// Numbers → English words (riyal + halala) for "Amount in Words"
function _amountWords(num){
  num=Math.round((Number(num)||0)*100)/100;
  const riyal=Math.floor(num);const halala=Math.round((num-riyal)*100);
  const ones=["Zero","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
  const tens=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  function w(n){
    if(n<20)return ones[n];
    if(n<100)return tens[Math.floor(n/10)]+(n%10?" "+ones[n%10]:"");
    if(n<1000)return ones[Math.floor(n/100)]+" Hundred"+(n%100?" "+w(n%100):"");
    if(n<1000000)return w(Math.floor(n/1000))+" Thousand"+(n%1000?" "+w(n%1000):"");
    return w(Math.floor(n/1000000))+" Million"+(n%1000000?" "+w(n%1000000):"");
  }
  const rWords=w(riyal);
  const hWords=halala?w(halala):"Zero";
  return `${rWords} Riyal and ${hWords} Halala`;
}
// Bilingual stacked line: Arabic on top, English below (centered)
function _stack(ar,en,fs,gap){
  const a=ar?`<div style="direction:rtl;font-family:'Tahoma','Arial','Segoe UI','Noto Naskh Arabic',sans-serif;font-size:${fs}px;font-weight:bold;word-break:break-word;line-height:1.5">${_escHTML(ar)}</div>`:"";
  const e=en?`<div style="font-size:${fs}px;font-weight:700;word-break:break-word;margin-top:${gap}px">${_escHTML(en)}</div>`:"";
  return a+e;
}
// ── "Powered by RestoPOS ©" branding line ──────────────────────────────
// Appears at the very bottom of EVERY print (invoice, draft, KOT, report),
// very small, and the size is adjustable per preset type via fmt.brandFont.
// Pass the per-type fmt so each preset can set its own size; falls back to 8px.
function _brandingHTML(fmt){
  const sz=(fmt&&parseInt(fmt.brandFont))||8;
  // brandShow defaults to true; only an explicit false hides it.
  if(fmt&&fmt.brandShow===false)return "";
  return `<div style="text-align:center;font-size:${sz}px;color:#000;opacity:0.75;margin-top:6px;font-family:'Arial','Tahoma',sans-serif;font-weight:400;letter-spacing:0.2px">Powered by RestoPOS &copy;</div>`;
}
// Injects the branding line right before the closing </body> of a finished HTML doc.
function _withBranding(html,fmt){
  if(typeof html!=="string")return html;
  const brand=_brandingHTML(fmt);
  if(!brand)return html;
  if(html.includes("</body>"))return html.replace("</body>",brand+"</body>");
  return html+brand;
}
// Arabic-safe inline span — forces a real Arabic font + isolation so glyphs never collapse/box
const _AR_FONT="'Tahoma','Arial','Segoe UI','Noto Naskh Arabic',sans-serif";
function _arSpan(text,extra){return `<span style="display:inline-block;direction:rtl;font-family:${_AR_FONT};font-weight:bold${extra?";"+extra:""}">${_escHTML(text)}</span>`;}
function _arBlock(text,fs,extra){return `<div style="direction:rtl;font-family:${_AR_FONT};font-weight:bold;font-size:${fs}px;line-height:1.5${extra?";"+extra:""}">${_escHTML(text)}</div>`;}
// ── REPORT (Day Summary / Category Sales) thermal preset ──────────────
// Default settings for the thermal sales report. Kept small & paper-safe.
const REPORT_DEFAULTS={
  paperWidth:"80mm",
  headFont:14,      // business name / title
  metaFont:11,      // date range, user line
  rowFont:13,       // category name + numbers
  totalFont:13,     // totals block
  lineGap:4,        // vertical space between category rows
  colQty:28,        // (legacy, unused by new table layout)
  colTax:42,        // (legacy)
  colAmt:48,        // (legacy)
  nameGap:4,        // (legacy)
  rowLayout:"stacked", // "stacked" (name row + numbers row, like reference) or "inline"
  colLines:false,   // draw vertical divider lines between Qty | Tax | Amount
  printerDots:576,  // exact printable dot width of the thermal head (80mm=576, 58mm=384)
  showQty:true,
  showTax:true,
  showAmount:true,
  showPurchase:false,   // Total Purchase / Purchase Tax lines (usually 0 for restaurants)
  showCardCash:true,    // Card / Cash / Credit split
  showDiscount:true,
  bold:700,
  lineChars:40,     // characters per line (40 for 80mm fits with margin; lower if left edge clips)
  brandFont:8,
  brandShow:true,
};
// Builds the inner thermal report body as MONOSPACE fixed-character columns.
// Why monospace: thermal printers and QZ's renderer clip overflowing CSS, but a
// monospace <pre> block with a fixed character count per line physically cannot
// overflow — every column is N characters wide, padded/truncated to fit the paper.
// Shared by the live preview and the real print, so preview === print.
// fmt extra keys used by presets:
//   presetStyle (s1..s4), logoUrl, logoSize, headFont (header px), bodyFont (body px),
//   totalFont (totals px), lineGap (item spacing px), headerColor (s2), paperWidth
export function buildPresetHTML(order,license,zatcaInvoice,fmt,qrImgSrc,opts){
  fmt=fmt||{};order=order||{};opts=opts||{};
  const isDraft=!!opts.draft;
  const style=fmt.presetStyle||"s1";
  const paperWidth=fmt.paperWidth||"80mm";
  const headFont=parseInt(fmt.headFont)||14;
  const bodyFont=parseInt(fmt.bodyFont)||12;
  const totalFont=parseInt(fmt.totalFont)||16;
  const tokenFont=parseInt(fmt.tokenFont)||22;
  const lineGap=fmt.lineGap!==undefined?parseInt(fmt.lineGap):3;
  const nameGap=2;
  const logoSize=parseInt(fmt.logoSize)||60;
  const qrSize=parseInt(fmt.qrSize)||120;
  const headerColor=fmt.headerColor||"#000000";
  const items=order.items||[];
  // ── per-section font weights (thickness) — client adjustable ──
  const wItems =parseInt(fmt.weightItems )||700;
  const wMeta  =parseInt(fmt.weightMeta  )||600;   // voucher / user / date / time
  const wToken =parseInt(fmt.weightToken )||900;
  const wTotal =parseInt(fmt.weightTotal )||900;
  // identity
  const shopEn=fmt.shopNameOverride||license?.businessName||"Restaurant";
  const shopAr=fmt.shopNameAr||license?.businessNameAr||"";
  const addrEn=fmt.addressEnOverride||license?.address||"";
  const addrAr=fmt.addressAr||license?.addressAr||"";
  const extraInfo=fmt.extraInfo||"";        // optional info line (between name & tel)
  const extraInfoAr=fmt.extraInfoAr||"";
  const hasLogo=!!fmt.logoUrl;
  const phone=fmt.phoneOverride||license?.phone||"";
  const vatNo=license?.vatNumber||"";
  const footer=fmt.footer||"Thank you — visit again";
  const footerAr=fmt.footerAr||"شكراً لك زيارة مرة أخرى";
  // monospace look for s1; serif for others — Arabic fonts ALWAYS included as fallback
  // Style 5 = Style 3's minimal treatment (no boxes, light solid dividers) + its own item-name layout
  const bodyFamily=style==="s1"?"'Courier New','Tahoma','Arial',monospace":"'Tahoma','Arial','Amiri',serif";
  const sepLine=style==="s4"?"2px solid #000":(style==="s3"||style==="s5")?"1px solid #000":"1px dashed #000";
  const SEP=`<div style="border-top:${sepLine};margin:5px 0"></div>`;
  const boxed=(inner,big)=>{
    if(style==="s3"||style==="s5")return `<div style="text-align:center;margin:4px 0">${inner}</div>`;
    const bw=style==="s4"?"2px solid #000":"1px solid #000";
    return `<div style="border:${bw};border-radius:${style==="s2"?"6px":"2px"};padding:${big?"7px":"5px"} 6px;margin:4px 0;text-align:center">${inner}</div>`;
  };
  const logoHTML=hasLogo?`<img src="${_escHTML(fmt.logoUrl)}" style="max-width:100%;max-height:${logoSize}px;display:block;margin:0 auto 5px"/>`:"";
  // ── HEADER (logo → name → extra info → address → tel → vat) ──
  // Business name: if a logo is present, the name is OPTIONAL (only shown if entered).
  // If NO logo, the English name is required → always shown (falls back to license name).
  let nameBlock="";
  if(hasLogo){
    // optional — show only what the client actually typed
    nameBlock=_stack(fmt.shopNameAr||"", fmt.shopNameOverride||"", headFont, nameGap);
  }else{
    nameBlock=_stack(shopAr, shopEn, headFont, nameGap);
  }
  const extraBlock=(extraInfo||extraInfoAr)
    ? `<div style="margin-top:3px">${extraInfoAr?_arBlock(extraInfoAr,bodyFont-1):""}${extraInfo?`<div style="font-size:${bodyFont-1}px;font-weight:600">${_escHTML(extraInfo)}</div>`:""}</div>`
    : "";
  const addrBlock=(addrEn||addrAr)?`<div style="margin-top:3px">${_stack(addrAr,addrEn,bodyFont-1,1)}</div>`:"";
  const telBlock=phone?`<div style="font-size:${bodyFont-1}px;margin-top:2px">${_arSpan("هاتف")} / Tel: ${_escHTML(phone)}</div>`:"";
  const vatBlock=vatNo?`<div style="font-size:${bodyFont-1}px;margin-top:2px">${_arSpan("الرقم الضريبي")} / VAT: ${_escHTML(vatNo)}</div>`:"";
  const headBlock=`${nameBlock}${extraBlock}${addrBlock}${telBlock}${vatBlock}`;
  let header="";
  if(style==="s2"){
    header=`<div style="background:${headerColor};color:#fff;margin:-4mm -4mm 8px;padding:10px 8px;text-align:center;border-radius:0 0 8px 8px" class="s2head">${logoHTML}${headBlock}</div>`;
  }else{
    header=`<div style="text-align:center">${logoHTML}${headBlock}</div>`;
  }
  // ── INVOICE TYPE BOX ──
  const typeBox=boxed(`${_arBlock("فاتورة ضريبية مبسطة",bodyFont)}<div style="font-weight:900;font-size:${headFont}px">Simplified Tax Invoice</div>`,true);
  // Optional divider AFTER the Simplified Tax Invoice box (toggle: lineAfterTitle)
  const lineAfterTitle=fmt.lineAfterTitle?SEP:"";
  // ── TOKEN + ORDER TYPE BOX (smart labels: Parcel / Dine in / Telephone) ──
  const _isPhone=order.billType==="telephone";
  const _typeEn=order.type==="Takeaway"?"Parcel":order.type==="Dine-in"?"Dine in":order.type==="Delivery"?"Delivery":(order.type||"Parcel");
  const orderTypeAr=order.type==="Takeaway"?"سفري":order.type==="Dine-in"?"محلي":order.type==="Delivery"?"توصيل":"سفري";
  // Telephone line above the token box when it's a phone order.
  // Optional: wrap the telephone line in a box (toggle: phoneInBox)
  const _phoneInner=`<div style="text-align:center;font-weight:900;font-size:${headFont}px;margin:3px 0">Telephone</div>`;
  const _phoneLine=_isPhone?(fmt.phoneInBox?boxed(_phoneInner,true):_phoneInner):"";
  const tokenBox=_phoneLine+boxed(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-weight:${wToken};font-size:${tokenFont}px">Token No: ${_escHTML(order.token||order.kot||"—")}</span><span style="display:flex;align-items:center;gap:6px"><span style="font-weight:900;font-size:${tokenFont}px">${_escHTML(_typeEn)}</span>${_arSpan(orderTypeAr,"font-size:"+tokenFont+"px")}</span></div>`);
  // Optional divider AFTER the Token box (toggle: lineAfterToken)
  const lineAfterToken=fmt.lineAfterToken?SEP:"";
  // ── VOUCHER ──
  const voucher=`<div style="text-align:center;font-size:${bodyFont}px;font-weight:${wMeta};margin:3px 0">Voucher No: ${_escHTML(order.voucher||order.id||"")}</div>`;
  // ── CUSTOMER (was missing entirely from the preset builder — now included) ──
  const customerBlock=(fmt.showCustomer!==false&&(order.customer||order.customerPhone))
    ? `<div style="text-align:center;font-size:${bodyFont-1}px;font-weight:${wMeta};margin:2px 0;word-break:break-word">Customer: ${_escHTML([order.customer,order.customerPhone].filter(Boolean).join(" · "))}</div>`
    : "";
  // ── USER/DATE | PAYMENT/TIME ──
  const metaGrid=`<div style="display:flex;justify-content:space-between;font-size:${bodyFont-1}px;font-weight:${wMeta};margin:3px 0;gap:8px">
    <div style="text-align:left"><div>User: ${_escHTML(order.user||"admin")}</div><div>Date: ${_escHTML(order.date||"")}</div></div>
    <div style="text-align:right"><div>Payment: ${_escHTML(order.payMethod||"CASH")}</div><div>Time: ${_escHTML(order.time||"")}</div></div>
  </div>`;
  // ── ITEMS TABLE ──
  const th=`<div style="display:flex;font-weight:900;font-size:${bodyFont}px;border-bottom:${sepLine};padding-bottom:3px;margin-bottom:3px">
    <span style="flex:1 1 auto">ProductName</span><span style="width:34px;text-align:right">Qty</span><span style="width:44px;text-align:right">Rate</span><span style="width:54px;text-align:right">Amount</span></div>`;
  // Style 5: item name stacked Arabic-over-English, LEFT-ALIGNED, each line its own size & gap.
  // Optional thin divider between each item pair — settings toggle (fmt.itemDivider).
  const itemFontEn=parseInt(fmt.itemFontEn)||bodyFont;
  const itemFontAr=parseInt(fmt.itemFontAr)||bodyFont;
  const itemNameGap=fmt.itemNameGap!==undefined?parseInt(fmt.itemNameGap):3;
  const itemDividerOn=style==="s5"&&!!fmt.itemDivider;
  const itemDividerHTML=`<div style="border-top:1px dashed #000;margin:${Math.max(2,lineGap)}px 0"></div>`;
  const rows=items.map((it,idx)=>{
    let ar="",en="";
    if(style==="s5"){
      ar=it.nameAr?`<div style="text-align:left;direction:rtl;font-family:${_AR_FONT};font-weight:bold;font-size:${itemFontAr}px;word-break:break-word;line-height:1.4">${_escHTML(it.nameAr)}</div>`:"";
      en=`<div style="text-align:left;font-size:${itemFontEn}px;font-weight:700;word-break:break-word;margin-top:${itemNameGap}px">${_escHTML(it.name)}</div>`;
    }else{
      ar=it.nameAr?_arBlock(it.nameAr,bodyFont,"word-break:break-word"):"";
      en=`<div style="font-size:${bodyFont}px;word-break:break-word">${_escHTML(it.name)}</div>`;
    }
    const divider=(itemDividerOn&&idx<items.length-1)?itemDividerHTML:"";
    return `<div style="margin:${lineGap}px 0;font-weight:${wItems}">
      ${ar}${en}
      <div style="display:flex;font-size:${bodyFont}px;margin-top:1px">
        <span style="flex:1 1 auto"></span>
        <span style="width:34px;text-align:right">${(it.qty||0).toFixed(2)}</span>
        <span style="width:44px;text-align:right">${(it.price||0).toFixed(2)}</span>
        <span style="width:54px;text-align:right">${((it.qty||0)*(it.price||0)).toFixed(2)}</span>
      </div></div>${divider}`;
  }).join("");
  const itemsHTML=th+rows;
  // ── TOTALS ──
  const subtotal=(order.total||0)-(order.vat||0);
  const totalsHTML=`
    <div style="display:flex;justify-content:space-between;font-size:${bodyFont}px;font-weight:${wMeta};margin:2px 0"><span>${_arSpan("(مجموع)")} TOTAL</span><span>${subtotal.toFixed(2)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:${bodyFont}px;font-weight:${wMeta};margin:2px 0"><span>${_arSpan("(ضريبة)")} VAT 15%</span><span>${(order.vat||0).toFixed(2)}</span></div>
    <div style="display:flex;justify-content:space-between;font-weight:${wTotal};font-size:${totalFont}px;border-top:${style==="s4"?"3px double #000":"2px solid #000"};padding-top:4px;margin-top:3px"><span>${_arSpan("(المجموع الإجمالي)")} GRAND TOTAL</span><span>${(order.total||0).toFixed(2)}</span></div>`;
  // ── AMOUNT IN WORDS + RECEIVED/BALANCE ──
  const wordsHTML=`<div style="font-size:${bodyFont-1}px;font-style:italic;margin:5px 0;word-break:break-word">Amount in Words: ${_amountWords(order.total||0)}</div>`;
  const payHTML=`
    <div style="display:flex;justify-content:space-between;font-size:${bodyFont-1}px"><span>Received by ${_escHTML(order.payMethod||"Cash")} ${_arSpan("(تلقى النقدية)")}</span><span>${(order.given||order.total||0).toFixed(2)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:${bodyFont-1}px"><span>Balance ${_arSpan("(توازن)")}</span><span>${(order.change||0).toFixed(2)}</span></div>`;
  // ── ZATCA QR (not on draft) ──
  const qrBlock=(!isDraft&&qrImgSrc)
    ? `<div style="text-align:center;margin:8px 0"><img src="${qrImgSrc}" style="width:${qrSize}px;height:${qrSize}px;max-width:100%;display:block;margin:4px auto"/>${zatcaInvoice?.invoice_number?`<div style="font-size:${bodyFont-3}px;color:#000">Invoice: ${_escHTML(zatcaInvoice.invoice_number)}${zatcaInvoice.icv?" · ICV: "+_escHTML(zatcaInvoice.icv):""}</div>`:""}<div style="font-size:${bodyFont-4}px;color:#000">ZATCA Phase 2 · Scan to verify</div></div>`
    : "";
  const footerHTML=`<div style="text-align:center;margin-top:6px">
    ${footerAr?_arBlock("*** "+footerAr+" ***",bodyFont):""}
    ${footer?`<div style="font-weight:700;font-size:${bodyFont}px;margin-top:2px">${_escHTML(footer)}</div>`:""}
    ${isDraft?`<div style="font-weight:900;font-size:${bodyFont}px;margin-top:4px">D-Bill</div>`:""}
  </div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Amiri:wght@400;700&family=Cairo:wght@400;700&family=Tajawal:wght@400;700&display=swap" rel="stylesheet">
<style>
@page{size:${paperWidth} auto;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:${paperWidth};overflow-x:hidden}
body{font-family:${bodyFamily};font-size:${bodyFont}px;width:${paperWidth};padding:4mm;color:#000;background:#fff;line-height:1.4;word-break:break-word;overflow-wrap:anywhere;font-weight:600;-webkit-print-color-adjust:exact;print-color-adjust:exact}
*{color:#000 !important}
.s2head, .s2head *{color:#fff !important}
img{max-width:100%}
</style></head><body>
${header}
${typeBox}
${lineAfterTitle}
${tokenBox}
${lineAfterToken}
${voucher}
${customerBlock}
${SEP}
${metaGrid}
${SEP}
${itemsHTML}
${SEP}
${totalsHTML}
${wordsHTML}
${payHTML}
${SEP}
${qrBlock}
${footerHTML}
${_brandingHTML(fmt)}
<br/><br/>
</body></html>`;
}
// KOT preset builder — 4 styles, kitchen ticket matching the reference layout:
// name → "Telephone Bill" → Voucher/Date/Time → boxed Token + order-type
// → ProductName|Rate|Qty table (item Ar over En, per-item price) → QTY total.
export function buildPresetKOT(order,fmt){
  fmt=fmt||{};order=order||{};
  const style=fmt.presetStyle||"s1";
  const paperWidth=fmt.paperWidth||"80mm";
  const headFont=parseInt(fmt.headFont)||20;
  const bodyFont=parseInt(fmt.bodyFont)||16;
  // Separate item-text sizes for English and Arabic (each its own slider).
  // Fall back to bodyFont if not set, so existing presets are unchanged.
  const bodyFontEn=parseInt(fmt.bodyFontEn)||bodyFont;
  const bodyFontAr=parseInt(fmt.bodyFontAr)||bodyFont;
  const tokenFont=parseInt(fmt.tokenFont)||28;
  const lineGap=fmt.lineGap!==undefined?parseInt(fmt.lineGap):4;
  const logoSize=parseInt(fmt.logoSize)||50;
  const boxPad=parseInt(fmt.kotBoxPad)||6;       // box padding (client adjustable)
  // per-section weights
  const wItems =parseInt(fmt.weightItems )||800;
  const wMeta  =parseInt(fmt.weightMeta  )||700;
  const wToken =parseInt(fmt.weightToken )||900;
  const items=order.items||[];
  // Arabic ALWAYS in fallback stack so KOT never collapses
  const bodyFamily=style==="s1"?"'Courier New','Tahoma','Arial',monospace":"'Tahoma','Arial','Amiri',sans-serif";
  const sepLine=style==="s4"?"2px solid #000":style==="s3"?"1px solid #000":"1px dashed #000";
  const SEP=`<div style="border-top:${sepLine};margin:6px 0"></div>`;
  const logoHTML=fmt.logoUrl?`<img src="${_escHTML(fmt.logoUrl)}" style="max-width:100%;max-height:${logoSize}px;display:block;margin:0 auto 5px"/>`:"";
  const kShopEn=fmt.shopNameOverride||"";
  const kShopAr=fmt.shopNameAr||"";
  const nameHTML=(kShopEn||kShopAr)?`<div style="text-align:center;margin-bottom:4px">${kShopAr?_arBlock(kShopAr,bodyFont):""}${kShopEn?`<div style="font-weight:700;font-size:${bodyFont}px">${_escHTML(kShopEn)}</div>`:""}</div>`:"";
  // ── SMART KOT TITLE ──
  // Telephone bill → "Telephone" line first. Then the order-type line:
  //   Takeaway → Parcel ,  Dine-in → Dine in ,  Delivery → Delivery
  const isPhone=order.billType==="telephone";
  const typeEn=order.type==="Takeaway"?"Parcel":order.type==="Dine-in"?"Dine in":order.type==="Delivery"?"Delivery":(order.type||"Parcel");
  const typeAr=order.type==="Takeaway"?"سفري":order.type==="Dine-in"?"محلي":order.type==="Delivery"?"توصيل":"سفري";
  // Title block — phone shows "Telephone" line above the type box
  const phoneLine=isPhone?`<div style="text-align:center;font-weight:900;font-size:${headFont}px;margin:2px 0">${style==="s2"?`<span class="kbadge" style="background:#000;color:#fff;padding:3px 14px;border-radius:4px">Telephone</span>`:"Telephone"}</div>`:"";
  // Voucher + Date/Time row
  const vdt=`<div style="display:flex;justify-content:space-between;align-items:flex-end;font-size:${bodyFont-4}px;font-weight:${wMeta};margin:3px 0;gap:8px">
    <div style="font-weight:${wMeta}">Voucher No: ${_escHTML(order.voucher||order.id||"")}</div>
    <div style="text-align:right"><div>Date: ${_escHTML(order.date||"")}</div><div>Time: ${_escHTML(order.time||new Date().toLocaleTimeString("en-SA"))}</div></div>
  </div>`;
  // Token + order-type box
  const tokenBox=`<div style="margin:5px 0">
    <div style="font-weight:${wToken};font-size:${tokenFont}px;margin-bottom:3px">Token No: ${_escHTML(order.token||order.kot||"")}</div>
    <div style="border:${style==="s4"?"2px":"1px"} solid #000;border-radius:${style==="s2"?"6px":"2px"};padding:${boxPad}px ${boxPad+2}px;display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span style="font-weight:900;font-size:${tokenFont}px">${_escHTML(typeEn)} -</span>
      ${_arSpan(typeAr,"font-size:"+tokenFont+"px;font-weight:900")}
    </div>
  </div>`;
  // Items table header
  const th=`<div style="display:flex;font-weight:900;font-size:${bodyFont-2}px;border-bottom:${sepLine};padding-bottom:3px;margin-bottom:4px">
    <span style="flex:1 1 auto">ProductName</span><span style="width:54px;text-align:right">Rate</span><span style="width:34px;text-align:right">Qty</span></div>`;
  let totalQty=0;
  // Style 5: item name Arabic-over-English, fully LEFT-aligned, own sizes + gap (matches Invoice Style 5).
  const kItemFontEn=parseInt(fmt.itemFontEn)||bodyFontEn;
  const kItemFontAr=parseInt(fmt.itemFontAr)||bodyFontAr;
  const kItemNameGap=fmt.itemNameGap!==undefined?parseInt(fmt.itemNameGap):3;
  const rows=items.map(it=>{
    totalQty+=(it.qty||0);
    const descLine=(it.descriptions&&it.descriptions.length>0)?`<div style="font-size:${bodyFontEn-4}px;font-style:italic;color:#333;padding-left:6px;margin-top:1px">↳ ${it.descriptions.map(_escHTML).join(", ")}</div>`:"";
    let nameHTML2;
    if(style==="s5"){
      const ar5=it.nameAr?`<div style="text-align:left;direction:rtl;font-family:${_AR_FONT};font-weight:bold;font-size:${kItemFontAr}px;word-break:break-word;line-height:1.4">${_escHTML(it.nameAr)}</div>`:"";
      const en5=`<div style="text-align:left;font-size:${kItemFontEn}px;font-weight:700;word-break:break-word;margin-top:${kItemNameGap}px">${_escHTML(it.name)}</div>`;
      nameHTML2=ar5+en5;
    }else{
      const ar=it.nameAr?_arBlock(it.nameAr,bodyFontAr):"";
      nameHTML2=`${ar}<div style="font-size:${bodyFontEn}px">${_escHTML(it.name)}</div>`;
    }
    return `<div style="margin:${lineGap}px 0;font-weight:${wItems}">
      ${nameHTML2}
      <div style="display:flex;font-size:${bodyFontEn}px;margin-top:1px">
        <span style="flex:1 1 auto"></span>
        <span style="width:54px;text-align:right">${(it.price||0).toFixed(2)}</span>
        <span style="width:34px;text-align:right">${(it.qty||0)}</span>
      </div>${descLine}</div>`;
  }).join("");
  const qtyTotal=`<div style="display:flex;justify-content:space-between;font-weight:900;font-size:${headFont-2}px;margin-top:4px"><span>QTY</span><span>: ${totalQty.toFixed(2)}</span></div>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Amiri:wght@400;700&family=Cairo:wght@400;700&family=Tajawal:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:${paperWidth} auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}
html,body{max-width:${paperWidth};overflow-x:hidden}
body{font-family:${bodyFamily};font-size:${bodyFont}px;width:${paperWidth};padding:4mm;color:#000;background:#fff;line-height:1.35;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact}
*{color:#000 !important}
.kbadge,.kbadge *{color:#fff !important}
img{max-width:100%}</style></head><body>
${logoHTML}
${nameHTML}
${phoneLine}
${vdt}
${tokenBox}
${SEP}
${th}
${rows}
${SEP}
${qtyTotal}
<div style="height:24px"></div>
${order.kotOnly?`<div style="text-align:center;font-weight:900;font-size:${headFont}px;border-top:2px solid #000;padding-top:8px;margin-top:4px">KOT ONLY</div>`:""}
<div style="text-align:center;font-size:${bodyFont-5}px">. . .</div>
${_brandingHTML(fmt)}
<br/><br/><br/></body></html>`;
}
// Unified KOT HTML — uses saved KOT preset if active, else the legacy compact ticket.
// order: {kot, type, table, time, items:[{name,nameAr,qty}]}
export function buildKOTHtml(order){
  const kfmt=(typeof LS!=="undefined"&&LS.get&&LS.get("restopos_kot_format"))||{};
  // Preview always renders buildPresetKOT, so the PRINT must too whenever a
  // preset style is configured — otherwise preview≠print. We use the preset if
  // a style is set OR presets are explicitly enabled (default behaviour).
  if(kfmt.presetStyle||kfmt.usePreset){
    return buildPresetKOT(order,{presetStyle:"s1",...kfmt});
  }
  const it2=order.items||[];
  // Smart KOT title rules (work even without preset):
  // Takeaway→Parcel, Dine-in→Dine in, Delivery→Delivery; Phone orders add a "Telephone" line on top.
  const _isPhone=order.billType==="telephone";
  const _typeEn=order.type==="Takeaway"?"Parcel":order.type==="Dine-in"?"Dine in":order.type==="Delivery"?"Delivery":(order.type||"Parcel");
  const _typeAr=order.type==="Takeaway"?"سفري":order.type==="Dine-in"?"محلي":order.type==="Delivery"?"توصيل":"سفري";
  const _phoneLine=_isPhone?`<div class="big" style="font-size:20px">Telephone</div>`:"";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:80mm auto;margin:0}body{font-family:'Courier New',monospace;font-size:15px;width:80mm;padding:4mm}.big{font-size:22px;font-weight:900;text-align:center}.hr{border:none;border-top:1px dashed #000;margin:6px 0}.ar{direction:rtl;font-family:'Tahoma','Arial','Segoe UI',sans-serif;font-weight:bold;line-height:1.5}.tbox{border:1px solid #000;border-radius:2px;padding:6px;display:flex;justify-content:space-between;align-items:center;margin:5px 0}.desc{font-size:11px;font-style:italic;color:#333;padding-left:8px;margin-top:2px}</style></head><body><div class="big" style="font-size:16px">Token No: ${_escHTML(order.token||order.kot||"")}</div>${_phoneLine}<div class="tbox"><span class="big" style="font-size:20px">${_escHTML(_typeEn)} -</span><span class="ar big" style="font-size:20px">${_escHTML(_typeAr)}</span></div><div style="font-size:11px">${_escHTML(order.time||new Date().toLocaleTimeString("en-SA"))}${order.table?" · Table "+_escHTML(order.table):""}</div><div class="hr"></div>${it2.map(it=>`<div style="font-weight:800;font-size:17px">${it.qty}x ${_escHTML(it.name)}</div>${it.nameAr?`<div class="ar">${_escHTML(it.nameAr)}</div>`:""}${(it.descriptions&&it.descriptions.length>0)?`<div class="desc">↳ ${it.descriptions.map(_escHTML).join(", ")}</div>`:""}`).join("")}<div class="hr"></div><div style="text-align:center;font-size:11px">Kitchen Copy</div>${order.kotOnly?`<div style="text-align:center;font-weight:900;font-size:16px;margin-top:8px;border-top:2px solid #000;padding-top:6px">KOT ONLY</div>`:""}</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════
// DRAFT RECEIPT PRINT — no ZATCA QR, shows D-Invoice label
// ═══════════════════════════════════════════════════════════════════
export function printDraftReceipt(order,license){
  // Use the separate draft format (falls back to main format keys if unset) + unified builder.
  const draftFmt=LS.get("restopos_draft_format")||LS.get("restopos_invoice_format")||{};
  const html=buildDraftReceiptHTML(order,license,draftFmt);
  let frame=document.getElementById("restopos-print-frame");
  if(!frame){
    frame=document.createElement("iframe");
    frame.id="restopos-print-frame";
    frame.style.cssText="position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:none;";
    document.body.appendChild(frame);
  }
  const fdoc=frame.contentDocument||frame.contentWindow.document;
  fdoc.open();fdoc.write(html);fdoc.close();
  setTimeout(()=>{try{frame.contentWindow.focus();frame.contentWindow.print();}catch(e){console.warn("[draft print]",e);}},500);
}

// ═══════════════════════════════════════════════════════════════════
// POS SCREEN
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// TRIAL RECEIPT STAMP
// A trial receipt carries a real-looking ZATCA QR, but the account has no
// CSID and nothing is reported to FATOORA, so it must never be mistakable
// for a tax invoice. Every printed/previewed document gets a header and
// footer saying so. Applied by wrapping the builders once, at module load,
// rather than threading a flag through all of them.
// ═══════════════════════════════════════════════════════════════════
import { isTrial } from "../trial.js";

const TRIAL_STAMP_MARK = "restopos-trial-stamp";
function trialStampHTML(html){
  if(typeof html!=="string"||html.includes(TRIAL_STAMP_MARK))return html;
  const bar=(txt)=>`<div class="${TRIAL_STAMP_MARK}" style="text-align:center;font-family:'Courier New',monospace;font-size:11px;font-weight:bold;color:#000;border:2px dashed #000;padding:4px 2px;margin:4px 0;line-height:1.35">${txt}</div>`;
  const top=bar("*** TRIAL RECEIPT ***<br/>NOT A VALID TAX INVOICE<br/>إيصال تجريبي — ليست فاتورة ضريبية");
  const bottom=bar("RestoPOS free trial.<br/>Not reported to ZATCA.");
  let out=html;
  if(out.includes("<body"))out=out.replace(/(<body[^>]*>)/i,`$1${top}`);
  else out=top+out;
  if(out.includes("</body>"))out=out.replace("</body>",bottom+"</body>");
  else out=out+bottom;
  return out;
}
// These are exported function declarations in this module, so reassigning them
// here updates the live export bindings every importer sees.
if(isTrial()){
  const _rcpt=buildReceiptHTML,_preset=buildPresetHTML,_draft=buildDraftReceiptHTML,_kot=buildKOTHtml,_pkot=buildPresetKOT;
  // trialStampHTML is idempotent, so builders that delegate to each other
  // (buildReceiptHTML → buildPresetHTML) stamp exactly once.
  buildReceiptHTML=(...a)=>trialStampHTML(_rcpt(...a));
  buildPresetHTML=(...a)=>trialStampHTML(_preset(...a));
  buildDraftReceiptHTML=(...a)=>trialStampHTML(_draft(...a));
  buildKOTHtml=(...a)=>trialStampHTML(_kot(...a));
  buildPresetKOT=(...a)=>trialStampHTML(_pkot(...a));
}
