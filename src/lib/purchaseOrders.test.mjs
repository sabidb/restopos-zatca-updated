// Golden tests for src/lib/purchaseOrders.js — run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePO, matchThreeWay, addReceipt } from "./purchaseOrders.js";

// ── computePO ─────────────────────────────────────────────────────────────
test("computePO totals ordered value and reports receipt status", () => {
  const open = computePO({ lines: [{ name: "A", qty: 10, unitCost: 5 }, { name: "B", qty: 2, unitCost: 3 }] });
  assert.equal(open.orderedValue, 56); // 50 + 6
  assert.equal(open.orderedQty, 12);
  assert.equal(open.receiptStatus, "open");

  const partial = computePO({ lines: [{ name: "A", qty: 10, unitCost: 5, receivedQty: 4 }] });
  assert.equal(partial.receiptStatus, "partial");

  const full = computePO({ lines: [{ name: "A", qty: 10, unitCost: 5, receivedQty: 10 }] });
  assert.equal(full.receiptStatus, "received");
});

// ── goods-receipt history (multiple deliveries) ────────────────────────────
test("addReceipt appends a delivery without mutating the PO; keeps qty>0 only", () => {
  const po = { lines: [{ name: "A", qty: 10, unitCost: 5 }] };
  const po2 = addReceipt(po, { date: "2026-11-02", lines: [{ name: "A", qty: 4 }, { name: "A", qty: 0 }] });
  assert.equal(po.receipts, undefined);         // original untouched
  assert.equal(po2.receipts.length, 1);
  assert.equal(po2.receipts[0].lines.length, 1); // zero-qty line dropped
  assert.ok(po2.receipts[0].id.startsWith("GRN-"));
});

test("receivedQty is the SUM across multiple receipts", () => {
  let po = { lines: [{ name: "A", qty: 10, unitCost: 5 }] };
  po = addReceipt(po, { lines: [{ name: "A", qty: 4 }] });
  po = addReceipt(po, { lines: [{ name: "A", qty: 6 }] });
  const c = computePO(po);
  assert.equal(c.lines[0].receivedQty, 10);
  assert.equal(c.receiptStatus, "received");
  assert.equal(c.receiptCount, 2);
});

test("partial across deliveries stays 'partial' until fully received", () => {
  let po = { lines: [{ name: "A", qty: 10, unitCost: 5 }] };
  po = addReceipt(po, { lines: [{ name: "A", qty: 3 }] });
  assert.equal(computePO(po).receiptStatus, "partial");
});

test("legacy POs (no receipts array) still use per-line receivedQty", () => {
  const c = computePO({ lines: [{ name: "A", qty: 10, unitCost: 5, receivedQty: 10 }] });
  assert.equal(c.lines[0].receivedQty, 10);
  assert.equal(c.receiptStatus, "received");
});

test("3-way match reads summed receipts from computePO", () => {
  let po = { lines: [{ name: "Milk", qty: 10, unitCost: 5 }] };
  po = addReceipt(po, { lines: [{ name: "Milk", qty: 5 }] });
  po = addReceipt(po, { lines: [{ name: "Milk", qty: 3 }] }); // 8 received total
  const m = matchThreeWay(computePO(po), { lines: [{ name: "Milk", qty: 10, unitCost: 5 }] });
  assert.equal(m.lines[0].receivedQty, 8);
  assert.equal(m.lines[0].status, "over-billed"); // billed 10 > received 8
});

// ── matchThreeWay ─────────────────────────────────────────────────────────
test("perfect match: ordered = received = invoiced, cost equal → ok", () => {
  const po = { lines: [{ name: "Milk", qty: 10, unitCost: 5, receivedQty: 10 }] };
  const inv = { lines: [{ name: "Milk", qty: 10, unitCost: 5 }] };
  const m = matchThreeWay(po, inv);
  assert.equal(m.lines[0].status, "ok");
  assert.equal(m.summary.hasIssues, false);
});

test("short receipt: received < ordered", () => {
  const m = matchThreeWay(
    { lines: [{ name: "Milk", qty: 10, unitCost: 5, receivedQty: 7 }] },
    { lines: [{ name: "Milk", qty: 7, unitCost: 5 }] });
  assert.equal(m.lines[0].status, "short-receipt");
  assert.equal(m.summary.issues, 1);
});

test("over-billed: invoiced qty > received qty (caught before paying)", () => {
  const m = matchThreeWay(
    { lines: [{ name: "Milk", qty: 10, unitCost: 5, receivedQty: 8 }] },
    { lines: [{ name: "Milk", qty: 10, unitCost: 5 }] });
  assert.equal(m.lines[0].status, "over-billed");
  assert.equal(m.lines[0].qtyVariance, 2); // billed 10, received 8
});

test("over-receipt: received more than ordered", () => {
  const m = matchThreeWay(
    { lines: [{ name: "Milk", qty: 10, unitCost: 5, receivedQty: 12 }] },
    { lines: [{ name: "Milk", qty: 12, unitCost: 5 }] });
  assert.equal(m.lines[0].status, "over-receipt");
});

test("price variance: invoiced unit cost differs from PO", () => {
  const m = matchThreeWay(
    { lines: [{ name: "Milk", qty: 10, unitCost: 5, receivedQty: 10 }] },
    { lines: [{ name: "Milk", qty: 10, unitCost: 5.5 }] });
  assert.equal(m.lines[0].status, "price-variance");
  assert.equal(m.lines[0].priceVariance, 0.5);
});

test("not-received takes priority when nothing arrived but it's billed equal", () => {
  const m = matchThreeWay(
    { lines: [{ name: "Milk", qty: 10, unitCost: 5, receivedQty: 0 }] },
    { lines: [{ name: "Milk", qty: 0, unitCost: 5 }] });
  assert.equal(m.lines[0].status, "not-received");
});

test("not-ordered: invoice has a line the PO never had", () => {
  const m = matchThreeWay(
    { lines: [{ name: "Milk", qty: 10, unitCost: 5, receivedQty: 10 }] },
    { lines: [{ name: "Milk", qty: 10, unitCost: 5 }, { name: "Cookies", qty: 3, unitCost: 2 }] });
  const cookies = m.lines.find((l) => l.name === "Cookies");
  assert.equal(cookies.status, "not-ordered");
  assert.equal(m.summary.hasIssues, true);
});

test("lines match by itemId even when names differ", () => {
  const m = matchThreeWay(
    { lines: [{ itemId: "P1", name: "Milk 1L", qty: 5, unitCost: 4, receivedQty: 5 }] },
    { lines: [{ itemId: "P1", name: "MILK (1 litre)", qty: 5, unitCost: 4 }] });
  assert.equal(m.lines.length, 1);
  assert.equal(m.lines[0].status, "ok");
});

test("summary counts statuses", () => {
  const m = matchThreeWay(
    { lines: [
      { name: "A", qty: 5, unitCost: 1, receivedQty: 5 },  // ok
      { name: "B", qty: 5, unitCost: 1, receivedQty: 3 },  // short
    ] },
    { lines: [{ name: "A", qty: 5, unitCost: 1 }, { name: "B", qty: 3, unitCost: 1 }] });
  assert.equal(m.summary.matched, 1);
  assert.equal(m.summary.statuses["short-receipt"], 1);
});
