// Canonical financial calculation foundation (audit-phase).
 // Integer-cent arithmetic prevents binary-float drift. This module is intentionally
 // isolated until existing POS/report/ZATCA paths are reconciled and owner/accountant
 // approves the versioned rounding policy. Do not silently migrate historic records.
const cents = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError("Money value must be finite");
  const rounded = Math.sign(n) * Math.floor(Math.abs(n) * 100 + 0.5);
  if (!Number.isSafeInteger(rounded)) throw new RangeError("Money value exceeds safe cent precision");
  return rounded;
};
const fromCents = (c) => c / 100;
const roundDivHalfUp = (numerator, denominator) => {
  const n = typeof numerator === "bigint" ? numerator : BigInt(numerator);
  const d = typeof denominator === "bigint" ? denominator : BigInt(denominator);
  if (d <= 0n) throw new TypeError("Expected positive denominator");
  return Number((n + d / 2n) / d);
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
  const netCents = roundDivHalfUp(BigInt(totalCents) * 10000n, BigInt(10000 + rateBps));
  return { netCents, vatCents: totalCents - netCents, totalCents };
}
export function calculateSale(items = [], discount = 0) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const lines = items.map((item, index) => {
    const qty = Number(item?.qty ?? item?.quantity ?? 0);
    if (!Number.isFinite(qty) || qty < 0) throw new RangeError("Quantity must be finite and non-negative");
    const unitCents = cents(item?.price ?? item?.unitPrice ?? 0);
    if (unitCents < 0) throw new RangeError("Unit price must be non-negative");
    const rawLineCents = cents(fromCents(unitCents) * qty);
    const rateBps = normalizeRateBps(item?.vatRate ?? item?.rate ?? 15);
    return { index, id: item?.id ?? String(index), name: item?.name ?? "", qty, unitCents, rawLineCents, rateBps };
  });
  const subtotalCents = lines.reduce((s, l) => s + l.rawLineCents, 0);
  if (!Number.isSafeInteger(subtotalCents)) throw new RangeError("Subtotal exceeds safe cent precision");
  const discountCents = cents(discount);
  if (discountCents < 0 || discountCents > subtotalCents) throw new RangeError("Discount must be between zero and subtotal");
  const totalCents = subtotalCents - discountCents;
  if (!Number.isSafeInteger(totalCents)) throw new RangeError("Total exceeds safe cent precision");
  const allocations = lines.map(l => {
    if (!subtotalCents) return { base: 0, rem: 0 };
    const numerator = BigInt(discountCents) * BigInt(l.rawLineCents);
    const denominator = BigInt(subtotalCents);
    return { base: Number(numerator / denominator), rem: numerator % denominator };
  });
  const remaining = discountCents - allocations.reduce((s, a) => s + a.base, 0);
  const order = allocations.map((a, i) => ({ i, rem: a.rem })).sort((a,b) => (a.rem === b.rem ? a.i - b.i : (a.rem > b.rem ? -1 : 1)));
  for (let j = 0; j < remaining; j++) allocations[order[j % order.length].i].base++;
  const discountedLines = lines.map((l, i) => ({
    ...l,
    discountCents: allocations[i].base,
    inclusiveCents: l.rawLineCents - allocations[i].base,
  }));
  // Calculate VAT once per rate group, matching the transaction/report aggregate
  // path. Per-line VAT rounding can understate a one-cent-heavy sale dramatically.
  const groups = new Map();
  discountedLines.forEach((line, index) => {
    const group = groups.get(line.rateBps) || { rateBps: line.rateBps, indices: [], grossCents: 0 };
    group.indices.push(index);
    group.grossCents += line.inclusiveCents;
    groups.set(line.rateBps, group);
  });
  const netByLine = new Array(discountedLines.length).fill(0);
  for (const group of groups.values()) {
    if (!group.grossCents) continue;
    const groupNetCents = group.rateBps === 0
      ? group.grossCents
      : roundDivHalfUp(BigInt(group.grossCents) * 10000n, BigInt(10000 + group.rateBps));
    const groupAllocations = group.indices.map(index => {
      const gross = discountedLines[index].inclusiveCents;
      const numerator = BigInt(gross) * BigInt(groupNetCents);
      return { index, base: Number(numerator / BigInt(group.grossCents)), rem: numerator % BigInt(group.grossCents) };
    });
    const leftover = groupNetCents - groupAllocations.reduce((sum, a) => sum + a.base, 0);
    groupAllocations.sort((a,b) => (a.rem === b.rem ? a.index - b.index : (a.rem > b.rem ? -1 : 1)));
    for (let j = 0; j < leftover; j++) groupAllocations[j].base++;
    for (const allocation of groupAllocations) netByLine[allocation.index] = allocation.base;
  }
  const computedLines = discountedLines.map((l, i) => {
    const netCents = netByLine[i];
    const vatCents = l.inclusiveCents - netCents;
    return { ...l, netCents, vatCents };
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
