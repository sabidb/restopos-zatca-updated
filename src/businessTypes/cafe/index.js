// ═══════════════════════════════════════════════════════════════════
// CAFÉ / COFFEE SHOP business type. Grid menu with a warm skin; shared
// core lives outside this folder.
// ═══════════════════════════════════════════════════════════════════
import { cafeTheme } from "./theme.js";

export const cafe = {
  id: "cafe", label: "Café", labelAr: "مقهى", icon: "☕",
  desc: "Menu, dine-in & takeaway",
  posLayout: "grid", nav: "topbar",
  features: { tables: false, dineIn: false, kot: false, kitchen: false, kds: false, recipes: false, weighing: false, barcodeFirst: false },
  orderTypes: [["takeaway", "☕", "Takeaway"], ["dine-in", "🪑", "Dine-in"], ["delivery", "🛵", "Delivery"]],
  hideAdvancedTabs: ["kitchen", "kds", "recipes"],
  navLabels: { create: "Menu" },
  theme: cafeTheme,
};
