// ═══════════════════════════════════════════════════════════════════
// BUSINESS TYPES — single source of truth registry + helpers.
// Extracted verbatim from App.jsx; registry and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { LS } from "../lib/storage.js";

// ── BUSINESS TYPES ───────────────────────────────────────────────────────
// Single source of truth for every business type. The whole app reads its
// behaviour from the active profile instead of scattered `if (isSupermarket())`
// checks — so adding a new type (pharmacy, salon, café, …) is one entry here
// plus any screens unique to it, with nothing else to hunt down.
//
// Restaurant and Supermarket are defined to match today's behaviour exactly.
// Fields:
//   posLayout        "grid" (menu grid + cart) | "scan" (barcode-first till)
//   nav              "topbar" (flat bar) | "sidebar" (☰ drawer + quick tabs)
//   features         capability flags the UI switches on
//   orderTypes       [id, icon, label] shown on the cart order-type toggle
//   hideAdvancedTabs Advanced-screen tabs this type doesn't use
//   navLabels        per-type wording overrides for nav items
export const BUSINESS_TYPES={
  restaurant:{
    id:"restaurant", label:"Restaurant", labelAr:"مطعم", icon:"🍽️",
    posLayout:"grid", nav:"topbar",
    features:{ tables:true, dineIn:true, kot:true, kitchen:true, kds:true, recipes:true, weighing:false, barcodeFirst:false },
    orderTypes:[["takeaway","🥡","Takeaway"],["dine-in","🍽","Dine-in"],["delivery","🛵","Delivery"]],
    hideAdvancedTabs:[],
    navLabels:{},
  },
  supermarket:{
    id:"supermarket", label:"Supermarket", labelAr:"سوبرماركت", icon:"🛒",
    posLayout:"scan", nav:"sidebar",
    features:{ tables:false, dineIn:false, kot:false, kitchen:false, kds:false, recipes:false, weighing:true, barcodeFirst:true },
    orderTypes:[["takeaway","🛒","Sale"],["delivery","🛵","Delivery"]],
    hideAdvancedTabs:["kitchen","kds","recipes"],
    navLabels:{ create:"Products" },
  },
};
export const DEFAULT_BUSINESS_TYPE="restaurant";
export function getBusinessType(license){
  const lic = license || (typeof LS!=="undefined" ? LS.get("restopos_license_v2") : null);
  const t = lic && lic.businessType;
  return BUSINESS_TYPES[t] ? t : DEFAULT_BUSINESS_TYPE; // unknown/missing → default, never crashes
}
// The active type's full profile — the object the UI should read from.
export function bizProfile(license){ return BUSINESS_TYPES[getBusinessType(license)]||BUSINESS_TYPES[DEFAULT_BUSINESS_TYPE]; }
// One capability flag, e.g. bizFeature("tables") / bizFeature("kot").
export function bizFeature(name,license){ return !!bizProfile(license).features[name]; }
// Kept for compatibility across the app; now derived from the registry.
export function isSupermarket(license){ return getBusinessType(license)==="supermarket"; }
