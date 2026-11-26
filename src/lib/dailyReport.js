// ═══════════════════════════════════════════════════════════════════
// DAILY REPORT — one calendar day (00:00–23:59) distilled to the totals a
// merchant and ZATCA care about: sales revenue, output VAT, purchases, input
// VAT and the NET VAT payable, plus payment- and category-breakdowns. No
// per-invoice list — just the figures. The POS auto-saves one of these per past
// day and lists them in Reports, each viewable/printable (browser "Save as PDF").
//
// Pure: no DOM, no React, no Firestore. Same VAT math as the rest of the app
// (lib/tax.js) and the same purchase signing (lib/purchases.js), so the numbers
// match the live summary and the VAT engine exactly.
// ═══════════════════════════════════════════════════════════════════
import { vatFromInclusiveRaw } from "./tax.js";
import { signedAmounts } from "./purchases.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr, f) => (arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0);

/** A completed, non-draft sale dated on `dateStr`. */
function isDaySale(s, dateStr) {
  return s && s.date === dateStr && (!s.status || s.status === "completed") && !s.isDraft;
}

/**
 * Build the totals-only report for one day.
 * @param {Array} sales        all sales (restopos_sales)
 * @param {Array} purchaseDocs captured supplier invoices (restopos_purchase_invoices)
 * @param {string} dateStr     "YYYY-MM-DD"
 */
export function buildDailyReport(sales = [], purchaseDocs = [], dateStr) {
  const daySales = (sales || []).filter((s) => isDaySale(s, dateStr));
  const revenue = r2(sum(daySales, (s) => s.total));
  const vat = r2(sum(daySales, (s) => s.vat)); // output VAT
  const net = r2(revenue - vat);
  const discount = r2(sum(daySales, (s) => s.discount));
  const qty = sum(daySales, (s) => (s.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0));

  const payBreakdown = {};
  daySales.forEach((s) => {
    const m = s.payMethod || "Other";
    payBreakdown[m] = r2((payBreakdown[m] || 0) + (Number(s.total) || 0));
  });

  const catMap = {};
  daySales.forEach((s) => (s.items || []).forEach((it) => {
    const c = it.category || "Items";
    const lt = (Number(it.qty) || 0) * (Number(it.price) || 0);
    const o = catMap[c] || (catMap[c] = { cat: c, qty: 0, revenue: 0, vat: 0 });
    o.qty += Number(it.qty) || 0;
    o.revenue += lt;
    o.vat += vatFromInclusiveRaw(lt);
  }));
  const catList = Object.values(catMap)
    .map((c) => ({ ...c, revenue: r2(c.revenue), vat: r2(c.vat) }))
    .sort((a, b) => b.revenue - a.revenue);

  let purchasesTotal = 0, purchasesVat = 0, purchasesNet = 0, purchasesCount = 0;
  (purchaseDocs || []).forEach((d) => {
    if (String((d && d.invoiceDate) || "").slice(0, 10) !== dateStr) return;
    const a = signedAmounts(d);
    purchasesTotal += a.total; purchasesVat += a.vatAmount; purchasesNet += a.subtotal; purchasesCount++;
  });

  return {
    date: dateStr,
    orderCount: daySales.length,
    qty,
    revenue, vat, net, discount,
    payBreakdown, catList,
    purchasesTotal: r2(purchasesTotal),
    purchasesVat: r2(purchasesVat),
    purchasesNet: r2(purchasesNet),
    purchasesCount,
    netVat: r2(vat - purchasesVat), // VAT payable = output − input
  };
}

/** Distinct dates (newest first) that have any completed sale or purchase. */
export function datesWithActivity(sales = [], purchaseDocs = []) {
  const set = new Set();
  (sales || []).forEach((s) => { if (s && typeof s.date === "string" && (!s.status || s.status === "completed") && !s.isDraft) set.add(s.date); });
  (purchaseDocs || []).forEach((d) => { const dt = String((d && d.invoiceDate) || "").slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) set.add(dt); });
  return [...set].sort().reverse();
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "SAR " + (Number(n) || 0).toFixed(2);

/**
 * Printable A4 HTML for a daily report — opened in a print window so the browser
 * can "Save as PDF". Pure string builder (no DOM). `license` supplies shop info.
 */
export function dailyReportHTML(report, license = {}) {
  const shop = esc(license.businessName || "RestoPOS");
  const vatNo = esc(license.vatNumber || "");
  const addr = esc(license.address || license.city || "");
  const pays = Object.entries(report.payBreakdown || {}).filter(([, v]) => v > 0);
  const cats = report.catList || [];
  const row = (l, v, strong) => `<tr><td>${esc(l)}</td><td style="text-align:right${strong ? ";font-weight:800" : ""}">${v}</td></tr>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Daily Report ${esc(report.date)}</title>
<style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12px;margin:0}
h1{font-size:19px;margin:0 0 2px}.sub{color:#555;font-size:12px}.card{border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:12px 0}
.kpis{display:flex;gap:10px;flex-wrap:wrap}.kpi{flex:1;min-width:120px;border:1px solid #e3e3e3;border-radius:8px;padding:10px;text-align:center}
.kpi .l{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.04em}.kpi .v{font-size:16px;font-weight:800;margin-top:3px}
table{width:100%;border-collapse:collapse}td,th{padding:5px 6px;border-bottom:1px solid #eee;font-size:12px}th{text-align:left;color:#555}
.net{background:#f3f7f4;border:1px solid #1a6b4a33}.foot{margin-top:16px;color:#888;font-size:10px;text-align:center}
h2{font-size:13px;margin:0 0 6px}</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start">
  <div><h1>${shop}</h1><div class="sub">${addr}${vatNo ? ` &middot; VAT ${vatNo}` : ""}</div></div>
  <div style="text-align:right"><div style="font-weight:800;font-size:15px">Daily Report</div><div class="sub">${esc(report.date)} &middot; 00:00–23:59</div></div>
</div>
<div class="kpis" style="margin-top:12px">
  <div class="kpi"><div class="l">Orders</div><div class="v">${report.orderCount || 0}</div></div>
  <div class="kpi"><div class="l">Items sold</div><div class="v">${report.qty || 0}</div></div>
  <div class="kpi"><div class="l">Revenue (incl VAT)</div><div class="v">${money(report.revenue)}</div></div>
  <div class="kpi"><div class="l">Net (excl VAT)</div><div class="v">${money(report.net)}</div></div>
</div>
<div class="card net"><h2>VAT</h2><table>
  ${row("Output VAT (on sales)", money(report.vat))}
  ${row("Purchases (incl VAT)" + (report.purchasesCount ? ` — ${report.purchasesCount} bill(s)` : ""), money(report.purchasesTotal))}
  ${row("Input VAT (on purchases)", money(report.purchasesVat))}
  ${row("NET VAT PAYABLE", money(report.netVat), true)}
</table><div class="sub" style="margin-top:6px">Net VAT payable = output VAT on sales − input VAT on purchases.</div></div>
<div class="card"><h2>Payments</h2><table>${pays.length ? pays.map(([k, v]) => row(k, money(v))).join("") : row("—", money(0))}</table></div>
${cats.length ? `<div class="card"><h2>By category</h2><table><tr><th>Category</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th><th style="text-align:right">VAT</th></tr>
${cats.map((c) => `<tr><td>${esc(c.cat)}</td><td style="text-align:right">${c.qty}</td><td style="text-align:right">${money(c.revenue)}</td><td style="text-align:right">${money(c.vat)}</td></tr>`).join("")}</table></div>` : ""}
<div class="foot">RestoPOS daily report &middot; generated ${esc(new Date().toLocaleString("en-SA"))}</div>
</body></html>`;
}
