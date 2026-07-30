// ═══════════════════════════════════════════════════════════════════
// LOYALTY CORE — pure points earn / redeem math.
//
// Operates on the app's existing `loyaltyPoints` field. No React, no
// storage, no business-type reads — callers pass the rules (from
// loyaltyRulesForProfile). A null `rules` means loyalty is off and every
// function no-ops safely. Tiers live in the CRM (spend-based) and are not
// this module's concern.
// ═══════════════════════════════════════════════════════════════════

// Points earned for spending `amount` SAR under `rules`.
export function earnPoints(amount, rules){
  if(!rules) return 0;
  const n = Math.floor((Number(amount)||0) * (rules.earnPerSAR||0));
  return n > 0 ? n : 0;
}

// SAR value of redeeming `points` under `rules` (respects the min-redeem
// threshold). With redeemPointsPerSAR=10, 100 points → SAR 10.
export function redeemValue(points, rules){
  if(!rules) return 0;
  const pts = Number(points)||0;
  if(pts < (rules.minRedeemPoints||0)) return 0;
  const per = rules.redeemPointsPerSAR||0;
  if(per <= 0) return 0;
  return Math.floor(pts / per * 100) / 100; // 2dp SAR
}

// Max points redeemable against a bill of `billTotal` SAR — never more value
// than the bill is worth, never more than the customer holds.
export function maxRedeemablePoints(points, billTotal, rules){
  if(!rules) return 0;
  const per = rules.redeemPointsPerSAR||0;
  const pts = Number(points)||0;
  if(per <= 0 || pts < (rules.minRedeemPoints||0)) return 0;
  const capByBill = Math.floor((Number(billTotal)||0) * per);
  return Math.max(0, Math.min(pts, capByBill));
}

// New loyaltyPoints balance after a sale: add what was earned, subtract what
// was redeemed, never below zero. Pure — returns the number, caller persists.
export function nextLoyaltyPoints(currentPoints, earned, redeemed){
  const cur = Number(currentPoints)||0;
  const e = Number(earned)||0;
  const r = Number(redeemed)||0;
  return Math.max(0, cur + e - r);
}
