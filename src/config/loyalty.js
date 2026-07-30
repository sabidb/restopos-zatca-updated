// ═══════════════════════════════════════════════════════════════════
// LOYALTY CONFIG — earn/redeem rules and tiers, per business type.
//
// These are the "sensible defaults" — everything is data you can tweak
// later without touching logic. Loyalty is OFF unless a business type sets
// features.loyalty=true, so restaurant/supermarket are unaffected.
// ═══════════════════════════════════════════════════════════════════

// Default rules used when a type enables loyalty without overriding them.
export const DEFAULT_LOYALTY = {
  earnPerSAR: 1,          // 1 point per 1 SAR spent (on the pre-VAT or total? see loyalty.js)
  redeemPointsPerSAR: 100, // 100 points = 1 SAR of redemption value
  minRedeemPoints: 100,    // can't redeem fewer than this
  // Tiers in ascending order; a customer's tier is the highest whose
  // `minPoints` they've reached (by lifetime points earned).
  tiers: [
    { id:"bronze", label:"Bronze", labelAr:"برونزي", minPoints:0,    color:"#CD7F32" },
    { id:"silver", label:"Silver", labelAr:"فضي",    minPoints:500,  color:"#9AA0AD" },
    { id:"gold",   label:"Gold",   labelAr:"ذهبي",   minPoints:2000, color:"#F0A500" },
  ],
};

// The active rules for a profile: its own loyalty config merged over the
// defaults, or the defaults. Returns null when loyalty is off for the type.
export function loyaltyRulesForProfile(profile){
  if(!profile?.features?.loyalty) return null;
  const custom = (profile.loyalty && typeof profile.loyalty === "object") ? profile.loyalty : {};
  return { ...DEFAULT_LOYALTY, ...custom, tiers: custom.tiers || DEFAULT_LOYALTY.tiers };
}
