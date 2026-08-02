// ═══════════════════════════════════════════════════
// DASHBOARD CONFIG — the catalogue of dashboard stat boxes, the default
// layout, and the reader that returns the saved layout (validated against the
// catalogue). Shared by every business type. Extracted verbatim from App.jsx.
// ═══════════════════════════════════════════════════
import { LS } from "./storage.js";

export const DASHBOARD_BOXES=[
  {id:"todayOrders",icon:"🧾",label:"Today's Orders",color:"info"},
  {id:"vatCollected",icon:"⬛",label:"VAT Collected",color:"zatca"},
  {id:"todayRevenue",icon:"💰",label:"Today's Revenue",color:"primary"},
  {id:"menuItems",icon:"📦",label:"Menu Items",color:"success"},
  {id:"avgOrder",icon:"📈",label:"Avg Order Value",color:"info"},
  {id:"zatcaTotal",icon:"📋",label:"Total ZATCA Invoices",color:"zatca"},
  {id:"zatcaReported",icon:"✅",label:"Reported to ZATCA",color:"success"},
  {id:"zatcaPending",icon:"⏳",label:"ZATCA Pending",color:"warning"},
  {id:"zatcaUrgent",icon:"🚨",label:"ZATCA Urgent",color:"danger"},
];
// Arabic labels for dashboard boxes
export const DASHBOARD_BOX_LABELS_AR={
  "todayOrders":"طلبات اليوم","vatCollected":"ضريبة القيمة المضافة",
  "todayRevenue":"إيرادات اليوم","menuItems":"أصناف القائمة",
  "avgOrder":"متوسط قيمة الطلب","zatcaTotal":"إجمالي فواتير زاتكا",
  "zatcaReported":"تم إرسالها لزاتكا","zatcaPending":"زاتكا معلقة","zatcaUrgent":"زاتكا عاجلة",
};
// Default: the same boxes that were shown before (keeps current look)
export const DEFAULT_DASHBOARD_CONFIG=["todayOrders","vatCollected","menuItems","zatcaTotal","zatcaReported","zatcaPending","zatcaUrgent"];
export function getDashboardConfig(){
  const saved=LS.get("restopos_dashboard_config");
  if(Array.isArray(saved)&&saved.length)return saved.filter(id=>DASHBOARD_BOXES.some(b=>b.id===id));
  return DEFAULT_DASHBOARD_CONFIG.slice();
}
