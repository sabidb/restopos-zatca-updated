// ═══════════════════════════════════════════════════════════════════
// COSTING — weighted-average (moving average) inventory costing, applied when
// goods are RECEIVED against a purchase order. The chosen policy for RestoPOS:
// one cost number per product, recomputed on each receipt. No cost layers
// (unlike FIFO), which keeps it correct under Firestore with offline/multi-
// device tills and avoids per-item layer arrays in the catalogue blob.
//
//   new_cost = (old_qty × old_cost + recv_qty × recv_cost) / (old_qty + recv_qty)
//
// Costs are the VAT-EXCLUSIVE unit cost from the purchase document. Rounding
// uses the same half-up zr2 as the rest of the purchase money path.
//
// Pure + testable: no React, no Firestore. The receive flow calls
// postReceiptToStock and writes the returned catalogue back through setItems.
// ═══════════════════════════════════════════════════════════════════
import { zr2 } from "./tax.js";

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/**
 * Weighted-average cost + new stock after receiving recvQty units at recvUnitCost.
 * Guards: negatives floored to 0; receiving 0 is a no-op; with no prior stock the
 * cost becomes the receipt cost (nothing to average against).
 * @returns { stock, cost }
 */
export function weightedAverageCost(oldStock, oldCost, recvQty, recvUnitCost) {
  const os = Math.max(0, n(oldStock));
  const oc = Math.max(0, n(oldCost));
  const rq = Math.max(0, n(recvQty));
  const rc = Math.max(0, n(recvUnitCost));
  if (rq === 0) return { stock: os, cost: zr2(oc) };
  const stock = os + rq;
  if (os === 0) return { stock, cost: zr2(rc) };
  return { stock, cost: zr2((os * oc + rq * rc) / stock) };
}

/**
 * Apply a goods-receipt's lines to the catalogue by weighted average.
 * Each line: { name, itemId?, qty, unitCost }. A line matches a product by
 * itemId first, else by trimmed case-insensitive name. Matched products get
 * stock += qty and a re-averaged cost; unmatched lines are returned so the UI
 * can tell the user they were recorded on the PO but not posted to stock.
 *
 * Pure: returns a NEW items array (originals untouched).
 * @returns { items, posted:[{id,name,addedQty,stock,cost}], unmatched:[line] }
 */
export function postReceiptToStock(items = [], lines = []) {
  const next = (items || []).map((x) => ({ ...x }));
  const byId = new Map();
  const byName = new Map();
  for (const it of next) {
    if (it.id != null) byId.set(String(it.id), it);
    const k = String(it.name ?? "").trim().toLowerCase();
    if (k && !byName.has(k)) byName.set(k, it);
  }
  const posted = [], unmatched = [];
  for (const l of lines || []) {
    const qty = Math.max(0, n(l.qty));
    if (qty <= 0) continue;
    const it = (l.itemId != null && byId.has(String(l.itemId)))
      ? byId.get(String(l.itemId))
      : byName.get(String(l.name ?? "").trim().toLowerCase());
    if (!it) { unmatched.push(l); continue; }
    const { stock, cost } = weightedAverageCost(it.stock, it.cost, qty, l.unitCost);
    it.stock = stock;
    it.cost = cost;
    posted.push({ id: it.id, name: it.name, addedQty: qty, stock, cost });
  }
  return { items: next, posted, unmatched };
}
