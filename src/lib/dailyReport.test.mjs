import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailyReport, datesWithActivity, dailyReportHTML, buildPeriodReport, periodReportHTML, uniqueSalesById } from "./dailyReport.js";

const sales = [
  { id: 1, date: "2026-11-25", status: "completed", total: 115, vat: 15, payMethod: "Card", items: [{ category: "Dairy", qty: 2, price: 57.5 }] },
  { id: 2, date: "2026-11-25", status: "completed", total: 23, vat: 3, payMethod: "Cash", items: [{ category: "Bakery", qty: 1, price: 23 }] },
  { id: 3, date: "2026-11-25", status: "voided", total: 50, vat: 6.52, items: [] },      // excluded
  { id: 4, date: "2026-11-25", isDraft: true, total: 10, vat: 1.3, items: [] },           // excluded
  { id: 5, date: "2026-11-24", status: "completed", total: 46, vat: 6, payMethod: "Card", items: [] },
];
const purchases = [
  { id: "p1", invoiceDate: "2026-11-25", hasValidEInvoice: true,  supplierVatNumber: "300000000000003", supplierInvoiceNo: "A-1", subtotal: 100, vatAmount: 15, total: 115 }, // recoverable
  { id: "p2", invoiceDate: "2026-11-25", hasValidEInvoice: true,  supplierVatNumber: "300000000000003", supplierInvoiceNo: "CN-1", docType: "credit_note", subtotal: 20, vatAmount: 3, total: 23 }, // recoverable, subtracts
  { id: "p4", invoiceDate: "2026-11-25", hasValidEInvoice: false, subtotal: 40, vatAmount: 6, total: 46 },    // NON-recoverable (no valid e-invoice)
  { id: "p3", invoiceDate: "2026-11-20", hasValidEInvoice: false, subtotal: 50, vatAmount: 7.5, total: 57.5 }, // other day, non-recoverable
];

test("totals exclude voided and draft sales", () => {
  const r = buildDailyReport(sales, purchases, "2026-11-25");
  assert.equal(r.orderCount, 2);
  assert.equal(r.revenue, 138);     // 115 + 23
  assert.equal(r.vat, 18);          // 15 + 3  (output VAT)
  assert.equal(r.net, 120);
});

test("purchases net credit notes; only RECOVERABLE input VAT reduces net VAT (AUD-01)", () => {
  const r = buildDailyReport(sales, purchases, "2026-11-25");
  assert.equal(r.purchasesCount, 3);          // p1, p2, p4
  assert.equal(r.purchasesTotal, 138);        // 115 − 23 + 46
  assert.equal(r.purchasesVat, 18);           // 15 − 3 + 6  (ALL input VAT recorded)
  assert.equal(r.recoverableVat, 12);         // 15 − 3  (valid e-invoice only)
  assert.equal(r.nonRecoverableVat, 6);       // p4 has no valid e-invoice
  assert.equal(r.netVat, 6);                  // output 18 − RECOVERABLE 12 (NOT − 18)
});

test("a purchase with no valid e-invoice is NOT deducted from net VAT (AUD-01)", () => {
  // The whole bug: a non-recoverable purchase must not lower the tax owed.
  const r = buildDailyReport(sales, purchases, "2026-11-25");
  const allInputDeducted = r.vat - r.purchasesVat; // the OLD, wrong formula
  assert.equal(allInputDeducted, 0);              // old formula would have said 0 payable
  assert.equal(r.netVat, 6);                      // correct: the SAR 6 non-recoverable VAT stays owed
});

test("payment and category breakdowns", () => {
  const r = buildDailyReport(sales, purchases, "2026-11-25");
  assert.equal(r.payBreakdown.Card, 115);
  assert.equal(r.payBreakdown.Cash, 23);
  assert.deepEqual(r.catList.map((c) => c.cat), ["Dairy", "Bakery"]);
});

test("a day with only a non-recoverable purchase: input VAT recorded but not deducted", () => {
  const r = buildDailyReport(sales, purchases, "2026-11-20");
  assert.equal(r.orderCount, 0);
  assert.equal(r.purchasesVat, 7.5);        // recorded
  assert.equal(r.recoverableVat, 0);        // not a valid e-invoice → nothing recoverable
  assert.equal(r.nonRecoverableVat, 7.5);
  assert.equal(r.netVat, 0);                // no output, no recoverable input → 0 (NOT −7.5)
});

test("a recoverable purchase-only day CAN produce a refund (negative) net VAT", () => {
  const recoverableOnly = [{ id: "r1", invoiceDate: "2026-11-20", hasValidEInvoice: true, supplierVatNumber: "300000000000003", supplierInvoiceNo: "R-1", subtotal: 50, vatAmount: 7.5, total: 57.5 }];
  const r = buildDailyReport([], recoverableOnly, "2026-11-20");
  assert.equal(r.recoverableVat, 7.5);
  assert.equal(r.netVat, -7.5);             // refund position: recoverable input exceeds output
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

test("buildPeriodReport aggregates a date range with per-day rows", () => {
  const r = buildPeriodReport(sales, purchases, "2026-11-24", "2026-11-25");
  assert.equal(r.dayCount, 2);
  assert.equal(r.orderCount, 3);          // 2 on the 25th + 1 on the 24th
  assert.equal(r.revenue, 184);           // 138 + 46
  assert.equal(r.vat, 24);                // 18 + 6  (output)
  assert.equal(r.purchasesVat, 18);       // only 25th has purchases (15 − 3 + 6, all recorded)
  assert.equal(r.recoverableVat, 12);     // only the valid-e-invoice subset
  assert.equal(r.netVat, 12);             // 24 − RECOVERABLE 12
  assert.deepEqual(r.days.map((d) => d.date), ["2026-11-24", "2026-11-25"]); // ascending
});

test("buildPeriodReport excludes out-of-range days", () => {
  const r = buildPeriodReport(sales, purchases, "2026-11-25", "2026-11-25");
  assert.equal(r.dayCount, 1);
  assert.equal(r.orderCount, 2);
  assert.equal(r.purchasesTotal, 138);
});

test("periodReportHTML renders the range, a by-day table and net VAT", () => {
  const html = periodReportHTML(buildPeriodReport(sales, purchases, "2026-11-24", "2026-11-25"), { businessName: "Mart", vatNumber: "300" });
  assert.match(html, /Period Report/);
  assert.match(html, /2026-11-24 → 2026-11-25/);
  assert.match(html, /By day/);
  assert.match(html, /NET VAT PAYABLE/);
});

test("dailyReportHTML renders shop info, net VAT and escapes", () => {
  const html = dailyReportHTML(buildDailyReport(sales, purchases, "2026-11-25"), { businessName: "A&B Mart", vatNumber: "300", address: "Riyadh" });
  assert.match(html, /A&amp;B Mart/);
  assert.match(html, /VAT 300/);
  assert.match(html, /NET VAT PAYABLE/);
  assert.match(html, /00:00–23:59/);
});


test("duplicate sale IDs from local, cloud and archive copies count once", () => {
  const duplicateCopies = [
    { id: "sale-1", date: "2026-11-27", status: "completed", total: 100, vat: 13.04, createdAt: "2026-11-27T10:00:00Z" },
    { id: "sale-1", date: "2026-11-27", status: "completed", total: 100, vat: 13.04, createdAt: "2026-11-27T10:00:00Z" },
    { id: "sale-2", date: "2026-11-27", status: "completed", total: 50, vat: 6.52 }
  ];
  assert.equal(uniqueSalesById(duplicateCopies).length, 2);
  const report = buildDailyReport(duplicateCopies, [], "2026-11-27");
  assert.equal(report.orderCount, 2);
  assert.equal(report.revenue, 150);
  assert.equal(report.vat, 19.56);
});

test("duplicate same-id records prefer newer edit timestamp", () => {
  const duplicates = [
    { id: "sale-1", date: "2026-11-27", status: "completed", total: 100, vat: 13.04, updatedAt: "2026-11-27T10:00:00Z" },
    { id: "sale-1", date: "2026-11-27", status: "completed", total: 120, vat: 15.65, updatedAt: "2026-11-27T11:00:00Z" }
  ];
  assert.equal(buildDailyReport(duplicates, [], "2026-11-27").revenue, 120);
});

test("category VAT respects zero-rated product tax category", () => {
  const sale = [{ id: "z1", date: "2026-11-25", status: "completed", total: 100, vat: 0, items: [{ category: "Medicine", taxCategory: "Z", qty: 1, price: 100 }] }];
  const r = buildDailyReport(sale, [], "2026-11-25");
  assert.equal(r.categoryVatTotal, 0);
  assert.equal(r.categoryVatDelta, 0);
  assert.equal(r.catList[0].vat, 0);
});

test("daily report surfaces category VAT divergence without changing saved VAT", () => {
  const sale = [{ id: "d1", date: "2026-11-25", status: "completed", total: 110, vat: 14.35, discount: 5, items: [{ category: "Food", qty: 1, price: 115 }] }];
  const r = buildDailyReport(sale, [], "2026-11-25");
  assert.equal(r.vat, 14.35);
  assert.equal(r.categoryVatTotal, 15);
  assert.equal(r.categoryVatDelta, 0.65);
  assert.match(dailyReportHTML(r), /Category VAT breakdown differs/);
  const p = buildPeriodReport(sale, [], "2026-11-25", "2026-11-25");
  assert.equal(p.categoryVatTotal, 15);
  assert.equal(p.categoryVatDelta, 0.65);
  assert.match(periodReportHTML(p), /Category VAT breakdown differs/);
});

test("daily and period reports flag duplicate, missing-ID, and malformed financial records",()=>{
  const sales=[
    {id:"D1",date:"2026-11-25",status:"completed",total:100,vat:13,updatedAt:"2026-11-25T10:00:00Z"},
    {id:"D1",date:"2026-11-25",status:"completed",total:100,vat:13,updatedAt:"2026-11-25T11:00:00Z"},
    {date:"2026-11-25",status:"completed",total:50,vat:6},
    {id:"D2",date:"2026-11-25",status:"completed",total:null,vat:0},
  ];
  const d=buildDailyReport(sales,[],"2026-11-25");
  assert.equal(d.orderCount,3);
  assert.equal(d.duplicateSaleCount,1);
  assert.deepEqual(d.duplicateSaleIds,["D1"]);
  assert.equal(d.missingSaleIdCount,1);
  assert.equal(d.invalidFinancialRecordCount,1);
  assert.match(dailyReportHTML(d),/Sale integrity flags/);
  const p=buildPeriodReport(sales,[],"2026-11-25","2026-11-25");
  assert.equal(p.duplicateSaleCount,1);
  assert.equal(p.missingSaleIdCount,1);
  assert.equal(p.invalidFinancialRecordCount,1);
  assert.match(periodReportHTML(p),/Sale integrity flags/);
});

test("daily report flags duplicate IDs across dates that can hide a sale",()=>{
  const sales=[
    {id:"CROSS-1",date:"2026-11-25",status:"completed",total:20,vat:2.61,updatedAt:"2026-11-25T10:00:00Z"},
    {id:"CROSS-1",date:"2026-11-24",status:"completed",total:20,vat:2.61,updatedAt:"2026-11-26T10:00:00Z"},
  ];
  const r=buildDailyReport(sales,[],"2026-11-25");
  assert.equal(r.orderCount,0);
  assert.equal(r.duplicateSaleCount,1);
  assert.deepEqual(r.duplicateSaleIds,["CROSS-1"]);
  assert.match(dailyReportHTML(r),/Sale integrity flags/);
});
