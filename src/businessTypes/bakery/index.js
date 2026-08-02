// ═══════════════════════════════════════════════════════════════════
// BAKERY business type. Grid (menu-style) till with a warm skin; shared
// core lives outside this folder.
// ═══════════════════════════════════════════════════════════════════
import { bakeryTheme } from "./theme.js";

export const bakery = {
  id: "bakery", label: "Bakery", labelAr: "مخبز", icon: "🧁",
  desc: "Menu counter, quick sales",
  // Menu-grid layout + flat top bar (same interface family as restaurant).
  posLayout: "grid", nav: "topbar",
  features: { tables: false, dineIn: false, kot: false, kitchen: false, kds: false, recipes: false, weighing: false, barcodeFirst: false },
  orderTypes: [["takeaway", "🧁", "Sale"], ["delivery", "🛵", "Delivery"]],
  hideAdvancedTabs: ["kitchen", "kds", "recipes"],
  navLabels: { create: "Products" },
  theme: bakeryTheme,
};
