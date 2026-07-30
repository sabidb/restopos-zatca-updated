// ═══════════════════════════════════════════════════════════════════
// LOYALTY PANEL — checkout widget: shows a customer's points balance, the
// points this sale will earn, and lets the cashier redeem points as a
// discount (capped by balance and by the bill), at the app's 100 pts = SAR 10
// rate.
//
// Rendered only when loyalty is enabled for the active type AND a customer is
// attached — inert everywhere else. Pure presentation over the loyalty core;
// it never writes anything, it reports the chosen redemption up via
// onRedeemChange so the checkout owns the money math. Tiers are a CRM concept
// (spend-based) and deliberately not shown here.
//
// Props:
//   customer        the attached customer record ({loyaltyPoints})
//   billTotal       current bill total (SAR) redemption is capped against
//   rules           loyalty rules (from loyaltyRulesForProfile) — null = off
//   redeemedPoints  currently chosen points to redeem (controlled)
//   onRedeemChange  (points, sarValue) => void
// ═══════════════════════════════════════════════════════════════════
import { C } from "../lib/theme.js";
import { Btn } from "./ui.jsx";
import { fmtSAR } from "../lib/format.js";
import { earnPoints, redeemValue, maxRedeemablePoints } from "../lib/loyalty.js";

export function LoyaltyPanel({ customer, billTotal, rules, redeemedPoints=0, onRedeemChange }){
  if(!rules || !customer) return null;
  const balance = Number(customer.loyaltyPoints)||0;
  const willEarn = earnPoints(billTotal, rules);
  const maxRedeem = maxRedeemablePoints(balance, billTotal, rules);
  const chosen = Math.max(0, Math.min(Number(redeemedPoints)||0, maxRedeem));
  const chosenValue = redeemValue(chosen, rules);

  return (
    <div style={{border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px",background:C.bg,marginTop:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <span style={{fontSize:13,fontWeight:800,color:C.text}}>⭐ Loyalty</span>
        <strong style={{fontSize:12,color:C.text}}>{balance.toLocaleString()} pts</strong>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:C.textMid}}>
        <span>Earns this sale</span><strong style={{color:C.success}}>+{willEarn.toLocaleString()} pts</strong>
      </div>
      {maxRedeem>0 && (
        <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${C.border}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
            <span style={{fontSize:12,color:C.textMid}}>Redeem</span>
            <div style={{display:"flex",gap:6,alignItems:"center"}}>
              <input
                type="number" min={0} max={maxRedeem} value={chosen||""}
                onChange={e=>{ const p=Math.max(0,Math.min(maxRedeem,parseInt(e.target.value)||0)); onRedeemChange && onRedeemChange(p, redeemValue(p,rules)); }}
                placeholder="0"
                style={{width:80,padding:"6px 8px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:13,fontFamily:"inherit",textAlign:"right"}}
              />
              <span style={{fontSize:12,color:C.textMid}}>pts</span>
              <Btn size="sm" variant="ghost" onClick={()=>onRedeemChange && onRedeemChange(maxRedeem, redeemValue(maxRedeem,rules))}>Max</Btn>
            </div>
          </div>
          {chosen>0 && <div style={{fontSize:12,color:C.primary,fontWeight:700,marginTop:6,textAlign:"right"}}>−{fmtSAR(chosenValue)} discount</div>}
        </div>
      )}
    </div>
  );
}
