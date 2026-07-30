// ═══════════════════════════════════════════════════════════════════
// REPORT THERMAL HTML — builds the thermal-printer HTML for the sales
// report/day summary. Extracted verbatim from App.jsx; logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { t } from "../i18n/index.js";
import { _escHTML } from "./html.js";

export function buildReportThermalHTML(data,lic,rfmt){
  data=data||{};lic=lic||{};
  const f={...REPORT_DEFAULTS,...(rfmt||{})};
  const narrow=(f.paperWidth||"80mm")==="58mm";
  // Total characters per line. The printable area is narrower than the nominal
  // paper, so we use a value that fits with margin on BOTH sides (left was getting
  // clipped at 42). Adjustable via the "Characters per line" control.
  const LINE=parseInt(f.lineChars)||(narrow?30:40);
  const rowF=parseInt(f.rowFont)|| (narrow?12:13);
  const totals=data.totals||{};
  const cats=data.catList||[];
  const money=n=>(Number(n)||0).toFixed(2);
  // column widths in characters (right-aligned numbers)
  const wQty=f.showQty?5:0;
  const wTax=f.showTax?9:0;
  const wAmt=f.showAmount?10:0;
  const wName=LINE-wQty-wTax-wAmt;
  const padL=(s,n)=>{s=String(s);return s.length>=n?s.slice(0,n):" ".repeat(n-s.length)+s;};
  const padR=(s,n)=>{s=String(s);return s.length>=n?s.slice(0,n):s+" ".repeat(n-s.length);};
  const esc=s=>_escHTML(String(s==null?"":s));
  // numbers segment (right-aligned, fixed widths) — identical for header & rows
  const numSeg=(q,t,a)=>(f.showQty?padL(q,wQty):"")+(f.showTax?padL(t,wTax):"")+(f.showAmount?padL(a,wAmt):"");
  const headerLine=padR("ProductName",wName)+numSeg("Qty","Tax","Amount");
  const sep="-".repeat(LINE);
  const dsep="=".repeat(LINE);
  // Each category: if the name fits on the same line as numbers, one line.
  // If the name is long, print the full name on its own line, then numbers right-aligned below.
  const bodyLines=cats.map(c=>{
    const name=esc(c.cat||"");
    const nums=numSeg(c.qty||0,money(c.tax),money(c.revenue));
    if(name.length<=wName-1){
      return padR(name,wName)+nums;
    }
    // long name → wrap: name line(s), then a line with numbers right-aligned
    return name+"\n"+padL(nums,LINE);
  }).join("\n");
  // totals — label left, value right, within LINE chars
  const tLine=(label,val,strong)=>{
    const v=money(val);
    const txt=padR(label,LINE-v.length)+v;
    return strong?`<span style="font-weight:900">${txt}</span>`:txt;
  };
  const totalsBlock=[
    f.showPurchase?tLine("Total Purchase:",totals.purchase||0):null,
    tLine("Total Sales:",totals.sales||0),
    f.showTax?tLine("Total Sales Tax:",totals.salesTax||0):null,
    f.showPurchase?tLine("Total Purchase Tax:",totals.purchaseTax||0):null,
    f.showPurchase?tLine("(Sales Tax-Purch Tax):",(totals.salesTax||0)-(totals.purchaseTax||0)):null,
    f.showCardCash?tLine("Total Card Sales:",totals.card||0):null,
    f.showCardCash?tLine("Total Cash Sale:",totals.cash||0):null,
    f.showCardCash?tLine("Total Credit Sale:",totals.credit||0):null,
    f.showDiscount?tLine("Total Discount:",totals.discount||0):null,
    tLine("Total Payment:",totals.payment||0),
    tLine("Balance:",totals.balance||0,true),
  ].filter(Boolean).join("\n");
  // Header block (centered shop name in Arabic, date/user) sits above the monospace table.
  const head=`
<div style="text-align:center;direction:rtl;font-family:${_AR_FONT};font-weight:bold;font-size:${f.headFont}px;margin-bottom:2px">${esc(lic.businessNameAr||lic.businessName||"")}</div>
${(lic.addressAr||lic.address)?`<div style="text-align:center;direction:rtl;font-family:${_AR_FONT};font-size:${f.metaFont}px;margin-bottom:3px">${esc(lic.addressAr||lic.address)}</div>`:""}
<div style="text-align:center;font-size:${f.metaFont}px;font-weight:700;margin-bottom:2px">${esc(data.dateRange||data.date||"")}</div>
${(data.timeRange&&!/[0-9]:[0-9]/.test(data.dateRange||""))?`<div style="text-align:center;font-size:${f.metaFont}px;margin-bottom:3px">${esc(data.timeRange)}</div>`:""}
<div style="font-size:${f.metaFont}px;margin-bottom:2px">User : ${esc(data.user||"admin")}</div>`;
  // The whole table + totals as one monospace <pre> — guaranteed to fit the paper.
  const pre=`<pre style="font-family:'Courier New',monospace;font-size:${rowF}px;font-weight:${f.bold};line-height:1.3;margin:0;white-space:pre;letter-spacing:0;overflow:hidden">${headerLine}
${dsep}
${bodyLines}
${dsep}
${totalsBlock}</pre>`;
  return head+pre;
}
