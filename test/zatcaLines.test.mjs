import test from 'node:test';
import assert from 'node:assert';
import { buildZatcaLines, allocateAllowance, round2, ZATCA_VAT_RATE } from '../src/lib/zatcaLines.js';

const cart = (...items) => items.map(([name, price, qty]) => ({ name, price, qty }));
const grossOf = (items) => round2(items.reduce((s, i) => s + i.price * i.qty, 0));

test('a clean cart reports the cash taken and carries no allowance', () => {
  const items = cart(['Mixed Grill', 57.5, 2]);
  const r = buildZatcaLines(items, { paidGross: 115 });

  assert.strictEqual(r.total, 115);
  assert.strictEqual(r.subtotal, 100);
  assert.strictEqual(r.vat_amount, 15);
  assert.strictEqual(r.lines[0].tax_exclusive_price, 50);
  assert.strictEqual(r.lines[0].discounts, undefined);
});

test('a discount reaches ZATCA as a line allowance with its reason', () => {
  const items = cart(['Mixed Grill', 57.5, 2]);
  const r = buildZatcaLines(items, { discountGross: 11.5, discountReason: 'Ramadan promo', paidGross: 103.5 });

  assert.strictEqual(r.total, 103.5);
  assert.strictEqual(r.vat_amount, 13.5);
  assert.strictEqual(r.lines[0].discounts[0].reason, 'Ramadan promo');
  assert.strictEqual(r.lines[0].discounts[0].amount, 10);
});

test('the discounted total is reported, not the menu total', () => {
  // The defect this replaces: a discounted sale was reported at full price,
  // overstating output VAT on every one of them.
  const items = cart(['Burger', 40, 1], ['Fries', 15, 2]);
  const undiscounted = buildZatcaLines(items, { paidGross: 70 });
  const discounted = buildZatcaLines(items, { discountGross: 20, discountReason: 'Staff', paidGross: 50 });

  assert.strictEqual(undiscounted.total, 70);
  assert.strictEqual(discounted.total, 50);
  assert.ok(discounted.vat_amount < undiscounted.vat_amount);
});

test('a fully comped order reports zero, not a negative line', () => {
  const items = cart(['Dessert', 20, 1]);
  const r = buildZatcaLines(items, { discountGross: 20, discountReason: 'Comped', paidGross: 0 });

  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.subtotal, 0);
  assert.ok(r.lines.every((l) => (l.discounts?.[0]?.amount ?? 0) <= round2(l.tax_exclusive_price * l.quantity)));
});

test('unit prices carry at most two decimals', () => {
  // BR-DEC-23. A VAT-inclusive menu price divided by 1.15 rarely terminates,
  // and the unresolved quotient used to be sent as-is.
  const items = cart(['Karak', 4.75, 3], ['Samosa', 6.5, 2], ['Juice', 13.99, 1]);
  const r = buildZatcaLines(items, { paidGross: grossOf(items) });

  for (const line of r.lines) {
    assert.strictEqual(round2(line.tax_exclusive_price), line.tax_exclusive_price, `${line.name} price has >2 decimals`);
    const amount = line.discounts?.[0]?.amount;
    if (amount != null) assert.strictEqual(round2(amount), amount);
  }
});

test('no line is ever allowanced below zero', () => {
  const shares = allocateAllowance([10, 5, 1], 100);
  assert.deepStrictEqual(shares, [10, 5, 1]);
});

test('an allowance of nothing allocates nothing', () => {
  assert.deepStrictEqual(allocateAllowance([10, 5], 0), [0, 0]);
  assert.deepStrictEqual(allocateAllowance([], 5), []);
});

test('the reported total ties to the cash taken, or misses by at most two halalas', () => {
  // Menu prices include VAT, so a net unit price rounded to the two decimals
  // BR-DEC-23 allows cannot always be multiplied back to the exact gross. The
  // allowance absorbs that residual and closes the gap for the large majority
  // of carts; where the remaining totals are unreachable the miss is bounded
  // and no longer runs one way.
  let exact = 0;
  let worst = 0;
  const trials = 5000;
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const price = () => Math.round((1 + rand() * 149) * 100) / 100;

  for (let t = 0; t < trials; t += 1) {
    const items = Array.from({ length: 1 + Math.floor(rand() * 8) }, (_, i) => ({
      name: `Item ${i}`, price: price(), qty: 1 + Math.floor(rand() * 5),
    }));
    const gross = grossOf(items);
    const discount = rand() < 0.4 ? round2(gross * rand() * 0.3) : 0;
    const paid = round2(gross - discount);

    const r = buildZatcaLines(items, { discountGross: discount, discountReason: 'D', paidGross: paid });
    const drift = round2(r.total - paid);
    if (drift === 0) exact += 1;
    if (Math.abs(drift) > Math.abs(worst)) worst = drift;
  }

  assert.ok(exact / trials > 0.9, `only ${((exact / trials) * 100).toFixed(1)}% of carts tied exactly`);
  assert.ok(Math.abs(worst) <= 0.02, `worst drift was ${worst}, expected no more than two halalas`);
});

test('totals are internally consistent', () => {
  const items = cart(['A', 12.99, 2], ['B', 33.33, 1], ['C', 4.75, 3]);
  const r = buildZatcaLines(items, { paidGross: grossOf(items) });

  assert.strictEqual(r.total, round2(r.subtotal + r.vat_amount));
  // VAT is the sum of each line's rounded VAT, which is how the signing
  // library and ZATCA compute it. That is not the same number as the rounded
  // VAT of the summed net, and asserting the latter would be asserting a
  // different document than the one being issued.
  assert.ok(Math.abs(r.vat_amount - round2(r.subtotal * ZATCA_VAT_RATE)) <= 0.02);
});

test('an empty cart produces nothing rather than throwing', () => {
  const r = buildZatcaLines([], { paidGross: 0 });
  assert.deepStrictEqual(r.lines, []);
  assert.strictEqual(r.total, 0);
});
