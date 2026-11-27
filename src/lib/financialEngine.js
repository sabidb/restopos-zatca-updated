// Canonical financial calculation foundation (audit-phase).
 // Integer-cent arithmetic prevents binary-float drift. This module is intentionally
 // isolated until existing POS/report/ZATCA paths are reconciled and owner/accountant
 // approves the versioned rounding policy. Do not silently migrate historic records.
const cents = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError("Money value must be finite");
  return Math.sign(n) * Math.floor(Math.abs(n) * 100 + 0.5);
};
const fromCents = (c) => c / 100;
const roundDivHalfUp = (numerator, denominator) => {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) throw new TypeError("Expected integer numerator and positive denominator");
  return Math.floor((numerator + denominator / 2) / denominator);
};
const normalizeRateBps = (rate) => {
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new RangeError("VAT rate must be between 0 and 100 percent");
  return Math.floor(n * 100 + 0.5);
};
export function splitInclusiveCents(totalCents, ratePercent = 15) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new TypeError("Total must be non-negative integer cents");
  const rateBps = normalizeRateBps(ratePercent);
  if (rateBps === 0) return { netCents: totalCents, vatCents: 0, totalCents };
  const netCents = roundDivHalfUp(totalCents * 10000, 10000 + rateBps);
  return { netCents, vatCents: totalCents - netCents, totalCents };
}
export function calculateSale(items = [], discount = 0) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const lines = items.map((item, index) => {
    const qty = Number(item?.qty ?? item?.quantity ?? 0);
    if (!Number.isFinite(qty) || qty < 0) throw new RangeError("Quantity must be finite and non-negative");
    const unitCents = cents(item?.price ?? item?.unitPrice ?? 0);
    const rawLineCents = cents(fromCents(unitCents) * qty);
    const rateBps = normalizeRateBps(item?.vatRate ?? item?.rate ?? 15);
    return { index, id: item?.id ?? String(index), name: item?.name ?? "", qty, unitCents, rawLineCents, rateBps };
  });
  const subtotalCents = lines.reduce((s, l) => s + l.rawLineCents, 0);
  const discountCents = cents(discount);
  if (discountCents < 0 || discountCents > subtotalCents) throw new RangeError("Discount must be between zero and subtotal");
  const totalCents = subtotalCents - discountCents;
  const allocations = lines.map(l => {
    if (!subtotalCents) return { base: 0, rem: 0 };
    const numerator = discountCents * l.rawLineCents;
    return { base: Math.floor(numerator / subtotalCents), rem: numerator % subtotalCents };
  });
  const remaining = discountCents - allocations.reduce((s, a) => s + a.base, 0);
  const order = allocations.map((a, i) => ({ i, rem: a.rem })).sort((a,b) => b.rem - a.rem || a.i - b.i);
  for (let j = 0; j < remaining; j++) allocations[order[j % order.length].i].base++;
  const computedLines = lines.map((l, i) => {
    const inclusiveCents = l.rawLineCents - allocations[i].base;
    const netCents = l.rateBps === 0 ? inclusiveCents : roundDivHalfUp(inclusiveCents * 10000, 10000 + l.rateBps);
    const vatCents = inclusiveCents - netCents;
    return { ...l, discountCents: allocations[i].base, inclusiveCents, netCents, vatCents };
  });
  return {
    subtotal: fromCents(subtotalCents), discount: fromCents(discountCents), total: fromCents(totalCents),
    net: fromCents(computedLines.reduce((s,l)=>s+l.netCents,0)),
    vat: fromCents(computedLines.reduce((s,l)=>s+l.vatCents,0)),
    lines: computedLines.map(l => ({ id:l.id, name:l.name, qty:l.qty, unitPrice:fromCents(l.unitCents), gross:fromCents(l.rawLineCents), discount:fromCents(l.discountCents), total:fromCents(l.inclusiveCents), net:fromCents(l.netCents), vat:fromCents(l.vatCents), vatRate:l.rateBps/100 })),
  };
}
export function assertSaleReconciles(result) {
  const errors = [];
  if (cents(result.total) !== cents(result.net) + cents(result.vat)) errors.push("total != net + VAT");
  if (cents(result.subtotal) - cents(result.discount) !== cents(result.total)) errors.push("subtotal - discount != total");
  const lineTotal = result.lines.reduce((s,l)=>s+cents(l.total),0);
  const lineNet = result.lines.reduce((s,l)=>s+cents(l.net),0);
  const lineVat = result.lines.reduce((s,l)=>s+cents(l.vat),0);
  if (lineTotal !== cents(result.total)) errors.push("sum of line totals != sale total");
  if (lineNet !== cents(result.net)) errors.push("sum of line net != sale net");
  if (lineVat !== cents(result.vat)) errors.push("sum of line VAT != sale VAT");
  if (errors.length) throw new Error(errors.join("; "));
  return true;
}
