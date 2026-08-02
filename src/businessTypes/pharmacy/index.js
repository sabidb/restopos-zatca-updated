// ═══════════════════════════════════════════════════════════════════
// PHARMACY business type.
//
// Everything a pharmacy does — cart, barcode till, ZATCA invoicing,
// payments, reports, sync — is the SHARED core and lives outside this
// folder. Only what is unique to a pharmacy belongs here: its design
// (theme.js), its registry entry (below), and its own screens (screens/).
// ═══════════════════════════════════════════════════════════════════
import { pharmacyTheme } from "./theme.js";

export const pharmacy = {
  id: "pharmacy", label: "Pharmacy", labelAr: "صيدلية", icon: "💊",
  desc: "Barcode till, batch & expiry",
  // Barcode-first till + sidebar drawer (same interface family as supermarket).
  posLayout: "scan", nav: "sidebar",
  // Business logic identical to a shop — no kitchen/dine-in features.
  features: { tables: false, dineIn: false, kot: false, kitchen: false, kds: false, recipes: false, weighing: false, barcodeFirst: true },
  orderTypes: [["takeaway", "🛒", "Sale"], ["delivery", "🛵", "Delivery"]],
  hideAdvancedTabs: ["kitchen", "kds", "recipes"],
  navLabels: { create: "Products" },
  // Front design for this type (see ../../lib/theme.js applyBizTheme).
  theme: pharmacyTheme,
};
