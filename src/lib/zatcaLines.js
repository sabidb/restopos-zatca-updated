// ═══════════════════════════════════════════════════════════════════
// ZATCA LINE MATH — pure cart-to-line-item conversion.
//
// No React, no storage. Callers pass a cart of VAT-inclusive priced items
// and get back the line items to submit plus the totals those lines
// produce. The totals are computed exactly the way the signing library
// computes them, so the figures stored against a sale are the figures in
// the signed XML rather than an independent guess at them.
//
// Three rules govern the conversion and they pull against each other:
//
//   * Menu prices include VAT; ZATCA wants tax-exclusive amounts.
//   * The unit price may carry at most two decimals (BR-DEC-23), and the
//     line net must equal unit price × quantity less allowances, so the
//     unit price has to be rounded BEFORE it is multiplied out.
//   * The invoice should total what the customer actually paid.
//
// Rounding the unit price leaves a residual of a halala or two per line
// against the cash taken. That residual is folded into the same
// line-level allowance that carries the discount — which is what an
// allowance is for — and the size of the allowance is then searched so
// the document totals to the cash where that is reachable at all. A cart
// with no discount and clean prices produces no allowance.
// ═══════════════════════════════════════════════════════════════════

export const ZATCA_VAT_RATE = 0.15;

// The signing library narrows every amount it computes — line nets,
// per-line VAT, tax subtotals, document totals — to two decimals rounded
// half-up, as BR-KSA-DEC requires. (The library ships that method as a
// truncation; the service overrides it, because truncating loses up to a
// halala per line always in the same direction and leaves every document
// understating the tax due.) Mirrored here so the totals stored against a
// sale are the totals in the signed XML rather than a second opinion.
//
// The rounding works from the number's shortest decimal representation:
// 4.56 is held as 4.5599999999999996 and 1.005 as 1.00499999999999989,
// both of which round the wrong way if the raw float is scaled directly.
export const round2 = (n) => {
  const value = Number(n);
  if (!Number.isFinite(value)) return 0;
  return Math.round(Number((value * 100).toPrecision(15))) / 100;
};

/**
 * Allocates a total allowance across lines in proportion to their value.
 *
 * Each share is rounded to two decimals, which leaves the shares summing
 * a halala either side of the target; the difference goes on the largest
 * line, where it is proportionally smallest. No line is allocated more
 * than it is worth — a negative taxable amount fails BR-KSA-DEC-02.
 */
export function allocateAllowance(lineNets, totalAllowance) {
  const shares = lineNets.map(() => 0);
  const base = lineNets.reduce((sum, net) => sum + net, 0);
  if (!(totalAllowance > 0) || !(base > 0)) return shares;

  const capped = Math.min(totalAllowance, base);
  lineNets.forEach((net, i) => { shares[i] = round2((net / base) * capped); });

  const residual = round2(capped - shares.reduce((sum, share) => sum + share, 0));
  if (residual !== 0) {
    let largest = 0;
    lineNets.forEach((net, i) => { if (net > lineNets[largest]) largest = i; });
    shares[largest] = round2(shares[largest] + residual);
  }

  return shares.map((share, i) => Math.max(0, Math.min(round2(share), round2(lineNets[i]))));
}

/**
 * The document totals a set of lines and allowances will produce, derived
 * the way the signing library derives them: each line narrowed to two
 * decimals by truncation, the running sums rounded once at the end.
 */
function totalsFor(lineNets, shares) {
  let subtotal = 0;
  let vat = 0;
  lineNets.forEach((net, i) => {
    const lineNet = round2(net - shares[i]);
    subtotal += lineNet;
    vat += round2(lineNet * ZATCA_VAT_RATE);
  });
  subtotal = round2(subtotal);
  vat = round2(vat);
  return { subtotal, vat_amount: vat, total: round2(subtotal + vat) };
}

/**
 * Builds the ZATCA line items for a cart and the totals they produce.
 *
 * `items` carry VAT-inclusive unit prices, as the menu does.
 * `discountGross` is the VAT-inclusive discount the customer was given,
 * and `paidGross` is what they actually paid. Passing `paidGross` lets
 * the allowance be sized so the invoice ties to the till.
 */
export function buildZatcaLines(items, { discountGross = 0, discountReason = "Discount", paidGross = null } = {}) {
  const source = (items || []).map((it, idx) => ({
    id: String(idx + 1),
    name: it.name || `Item ${idx + 1}`,
    quantity: it.qty,
    unitNet: round2((Number(it.price) || 0) / (1 + ZATCA_VAT_RATE)),
  }));

  let lineNets = source.map((it) => round2(it.unitNet * it.quantity));
  let grossOfLines = round2(lineNets.reduce((sum, net) => sum + net, 0));

  // Where the cash taken is known, size the allowance so the document
  // totals to it. The starting value — the discount plus the gap left by
  // rounding each unit price — usually lands within a halala or two but
  // not reliably on the nose, because rounding each line's net and its VAT
  // moves the total by less than the change in allowance that caused it.
  //
  // So the near neighbourhood is searched: each line's share is nudged by
  // up to ten halalas in turn and the first combination that totals to the
  // cash exactly wins. If none does — for some carts no allocation can
  // reach the figure at all, since a line contributes its net plus rounded
  // VAT and the reachable totals skip values — the closest is kept.
  const wanted = paidGross != null ? round2(paidGross) : null;

  // An allowance can only bring a line down, so the lines have to start at
  // or above what the document should come to. Rounding a unit price to the
  // nearest halala can round it down, and on a multi-unit line that shortfall
  // is multiplied — leaving a target the allowance can never reach, which is
  // what used to strand a third of carts a few halalas below the cash taken.
  // Where that happens a unit price is nudged up by one halala, highest
  // quantity first since that closes the most ground per nudge, until the
  // lines clear the target. The allowance then brings them back down to it.
  if (wanted != null) {
    const byQuantity = source.map((it, i) => i).sort((a, b) => source[b].quantity - source[a].quantity);
    const targetNet = round2(wanted / (1 + ZATCA_VAT_RATE));
    for (let guard = 0; guard < 200 && grossOfLines < targetNet; guard += 1) {
      const i = byQuantity[guard % byQuantity.length];
      source[i].unitNet = round2(source[i].unitNet + 0.01);
      lineNets = source.map((it) => round2(it.unitNet * it.quantity));
      grossOfLines = round2(lineNets.reduce((sum, net) => sum + net, 0));
    }
  }

  const seed = wanted != null
    ? round2(grossOfLines - wanted / (1 + ZATCA_VAT_RATE))
    : round2(discountGross / (1 + ZATCA_VAT_RATE));

  let shares = allocateAllowance(lineNets, Math.max(0, seed));
  let totals = totalsFor(lineNets, shares);

  if (wanted != null && totals.total !== wanted) {
    let best = { shares, totals, miss: Math.abs(round2(totals.total - wanted)) };

    // Each pass restarts from the best allocation the last one found, so a
    // total that needs two lines moved is still reachable — moving one line
    // gets closer, and the next pass moves the other. Passes stop as soon as
    // one fails to improve.
    refine:
    for (let pass = 0; pass < 4; pass += 1) {
      const from = best.shares;
      for (let i = 0; i < lineNets.length; i += 1) {
        for (let halalas = -10; halalas <= 10; halalas += 1) {
          if (halalas === 0) continue;
          const trial = from.slice();
          const moved = round2(trial[i] + halalas / 100);
          if (moved < 0 || moved > round2(lineNets[i])) continue;
          trial[i] = moved;

          const trialTotals = totalsFor(lineNets, trial);
          const miss = Math.abs(round2(trialTotals.total - wanted));
          if (miss < best.miss) best = { shares: trial, totals: trialTotals, miss };
          if (miss === 0) break refine;
        }
      }
      if (best.shares === from) break;
    }

    // A total can also be out of reach for every single-line nudge yet sit
    // one halala of allowance away from a different SPLIT of the same
    // allowance: the amount taken off the document does not change, but
    // which line it comes off does, and each line's VAT rounds separately.
    // Cheap to search and it closes cases the nudges cannot.
    if (best.miss !== 0) {
      shift:
      for (let from = 0; from < lineNets.length; from += 1) {
        for (let to = 0; to < lineNets.length; to += 1) {
          if (from === to) continue;
          for (let halalas = 1; halalas <= 3; halalas += 1) {
            const trial = best.shares.slice();
            const taken = round2(trial[from] - halalas / 100);
            const given = round2(trial[to] + halalas / 100);
            if (taken < 0 || given > round2(lineNets[to])) continue;
            trial[from] = taken;
            trial[to] = given;

            const trialTotals = totalsFor(lineNets, trial);
            const miss = Math.abs(round2(trialTotals.total - wanted));
            if (miss < best.miss) best = { shares: trial, totals: trialTotals, miss };
            if (miss === 0) break shift;
          }
        }
      }
    }

    shares = best.shares;
    totals = best.totals;
  }

  const reason = discountGross > 0 ? discountReason : "Rounding of VAT-inclusive unit price";
  const lines = source.map((it, i) => ({
    id: it.id,
    name: it.name,
    quantity: it.quantity,
    tax_exclusive_price: it.unitNet,
    VAT_percent: ZATCA_VAT_RATE,
    ...(shares[i] > 0 ? { discounts: [{ amount: shares[i], reason }] } : {}),
  }));

  return { lines, ...totals };
}
