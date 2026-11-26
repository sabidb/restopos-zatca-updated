import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailyReport, datesWithActivity, dailyReportHTML } from "./dailyReport.js";

const sales = [
  { id: 1, date: "2026-11-25", status: "completed", total: 115, vat: 15, payMethod: "Card", items: [{ category: "Dairy", qty: 2, price: 57.5 }] },
  { id: 2, date: "2026-11-25", status: "completed", total: 23, vat: 3, payMethod: "Cash", items: [{ category: "Bakery", qty: 1, price: 23 }] },
  { id: 3, date: "2026-11-25", status: "voided", total: 50, vat: 6.52, items: [] },      // excluded
  { id: 4, date: "2026-11-25", isDraft: true, total: 10, vat: 1.3, items: [] },           // excluded
  { id: 5, date: "2026-11-24", status: "completed", total: 46, vat: 6, payMethod: "Card", items: [] },
];
const purchases = [
  { id: "p1", invoiceDate: "2026-11-25", subtotal: 100, vatAmount: 15, total: 115 },
  { id: "p2", invoiceDate: "2026-11-25", docType: "credit_note", subtotal: 20, vatAmount: 3, total: 23 }, // subtracts
  { id: "p3", invoiceDate: "2026-11-20", subtotal: 50, vatAmount: 7.5, total: 57.5 },                     // other day
];

test("totals exclude voided and draft sales", () => {
  const r = buildDailyReport(sales, purchases, "2026-11-25");
  assert.equal(r.orderCount, 2);
  assert.equal(r.revenue, 138);     // 115 + 23
  assert.equal(r.vat, 18);          // 15 + 3  (output VAT)
  assert.equal(r.net, 120);
});

test("purchases net credit notes and compute input + net VAT", () => {
  const r = buildDailyReport(sales, purchases, "2026-11-25");
  assert.equal(r.purchasesCount, 2);
  assert.equal(r.purchasesTotal, 92);   // 115 − 23
  assert.equal(r.purchasesVat, 12);     // 15 − 3  (input VAT)
  assert.equal(r.netVat, 6);            // output 18 − input 12
});

test("payment and category breakdowns", () => {
  const r = buildDailyReport(sales, purchases, "2026-11-25");
  assert.equal(r.payBreakdown.Card, 115);
  assert.equal(r.payBreakdown.Cash, 23);
  assert.deepEqual(r.catList.map((c) => c.cat), ["Dairy", "Bakery"]);
});

test("a day with only purchases still reports (negative net VAT possible)", () => {
  const r = buildDailyReport(sales, purchases, "2026-11-20");
  assert.equal(r.orderCount, 0);
  assert.equal(r.purchasesVat, 7.5);
  assert.equal(r.netVat, -7.5); // refund position: input VAT exceeds output
});

test("datesWithActivity lists sale and purchase days, newest first, no voids/drafts-only", () => {
  const d = datesWithActivity(sales, purchases);
  assert.deepEqual(d, ["2026-11-25", "2026-11-24", "2026-11-20"]);
});

test("empty inputs are safe", () => {
  const r = buildDailyReport([], [], "2026-11-25");
  assert.equal(r.orderCount, 0);
  assert.equal(r.netVat, 0);
  assert.deepEqual(datesWithActivity([], []), []);
});

test("dailyReportHTML renders shop info, net VAT and escapes", () => {
  const html = dailyReportHTML(buildDailyReport(sales, purchases, "2026-11-25"), { businessName: "A&B Mart", vatNumber: "300", address: "Riyadh" });
  assert.match(html, /A&amp;B Mart/);
  assert.match(html, /VAT 300/);
  assert.match(html, /NET VAT PAYABLE/);
  assert.match(html, /00:00–23:59/);
});
