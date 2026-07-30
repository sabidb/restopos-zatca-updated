// ═══════════════════════════════════════════════════════════════════
// LOYALTY CORE — pure points / tiers / redemption math.
//
// No React, no storage, no business-type reads. Callers pass in the rules
// (from loyaltyRulesForProfile) so this stays trivially testable and can't
// affect any type that hasn't enabled loyalty. A null `rules` means loyalty
// is off — every function then no-ops safely.
// ═══════════════════════════════════════════════════════════════════

// Points earned for spending `amount` SAR under `rules`.
export function earnPoints(amount, rules){
  if(!rules) return 0;
  const n = Math.floor((Number(amount)||0) * (rules.earnPerSAR||0));
  return n > 0 ? n : 0;
}

// The tier object a customer with `lifetimePoints` sits in (highest reached).
export function tierFor(lifetimePoints, rules){
  if(!rules) return null;
  const pts = Number(lifetimePoints)||0;
  let current = rules.tiers[0] || null;
  for(const tier of rules.tiers){ if(pts >= tier.minPoints) current = tier; }
  return current;
}

// SAR value of redeeming `points` under `rules` (respects min-redeem).
export function redeemValue(points, rules){
  if(!rules) return 0;
  const pts = Number(points)||0;
  if(pts < (rules.minRedeemPoints||0)) return 0;
  const per = rules.redeemPointsPerSAR||0;
  if(per <= 0) return 0;
  return Math.floor(pts / per * 100) / 100; // 2dp SAR
}

// Max points that can be redeemed against a bill of `billTotal` SAR — you
// can't redeem more value than the bill is worth.
export function maxRedeemablePoints(points, billTotal, rules){
  if(!rules) return 0;
  const per = rules.redeemPointsPerSAR||0;
  const pts = Number(points)||0;
  if(per <= 0 || pts < (rules.minRedeemPoints||0)) return 0;
  const capByBill = Math.floor((Number(billTotal)||0) * per);
  return Math.max(0, Math.min(pts, capByBill));
}

// Apply a completed sale to a customer record: add earned points, update
// lifetime total and tier. Returns a NEW customer object (never mutates).
// `redeemedPoints` are subtracted from the spendable balance.
export function applyEarn(customer, saleAmount, rules, redeemedPoints=0){
  if(!rules) return customer;
  const base = customer || {};
  const earned = earnPoints(saleAmount, rules);
  const lifetime = (Number(base.lifetimePoints)||0) + earned;
  const points = Math.max(0, (Number(base.points)||0) + earned - (Number(redeemedPoints)||0));
  const tier = tierFor(lifetime, rules);
  const history = Array.isArray(base.pointsHistory) ? base.pointsHistory : [];
  return {
    ...base,
    points,
    lifetimePoints: lifetime,
    tier: tier?.id || base.tier || null,
    pointsHistory: [
      { ts:new Date().toISOString(), earned, redeemed:Number(redeemedPoints)||0, balance:points },
      ...history,
    ].slice(0, 200),
  };
}
