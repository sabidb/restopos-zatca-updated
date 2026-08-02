// ═══════════════════════════════════════════════════════════════════
// RETAIL / CLOTHING business type. Shared core (till, ZATCA, payments,
// reports) lives outside this folder; only design + registry entry +
// any retail-only screens belong here.
// ═══════════════════════════════════════════════════════════════════
import { retailTheme } from "./theme.js";

export const retail = {
  id: "retail", label: "Retail", labelAr: "تجزئة", icon: "🛍️",
  desc: "Barcode checkout, fast sales",
  posLayout: "scan", nav: "sidebar",
  features: { tables: false, dineIn: false, kot: false, kitchen: false, kds: false, recipes: false, weighing: false, barcodeFirst: true },
  orderTypes: [["takeaway", "🛍️", "Sale"], ["delivery", "🛵", "Delivery"]],
  hideAdvancedTabs: ["kitchen", "kds", "recipes"],
  navLabels: { create: "Products" },
  theme: retailTheme,
};
