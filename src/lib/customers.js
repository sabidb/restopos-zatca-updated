// ═══════════════════════════════════════════════════
// CUSTOMER TIERS & AGING — loyalty tier table and the helpers that place a
// customer in a tier (by spend) and an activity bucket (by last order).
// Pure data + pure functions. Extracted verbatim from App.jsx.
// ═══════════════════════════════════════════════════

export const CUSTOMER_TIERS=[
  {id:"bronze",label:"Bronze",color:"#CD7F32",bg:"#FDF3E7",minSpend:0,discount:0,pointRate:1},
  {id:"silver",label:"Silver",color:"#A0A0A0",bg:"#F5F5F5",minSpend:500,discount:2,pointRate:1.5},
  {id:"gold",label:"Gold",color:"#F0A500",bg:"#FEF6E4",minSpend:2000,discount:5,pointRate:2},
  {id:"platinum",label:"Platinum",color:"#6366f1",bg:"#EEF2FF",minSpend:5000,discount:10,pointRate:3},
];
export function getTier(totalSpent){return CUSTOMER_TIERS.slice().reverse().find(t=>totalSpent>=t.minSpend)||CUSTOMER_TIERS[0];}
export function getAgingBucket(lastOrderDate){
  if(!lastOrderDate)return"Never";
  const days=Math.floor((Date.now()-new Date(lastOrderDate).getTime())/(1000*60*60*24));
  if(days<=30)return"Active";if(days<=60)return"30-60d";if(days<=90)return"60-90d";return"90d+";
}
