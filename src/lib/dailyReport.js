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
import { signedAmounts, recoverablePortion } from "./purchases.js";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr, f) => (arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0);

/** Deduplicate duplicate copies of a sale archived and synced from multiple devices. */
export function uniqueSalesById(sales = []) {
  const byId = new Map();
  const noId = [];
  const time = (s) => { const t = Date.parse(s?.syncUpdatedAt || s?.lastModifiedAt || s?.modifiedAt || s?.updatedAt || s?.createdAt || ""); return Number.isFinite(t) ? t : 0; };
  for (const sale of sales || []) {
    if (!sale || sale.id == null || sale.id === "") { noId.push(sale); continue; }
    const key = String(sale.id), prev = byId.get(key);
    if (!prev || time(sale) > time(prev)) byId.set(key, sale);
  }
  return [...byId.values(), ...noId];
}

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
  const daySales = uniqueSalesById(sales).filter((s) => isDaySale(s, dateStr));
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

  // purchasesVat is ALL input VAT recorded (informational). recoverableVat is the
  // subset the buyer may actually reclaim — the canonical rule (isInputVatRecoverable)
  // — and ONLY that subset reduces VAT payable. Treating every entered purchase VAT
  // as deductible overstated the deduction and understated the tax owed (AUD-01).
  let purchasesTotal = 0, purchasesVat = 0, purchasesNet = 0, purchasesCount = 0;
  let recoverableVat = 0, nonRecoverableVat = 0;
  (purchaseDocs || []).forEach((d) => {
    if (String((d && d.invoiceDate) || "").slice(0, 10) !== dateStr) return;
    const a = signedAmounts(d);
    purchasesTotal += a.total; purchasesVat += a.vatAmount; purchasesNet += a.subtotal; purchasesCount++;
    // Partial recoverability: a documented apportionment (recoverablePortion) splits
    // one bill's input VAT between the recoverable and non-recoverable sides.
    const p = recoverablePortion(d);
    recoverableVat += a.vatAmount * p; nonRecoverableVat += a.vatAmount * (1 - p);
  });

  return {
    date: dateStr,
    orderCount: daySales.length,
    qty,
    revenue, vat, net, discount,
    payBreakdown, catList,
    purchasesTotal: r2(purchasesTotal),
    purchasesVat: r2(purchasesVat),
    recoverableVat: r2(recoverableVat),
    nonRecoverableVat: r2(nonRecoverableVat),
    purchasesNet: r2(purchasesNet),
    purchasesCount,
    netVat: r2(vat - recoverableVat), // VAT payable = output − RECOVERABLE input
  };
}

/** Distinct dates (newest first) that have any completed sale or purchase. */
export function datesWithActivity(sales = [], purchaseDocs = []) {
  const set = new Set();
  (sales || []).forEach((s) => { if (s && typeof s.date === "string" && (!s.status || s.status === "completed") && !s.isDraft) set.add(s.date); });
  (purchaseDocs || []).forEach((d) => { const dt = String((d && d.invoiceDate) || "").slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) set.add(dt); });
  return [...set].sort().reverse();
}

/**
 * Aggregate every day in [fromStr, toStr] into one period report — same figures
 * as a daily report plus a per-day breakdown. Used by the "Custom timeline"
 * generator so a merchant can pull a week / month / any range as one PDF.
 */
export function buildPeriodReport(sales = [], purchaseDocs = [], fromStr, toStr) {
  const uniqueSales = uniqueSalesById(sales);
  const dates = datesWithActivity(uniqueSales, purchaseDocs).filter((d) => d >= fromStr && d <= toStr).sort();
  const days = dates.map((d) => buildDailyReport(uniqueSales, purchaseDocs, d));
  const sumBy = (f) => r2(days.reduce((s, d) => s + (Number(f(d)) || 0), 0));
  const payBreakdown = {}, catMap = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(d.payBreakdown || {})) payBreakdown[k] = r2((payBreakdown[k] || 0) + v);
    for (const c of d.catList || []) {
      const o = catMap[c.cat] || (catMap[c.cat] = { cat: c.cat, qty: 0, revenue: 0, vat: 0 });
      o.qty += c.qty; o.revenue = r2(o.revenue + c.revenue); o.vat = r2(o.vat + c.vat);
    }
  }
  const vat = sumBy((d) => d.vat), purchasesVat = sumBy((d) => d.purchasesVat);
  const recoverableVat = sumBy((d) => d.recoverableVat), nonRecoverableVat = sumBy((d) => d.nonRecoverableVat);
  return {
    from: fromStr, to: toStr, dayCount: days.length,
    orderCount: days.reduce((s, d) => s + d.orderCount, 0),
    qty: days.reduce((s, d) => s + d.qty, 0),
    revenue: sumBy((d) => d.revenue), vat, net: sumBy((d) => d.net), discount: sumBy((d) => d.discount),
    purchasesTotal: sumBy((d) => d.purchasesTotal), purchasesVat, purchasesNet: sumBy((d) => d.purchasesNet),
    recoverableVat, nonRecoverableVat,
    purchasesCount: days.reduce((s, d) => s + d.purchasesCount, 0),
    netVat: r2(vat - recoverableVat),
    payBreakdown, catList: Object.values(catMap).sort((a, b) => b.revenue - a.revenue),
    days: days.map((d) => ({ date: d.date, orderCount: d.orderCount, revenue: d.revenue, vat: d.vat, netVat: d.netVat })),
  };
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
  ${row("Input VAT recorded (on purchases)", money(report.purchasesVat))}
  ${row("Recoverable input VAT", money(report.recoverableVat ?? report.purchasesVat))}
  ${Number(report.nonRecoverableVat) ? row("Non-recoverable input VAT (no valid e-invoice)", money(report.nonRecoverableVat)) : ""}
  ${row("NET VAT PAYABLE", money(report.netVat), true)}
</table><div class="sub" style="margin-top:6px">Net VAT payable = output VAT on sales − <b>recoverable</b> input VAT. Input VAT is recoverable only when the supplier issued a valid ZATCA e-invoice; this is an estimate, not a filed VAT return.</div></div>
<div class="card"><h2>Payments</h2><table>${pays.length ? pays.map(([k, v]) => row(k, money(v))).join("") : row("—", money(0))}</table></div>
${cats.length ? `<div class="card"><h2>By category</h2><table><tr><th>Category</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th><th style="text-align:right">VAT</th></tr>
${cats.map((c) => `<tr><td>${esc(c.cat)}</td><td style="text-align:right">${c.qty}</td><td style="text-align:right">${money(c.revenue)}</td><td style="text-align:right">${money(c.vat)}</td></tr>`).join("")}</table></div>` : ""}
<div class="foot">RestoPOS daily report &middot; generated ${esc(new Date().toLocaleString("en-SA"))}</div>
</body></html>`;
}

/**
 * Printable A4 HTML for a CUSTOM-RANGE report — period totals, VAT, payment and
 * category breakdowns, plus a per-day table. Browser "Save as PDF".
 */
export function periodReportHTML(report, license = {}) {
  const shop = esc(license.businessName || "RestoPOS");
  const vatNo = esc(license.vatNumber || "");
  const addr = esc(license.address || license.city || "");
  const pays = Object.entries(report.payBreakdown || {}).filter(([, v]) => v > 0);
  const cats = report.catList || [];
  const days = report.days || [];
  const row = (l, v, strong) => `<tr><td>${esc(l)}</td><td style="text-align:right${strong ? ";font-weight:800" : ""}">${v}</td></tr>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Report ${esc(report.from)}…${esc(report.to)}</title>
<style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12px;margin:0}
h1{font-size:19px;margin:0 0 2px}.sub{color:#555;font-size:12px}.card{border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:12px 0}
.kpis{display:flex;gap:10px;flex-wrap:wrap}.kpi{flex:1;min-width:110px;border:1px solid #e3e3e3;border-radius:8px;padding:10px;text-align:center}
.kpi .l{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.04em}.kpi .v{font-size:16px;font-weight:800;margin-top:3px}
table{width:100%;border-collapse:collapse}td,th{padding:5px 6px;border-bottom:1px solid #eee;font-size:12px}th{text-align:left;color:#555}
.net{background:#f3f7f4;border:1px solid #1a6b4a33}.foot{margin-top:16px;color:#888;font-size:10px;text-align:center}h2{font-size:13px;margin:0 0 6px}
tfoot td{font-weight:800;border-top:2px solid #ccc}</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start">
  <div><h1>${shop}</h1><div class="sub">${addr}${vatNo ? ` &middot; VAT ${vatNo}` : ""}</div></div>
  <div style="text-align:right"><div style="font-weight:800;font-size:15px">Period Report</div><div class="sub">${esc(report.from)} → ${esc(report.to)} &middot; ${report.dayCount || 0} day(s)</div></div>
</div>
<div class="kpis" style="margin-top:12px">
  <div class="kpi"><div class="l">Orders</div><div class="v">${report.orderCount || 0}</div></div>
  <div class="kpi"><div class="l">Items sold</div><div class="v">${report.qty || 0}</div></div>
  <div class="kpi"><div class="l">Revenue</div><div class="v">${money(report.revenue)}</div></div>
  <div class="kpi"><div class="l">Net (excl VAT)</div><div class="v">${money(report.net)}</div></div>
</div>
<div class="card net"><h2>VAT</h2><table>
  ${row("Output VAT (on sales)", money(report.vat))}
  ${row("Purchases (incl VAT)" + (report.purchasesCount ? ` — ${report.purchasesCount} bill(s)` : ""), money(report.purchasesTotal))}
  ${row("Input VAT recorded (on purchases)", money(report.purchasesVat))}
  ${row("Recoverable input VAT", money(report.recoverableVat ?? report.purchasesVat))}
  ${Number(report.nonRecoverableVat) ? row("Non-recoverable input VAT (no valid e-invoice)", money(report.nonRecoverableVat)) : ""}
  ${row("NET VAT PAYABLE", money(report.netVat), true)}
</table><div class="sub" style="margin-top:6px">Net VAT payable = output VAT on sales − <b>recoverable</b> input VAT. Input VAT is recoverable only when the supplier issued a valid ZATCA e-invoice; this is an estimate, not a filed VAT return.</div></div>
<div class="card"><h2>Payments</h2><table>${pays.length ? pays.map(([k, v]) => row(k, money(v))).join("") : row("—", money(0))}</table></div>
${days.length ? `<div class="card"><h2>By day</h2><table><tr><th>Date</th><th style="text-align:right">Orders</th><th style="text-align:right">Revenue</th><th style="text-align:right">VAT</th><th style="text-align:right">Net VAT</th></tr>
${days.map((d) => `<tr><td>${esc(d.date)}</td><td style="text-align:right">${d.orderCount}</td><td style="text-align:right">${money(d.revenue)}</td><td style="text-align:right">${money(d.vat)}</td><td style="text-align:right">${money(d.netVat)}</td></tr>`).join("")}
<tfoot><tr><td>Total</td><td style="text-align:right">${report.orderCount || 0}</td><td style="text-align:right">${money(report.revenue)}</td><td style="text-align:right">${money(report.vat)}</td><td style="text-align:right">${money(report.netVat)}</td></tr></tfoot></table></div>` : ""}
${cats.length ? `<div class="card"><h2>By category</h2><table><tr><th>Category</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th><th style="text-align:right">VAT</th></tr>
${cats.map((c) => `<tr><td>${esc(c.cat)}</td><td style="text-align:right">${c.qty}</td><td style="text-align:right">${money(c.revenue)}</td><td style="text-align:right">${money(c.vat)}</td></tr>`).join("")}</table></div>` : ""}
<div class="foot">RestoPOS period report &middot; generated ${esc(new Date().toLocaleString("en-SA"))}</div>
</body></html>`;
}
