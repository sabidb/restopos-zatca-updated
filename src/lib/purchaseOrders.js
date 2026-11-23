// ═══════════════════════════════════════════════════════════════════
// PURCHASE ORDERS + 3-WAY MATCH — what was ORDERED (PO), what was RECEIVED
// (goods receipt), and what was BILLED (purchase invoice), reconciled.
//
// A PO is created up front; goods arrival is recorded as receivedQty on each PO
// line (the goods-receipt step — kept embedded rather than a separate GRN doc so
// the v1 workflow stays simple); the supplier's invoice is then matched against
// both to catch short deliveries, over-receipts, over-billing and price
// variances before the invoice is paid.
//
// Costing-agnostic: this reconciles quantities and unit costs on documents. It
// does NOT post stock or value inventory (that needs a costing method).
//
// Pure + testable: no React, no Firestore.
// ═══════════════════════════════════════════════════════════════════
import { zr2 } from "./tax.js";

const num = (v, f = 0) => { const n = parseFloat(String(v ?? "").trim()); return Number.isFinite(n) ? n : f; };
const lineKey = (l) => (l.itemId != null && l.itemId !== "")
  ? "id:" + l.itemId
  : "name:" + String(l.name ?? "").trim().toLowerCase();

/** PO ordered totals (net, ex-VAT expected cost). Receipt progress too. */
export function computePO(po = {}) {
  const lines = (Array.isArray(po.lines) ? po.lines : []).map((l) => {
    const qty = num(l.qty), receivedQty = num(l.receivedQty), unitCost = num(l.unitCost);
    return { ...l, qty, receivedQty, unitCost, lineTotal: zr2(qty * unitCost) };
  });
  const orderedValue = zr2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const orderedQty = lines.reduce((s, l) => s + l.qty, 0);
  const receivedQty = lines.reduce((s, l) => s + l.receivedQty, 0);
  const fullyReceived = lines.length > 0 && lines.every((l) => l.receivedQty >= l.qty);
  const partlyReceived = !fullyReceived && lines.some((l) => l.receivedQty > 0);
  return {
    ...po, lines, orderedValue, orderedQty, receivedQty,
    receiptStatus: fullyReceived ? "received" : partlyReceived ? "partial" : "open",
  };
}

/**
 * 3-way match a PO (carrying ordered + receivedQty per line) against a purchase
 * INVOICE (lines with qty + unitCost). Matches lines by itemId, else by name.
 * @returns { lines, summary }
 *   each line: { key, name, orderedQty, receivedQty, invoicedQty, expectedCost,
 *                invoicedCost, qtyVariance (invoiced−received), priceVariance, status }
 *   status: ok | not-received | short-receipt | over-receipt | over-billed |
 *           price-variance | not-ordered
 *   summary: { matched, issues, statuses{...}, hasIssues }
 */
export function matchThreeWay(po = {}, invoice = {}) {
  const poLines = Array.isArray(po.lines) ? po.lines : [];
  const invLines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const keys = [];
  const seen = new Set();
  const addKey = (k) => { if (!seen.has(k)) { seen.add(k); keys.push(k); } };

  const poMap = new Map(), invMap = new Map();
  for (const l of poLines) { const k = lineKey(l); poMap.set(k, l); addKey(k); }
  for (const l of invLines) { const k = lineKey(l); invMap.set(k, l); addKey(k); }

  const lines = keys.map((k) => {
    const p = poMap.get(k), i = invMap.get(k);
    const orderedQty = p ? num(p.qty) : 0;
    const receivedQty = p ? num(p.receivedQty) : 0;
    const invoicedQty = i ? num(i.qty) : 0;
    const expectedCost = p ? num(p.unitCost) : null;
    const invoicedCost = i ? num(i.unitCost) : null;
    const qtyVariance = invoicedQty - receivedQty;      // billed vs received
    const priceVariance = (expectedCost != null && invoicedCost != null)
      ? zr2(invoicedCost - expectedCost) : 0;

    let status = "ok";
    if (!p) status = "not-ordered";
    else if (invoicedQty > receivedQty) status = "over-billed";
    else if (receivedQty === 0) status = "not-received";
    else if (receivedQty > orderedQty) status = "over-receipt";
    else if (receivedQty < orderedQty) status = "short-receipt";
    if (status === "ok" && priceVariance !== 0) status = "price-variance";

    return {
      key: k, name: (i && i.name) || (p && p.name) || "",
      orderedQty, receivedQty, invoicedQty, expectedCost, invoicedCost,
      qtyVariance, priceVariance, status,
    };
  });

  const statuses = {};
  for (const l of lines) statuses[l.status] = (statuses[l.status] || 0) + 1;
  const matched = lines.filter((l) => l.status === "ok").length;
  const issues = lines.length - matched;
  return { lines, summary: { matched, issues, statuses, hasIssues: issues > 0 } };
}
