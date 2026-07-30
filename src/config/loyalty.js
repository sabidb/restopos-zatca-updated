// ═══════════════════════════════════════════════════════════════════
// LOYALTY CONFIG — earn/redeem rules, per business type.
//
// Reconciled with the app's EXISTING loyalty system (customers carry a
// `loyaltyPoints` field; the CRM redeems 100 pts = SAR 10). We keep that
// redemption rate and the CRM's spend-based tiers untouched, and only ADD:
//   • auto-earn on each sale (earnPerSAR)
//   • redeem-at-checkout at the same 100 pts = SAR 10 rate
//
// Loyalty is OFF unless a business type sets features.loyalty=true, so
// restaurant/supermarket are unaffected. Tiers are intentionally NOT here —
// they stay a CRM concept (getTier(totalSpent)); this module is points only.
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_LOYALTY = {
  earnPerSAR: 1,           // 1 point earned per 1 SAR spent
  redeemPointsPerSAR: 10,  // 10 points = SAR 1  ⇒  100 points = SAR 10 (matches the CRM)
  minRedeemPoints: 100,    // can't redeem fewer than this (same threshold as the CRM)
};

// The active rules for a profile: its own loyalty overrides merged over the
// defaults, or null when loyalty is off for the type.
export function loyaltyRulesForProfile(profile){
  if(!profile?.features?.loyalty) return null;
  const custom = (profile.loyalty && typeof profile.loyalty === "object") ? profile.loyalty : {};
  return { ...DEFAULT_LOYALTY, ...custom };
}
