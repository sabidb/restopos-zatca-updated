// ═══════════════════════════════════════════════════════════════════
// BUSINESS TYPES — single source of truth registry + helpers.
//
// One app, one codebase, every business type. The shared core (cart,
// barcode/menu till, ZATCA invoicing, payments, reports, cloud sync)
// is the SAME for all types and lives elsewhere. Everything that makes
// a type look or feel different is data: one entry here, plus that
// type's own folder (theme.js, registry entry, any type-only screens).
//
// Adding a type: create src/businessTypes/<type>/{index.js,theme.js},
// import its entry below, and drop it into BUSINESS_TYPES. Nothing else
// in the app needs to change — helpers read behaviour from the profile
// instead of scattered `if (isSupermarket())` checks.
//
// `src/config/businessTypes.js` re-exports everything here so existing
// imports (`./config/businessTypes.js`) keep working unchanged.
// ═══════════════════════════════════════════════════════════════════
import { LS } from "../lib/storage.js";
import { C } from "../lib/theme.js";

import { pharmacy } from "./pharmacy/index.js";
import { retail } from "./retail/index.js";
import { bakery } from "./bakery/index.js";
import { cafe } from "./cafe/index.js";
import { salon } from "./salon/index.js";

export const BUSINESS_TYPES = {
  restaurant: {
    id: "restaurant", label: "Restaurant", labelAr: "مطعم", icon: "🍽️",
    desc: "Tables, dine-in, kitchen tickets",
    posLayout: "grid", nav: "topbar",
    features: { tables: true, dineIn: true, kot: true, kitchen: true, kds: true, recipes: true, weighing: false, barcodeFirst: false },
    orderTypes: [["takeaway", "🥡", "Takeaway"], ["dine-in", "🍽", "Dine-in"], ["delivery", "🛵", "Delivery"]],
    hideAdvancedTabs: [],
    navLabels: {},
  },
  supermarket: {
    id: "supermarket", label: "Supermarket", labelAr: "سوبرماركت", icon: "🛒",
    desc: "Barcode checkout, weighed items",
    posLayout: "scan", nav: "sidebar",
    features: { tables: false, dineIn: false, kot: false, kitchen: false, kds: false, recipes: false, weighing: true, barcodeFirst: true },
    orderTypes: [["takeaway", "🛒", "Sale"], ["delivery", "🛵", "Delivery"]],
    hideAdvancedTabs: ["kitchen", "kds", "recipes"],
    navLabels: { create: "Products" },
  },
  // Large hypermarket (Lulu-style): supermarket till, plus the Phase-2 shared
  // systems switched ON — a Supervisor role with manager-approval overrides for
  // void/refund/price-override, and a customer loyalty/rewards programme.
  hypermarket: {
    id: "hypermarket", label: "Hypermarket", labelAr: "هايبر ماركت", icon: "🏬",
    desc: "Supervisor approvals, loyalty rewards",
    posLayout: "scan", nav: "sidebar",
    features: { tables: false, dineIn: false, kot: false, kitchen: false, kds: false, recipes: false, weighing: true, barcodeFirst: true, approvals: true, loyalty: true },
    orderTypes: [["takeaway", "🛒", "Sale"], ["delivery", "🛵", "Delivery"]],
    hideAdvancedTabs: ["kitchen", "kds", "recipes"],
    navLabels: { create: "Products" },
    roles: ["Admin", "Manager", "Supervisor", "Cashier"],
  },

  // ── Interface-only types (same core, own front design) ──────────────────
  pharmacy,
  retail,
  bakery,
  cafe,
  salon,
};

export const DEFAULT_BUSINESS_TYPE = "restaurant";

export function getBusinessType(license) {
  const lic = license || (typeof LS !== "undefined" ? LS.get("restopos_license_v2") : null);
  const t = lic && lic.businessType;
  return BUSINESS_TYPES[t] ? t : DEFAULT_BUSINESS_TYPE; // unknown/missing → default, never crashes
}

// The active type's full profile — the object the UI should read from.
export function bizProfile(license) { return BUSINESS_TYPES[getBusinessType(license)] || BUSINESS_TYPES[DEFAULT_BUSINESS_TYPE]; }

// One capability flag, e.g. bizFeature("tables") / bizFeature("kot").
export function bizFeature(name, license) { return !!bizProfile(license).features[name]; }

// Kept for compatibility across the app; now derived from the registry.
export function isSupermarket(license) { return getBusinessType(license) === "supermarket"; }

// The active type's colour override (its theme.js), or null for types that use
// the default palette. Pair with applyBizTheme() in ../lib/theme.js.
export function bizTheme(license) { return bizProfile(license).theme || null; }

// Convenience: the merged palette this type renders with (default + override).
export function bizPalette(license) { return { ...C, ...(bizProfile(license).theme || {}) }; }
