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
//
// Optional Phase-2 fields (absent ⇒ off, so restaurant/supermarket are
// unaffected; a new type opts in):
//   roles              e.g. ["Admin","Manager","Supervisor","Cashier"] — which
//                      staff roles this type uses (default: Admin/Manager/Cashier).
//                      See src/config/roles.js.
//   features.approvals true | { "sale.void":true, ... } — require a higher-ranked
//                      PIN to approve gated till actions. See src/lib/permissions.js.
//   features.loyalty   true — enable points/tiers/redemptions.
//   loyalty            optional overrides for the default earn/redeem rules.
//                      See src/config/loyalty.js.
export const BUSINESS_TYPES={
  restaurant:{
    id:"restaurant", label:"Restaurant", labelAr:"مطعم", icon:"🍽️",
    posLayout:"grid", nav:"topbar",
    features:{ tables:true, dineIn:true, kot:true, kitchen:true, kds:true, recipes:true, weighing:false, barcodeFirst:false, manualBilling:true },
    orderTypes:[["takeaway","🥡","Takeaway"],["dine-in","🍽","Dine-in"],["delivery","🛵","Delivery"]],
    hideAdvancedTabs:[],
    navLabels:{},
  },
  supermarket:{
    id:"supermarket", label:"Supermarket", labelAr:"سوبرماركت", icon:"🛒",
    posLayout:"scan", nav:"sidebar",
    features:{ tables:false, dineIn:false, kot:false, kitchen:false, kds:false, recipes:false, weighing:true, barcodeFirst:true, manualBilling:true },
    orderTypes:[["takeaway","🛒","Sale"],["delivery","🛵","Delivery"]],
    hideAdvancedTabs:["kitchen","kds","recipes"],
    navLabels:{ create:"Products" },
  },
  // Large hypermarket (Lulu-style): supermarket till, plus the Phase-2 shared
  // systems switched ON — a Supervisor role with manager-approval overrides for
  // void/refund/price-override, and a customer loyalty/rewards programme.
  hypermarket:{
    id:"hypermarket", label:"Hypermarket", labelAr:"هايبر ماركت", icon:"🏬",
    posLayout:"scan", nav:"sidebar",
    features:{ tables:false, dineIn:false, kot:false, kitchen:false, kds:false, recipes:false, weighing:true, barcodeFirst:true, approvals:true, loyalty:true, manualBilling:true },
    orderTypes:[["takeaway","🛒","Sale"],["delivery","🛵","Delivery"]],
    hideAdvancedTabs:["kitchen","kds","recipes"],
    navLabels:{ create:"Products" },
    roles:["Admin","Manager","Supervisor","Cashier"],
  },
  // Custom App Integration — an "online-ordering" tenant whose orders, prices,
  // discounts and payments are all created and CAPTURED in an external app.
  // RestoPOS is the invoicing/ZATCA engine only, so over-the-counter manual
  // billing is switched OFF (features.manualBilling:false disables the POS "Pay"
  // action); invoices are created from the integration API against the captured
  // transaction instead. Everything else — ZATCA signing/reporting, archive,
  // reports — is the shared core and behaves exactly as for any other type.
  integration:{
    id:"integration", label:"Custom App Integration", labelAr:"تكامل تطبيق خارجي", icon:"🔌",
    posLayout:"grid", nav:"sidebar",
    features:{ tables:false, dineIn:false, kot:false, kitchen:false, kds:false, recipes:false, weighing:false, barcodeFirst:false, manualBilling:false, onlineOrdering:true },
    orderTypes:[["delivery","🛵","Delivery"],["takeaway","🥡","Pickup"]],
    hideAdvancedTabs:["kitchen","kds","recipes"],
    navLabels:{},
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
