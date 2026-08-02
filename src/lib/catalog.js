// ═══════════════════════════════════════════════════
// CATALOG PREFERENCES — category colours, favourites, custom item order and
// POS tile height. localStorage-backed, mirrored to the cloud via debouncedSync.
// Shared by every business type. Extracted verbatim from App.jsx.
// ═══════════════════════════════════════════════════
import { LS } from "./storage.js";
import { debouncedSync } from "./sync.js";

export const OTHER_CAT="Other";
export const CAT_PALETTE=["#1A6B4A","#2176AE","#D94040","#F0A500","#6366f1","#7c3aed","#be185d","#0891b2","#65a30d","#ea580c","#0f766e","#9333ea","#475569","#b45309"];
export function getCategoryColors(){return LS.get("restopos_category_colors")||{};}
export function saveCategoryColors(map){LS.set("restopos_category_colors",map);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_category_colors",map);}
export function colorForCat(cat,cats){const map=getCategoryColors();if(map&&map[cat])return map[cat];const i=Array.isArray(cats)?cats.indexOf(cat):-1;return CAT_PALETTE[(i<0?Math.abs((cat||"").split("").reduce((a,c)=>a+c.charCodeAt(0),0)):i)%CAT_PALETTE.length];}
// Effective category for an item — falls back to "Other" when blank or unknown
export function effectiveCat(item,cats){const c=item&&item.category;return (c&&Array.isArray(cats)&&cats.includes(c))?c:OTHER_CAT;}
// Category list that appends "Other" whenever orphan/uncategorised items exist
export function catsWithOther(cats,items){const base=Array.isArray(cats)?[...cats]:[];const hasOther=Array.isArray(items)&&items.some(i=>!i.category||!base.includes(i.category));if(hasOther&&!base.includes(OTHER_CAT))base.push(OTHER_CAT);return base;}
export function getFavourites(){const f=LS.get("restopos_favourites");return Array.isArray(f)?f:[];}
export function saveFavourites(ids){LS.set("restopos_favourites",ids);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_favourites",ids);}
// Custom item order per POS (id → sort index). Used for drag-to-reorder.
export function getItemOrder(){const o=LS.get("restopos_item_order");return o&&typeof o==="object"?o:{};}
export function saveItemOrder(map){LS.set("restopos_item_order",map);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_item_order",map);}
// POS item-box height (px). Lower = flatter/rectangular, higher = taller/square.
export function getPosBoxHeight(){const h=parseInt(LS.get("restopos_pos_box_height"));return (h>=44&&h<=160)?h:96;}
export function savePosBoxHeight(h){LS.set("restopos_pos_box_height",h);const lic=LS.get("restopos_license_v2")?.licenseKey;if(lic)debouncedSync(lic,"restopos_pos_box_height",h);}
