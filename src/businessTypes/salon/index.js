// ═══════════════════════════════════════════════════════════════════
// SALON / BARBERSHOP business type. Service-grid layout with a purple
// skin; shared core lives outside this folder.
// ═══════════════════════════════════════════════════════════════════
import { salonTheme } from "./theme.js";

export const salon = {
  id: "salon", label: "Salon", labelAr: "صالون", icon: "💈",
  desc: "Services, walk-ins",
  posLayout: "grid", nav: "topbar",
  features: { tables: false, dineIn: false, kot: false, kitchen: false, kds: false, recipes: false, weighing: false, barcodeFirst: false },
  orderTypes: [["takeaway", "💈", "Service"], ["delivery", "🛵", "Home visit"]],
  hideAdvancedTabs: ["kitchen", "kds", "recipes"],
  navLabels: { create: "Services" },
  theme: salonTheme,
};
