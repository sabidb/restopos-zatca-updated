// ═══════════════════════════════════════════════════════════════════
// ACTIVITY LOG — appends an entry to the local audit trail (last 500).
// Extracted verbatim from App.jsx; behaviour unchanged. Depends only on LS.
// ═══════════════════════════════════════════════════════════════════
import { LS } from "./storage.js";

export function logActivity(action,details,user="System"){
  const logs=LS.get("restopos_activity_log")||[];
  logs.unshift({id:Date.now(),timestamp:new Date().toISOString(),action,details,user,before:details.before,after:details.after});
  LS.set("restopos_activity_log",logs.slice(0,500));
}
