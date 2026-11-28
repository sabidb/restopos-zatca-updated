// ═══════════════════════════════════════════════════════════════════
// CHECKOUT — the pure money decisions of the payment screen: discounts,
// the final payable total, cash change, and split-payment validation.
//
// This is the correctness-critical path a cashier hits on every sale, and it
// had no automated coverage. The logic is extracted verbatim from PaymentModal
// so behaviour is unchanged (locked by checkout.test.mjs); the component now
// calls these instead of recomputing inline.
// ═══════════════════════════════════════════════════════════════════
import { round2tx } from "./tax.js";
import { calculateSale, assertSaleReconciles } from "./financialEngine.js";
import { productVatRate } from "./taxCategories.js";

const num = (v) => Number(v) || 0;
const pf = (v) => parseFloat(v) || 0;

/**
 * Canonical checkout financial calculation: discounts are allocated in cents,
 * VAT is calculated by tax category/rate, and the sale is asserted to reconcile.
 * This is a new opt-in integration seam; existing UI behavior is unchanged until
 * its checkout call site is switched to this helper.
 */
export function calculateCheckoutSale(items = [], totalDiscount = 0) {
  const ratedItems = (items || []).map((item) => ({
    ...item,
    vatRate: productVatRate(item) * 100,
  }));
  const result = calculateSale(ratedItems, totalDiscount);
  assertSaleReconciles(result);
  return result;
}

/** Manual discount on the subtotal: percent or flat, never more than the subtotal. */
export function discountManual(subtotal, { type, value } = {}) {
  const s = num(subtotal);
  const v = pf(value);
  return type === "%" ? Math.min(s, (s * v) / 100) : Math.min(s, v);
}

/** Promo discount on the subtotal: percent (uncapped, as today) or flat (capped). */
export function discountPromo(subtotal, promo) {
  if (!promo) return 0;
  const s = num(subtotal);
  return promo.type === "%" ? (s * promo.value) / 100 : Math.min(s, promo.value);
}

/** Final payable (VAT-inclusive) total after all discounts, never below 0, rounded. */
export function totalAfterDiscount(origTotal, totalDiscount) {
  return round2tx(Math.max(0, num(origTotal) - num(totalDiscount)));
}

/** Change owed to the customer for a cash payment. */
export function cashChange(total, cashGiven) {
  return Math.max(0, pf(cashGiven) - num(total));
}

/** The cashier has entered some cash, but not enough. */
export function isCashShort(total, cashGiven) {
  const c = pf(cashGiven);
  return c > 0 && c < num(total);
}

/** Cash tendered covers the total. */
export function cashSufficient(total, cashGiven) {
  return pf(cashGiven) >= num(total);
}

/** Split payment: how far cash+card is from the total (rounded; 0 = exact). */
export function splitDiff(total, cash, card) {
  return round2tx(pf(card) + pf(cash) - num(total));
}

/** Split payment adds up to the total (within half a halala). */
export function splitValid(total, cash, card) {
  return Math.abs(splitDiff(total, cash, card)) < 0.01;
}

/** Whether the sale can be confirmed for the chosen method. */
export function paymentReady({ method, total, cashGiven, splitCash, splitCard }) {
  const t = num(total);
  if (!(t > 0)) return false;
  if (method === "Cash") return cashSufficient(t, cashGiven);
  if (method === "Both") return splitValid(t, splitCash, splitCard);
  return true; // Card / digital — ready once there's a positive total
}
