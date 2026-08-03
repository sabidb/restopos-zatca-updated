// ═══════════════════════════════════════════════════════════════════
// PLAN FEATURES — single source of truth for what each subscription tier
// unlocks. Every feature gate in the app routes through can()/planRank()
// here, so tier rules live in ONE place instead of scattered `if` checks.
//
// Tiers, low → high:  basic  <  professional  <  premium
// ═══════════════════════════════════════════════════════════════════

export const PLAN_ORDER = ["basic", "professional", "premium"];

// Rank of a plan id (unknown/missing → basic). Higher = more access.
export function planRank(planId) {
  const i = PLAN_ORDER.indexOf(planId || "basic");
  return i < 0 ? 0 : i;
}

// The minimum plan each gated capability requires. A capability that is NOT
// listed here is available to everyone (part of the Basic core — e.g. ZATCA
// invoicing, receipts, KOT, Close Day, unlimited items & tables).
export const CAP_MIN_PLAN = {
  // Professional and up
  inventory:             "professional", // dedicated Inventory Management screen
  advancedAnalytics:     "professional", // hourly patterns, staff performance, deep analytics
  customInvoiceBranding: "professional", // custom receipt / invoice branding
  dataExport:            "professional", // Excel / PDF / CSV export
  multiLocation:         "professional", // multi-branch sync
  accessControl:         "professional", // device login approval & granular roles
  managerConsole:        "professional", // remote Manager Console app

  // Premium only
  supermarketMode:       "premium", // supermarket / hypermarket (barcode) till
  loyalty:               "premium", // customer loyalty programme
  employeeTracking:      "premium", // employee performance tracking
  whatsappReceipts:      "premium", // WhatsApp / SMS receipts
  apiAccess:             "premium", // API access
  whiteLabel:            "premium", // white-label branding
  realtimeAnalytics:     "premium", // real-time analytics & insights
};

// Does this plan unlock this capability?
export function can(planId, capability) {
  const min = CAP_MIN_PLAN[capability];
  if (!min) return true; // ungated → everyone gets it
  return planRank(planId) >= planRank(min);
}

// ── Premium trial ─────────────────────────────────────────────────
// A client can be given a temporary taste of a higher tier (default Premium)
// without changing their real subscriptionPlan. While the trial is live the
// whole app treats them as that tier; when it lapses they fall straight back
// to their own plan — no hard lock, nothing deleted.
export const TRIAL_PLAN = "premium";
export const DEFAULT_TRIAL_DAYS = 14;

// {active, daysLeft, hoursLeft, endsAt, startedAt, used}
export function trialStatus(license) {
  const untilRaw = license?.premiumTrialUntil;
  const until = untilRaw ? new Date(untilRaw).getTime() : null;
  const now = Date.now();
  const active = until != null && !isNaN(until) && until > now;
  return {
    active,
    daysLeft: active ? Math.ceil((until - now) / 86400000) : 0,
    hoursLeft: active ? Math.ceil((until - now) / 3600000) : 0,
    endsAt: until && !isNaN(until) ? new Date(until) : null,
    startedAt: license?.premiumTrialStart || null,
    used: !!license?.premiumTrialUsed,
  };
}

// The tier the app should actually enforce: the trial tier while a trial is
// live, otherwise the client's own plan.
export function effectivePlan(license) {
  if (trialStatus(license).active) return TRIAL_PLAN;
  return license?.subscriptionPlan || "basic";
}

// ── Grandfathering ────────────────────────────────────────────────
// Our goal is winning and keeping customers, not taking features away. So
// accounts that already existed when tier-enforcement rolled out keep full
// access forever — we never disrupt a live business. Only clients who sign up
// from the rollout date onward are held to their plan's limits strictly.
export const ENFORCE_FROM = new Date("2026-08-03T00:00:00+03:00").getTime();

export function isGrandfathered(license) {
  const raw = license?.activatedAt || license?.submittedAt || license?.grandfatherSince || null;
  if (!raw) return true;               // unknown age → be generous, never lock out
  const t = new Date(raw).getTime();
  if (isNaN(t)) return true;
  return t < ENFORCE_FROM;             // predates enforcement → grandfathered
}

// The gate the whole app should use: a capability is available if the client's
// effective plan (real plan, or the trial tier while a trial is live) unlocks
// it OR the account is grandfathered. Pass the full license object.
export function canUse(license, capability) {
  return can(effectivePlan(license), capability) || isGrandfathered(license);
}

// Numeric-limit gate (users/devices) with the same grandfathering. Returns the
// effective cap, or null for "unlimited" (grandfathered or plan is unlimited).
export function effectiveLimit(license, limitValue) {
  if (isGrandfathered(license)) return null; // existing clients: no new cap
  return limitValue ?? null;
}

// The lowest plan that unlocks a capability (for "Upgrade to X" copy).
export function requiredPlan(capability) {
  return CAP_MIN_PLAN[capability] || "basic";
}

// Reporting history window (days) a plan can see. null = unlimited.
export const HISTORY_DAYS = { basic: 7, professional: 30, premium: 90 };
export function historyDays(planId) {
  return HISTORY_DAYS[planId || "basic"] ?? 7;
}

// The features a client GAINS moving oldId → newId, computed from the plans'
// own feature lists. Used to show "here's what you just unlocked".
export function benefitsGained(oldId, newId, PLANS) {
  const oldFeatures = new Set((PLANS?.[oldId]?.features) || []);
  return ((PLANS?.[newId]?.features) || []).filter((f) => !oldFeatures.has(f));
}

// True when newId is a strictly higher tier than oldId (an upgrade, not a
// downgrade or a no-op) — the trigger for the celebration screen.
export function isUpgrade(oldId, newId) {
  return planRank(newId) > planRank(oldId);
}
