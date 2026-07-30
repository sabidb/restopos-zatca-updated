// ═══════════════════════════════════════════════════════════════════
// APPROVAL GATE — reusable "manager approval" PIN modal.
//
// Rendered only when a gated action (void / refund / price override) needs
// a higher-ranked sign-off. It accepts the PIN of any role that ranks at or
// above the action's minimum (see ACTION_MIN_ROLE), records who approved in
// the audit log, and calls onApproved(role). Dormant until a screen renders
// it — no behaviour change for types that don't require approval.
//
// Props:
//   action      permission key, e.g. "sale.void"
//   onApproved  (approverRole) => void   — PIN accepted
//   onCancel    () => void                — dismissed
//   license     optional; defaults to saved license
//   title       optional override for the heading
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { Btn, Modal } from "./ui.jsx";
import { LS } from "../lib/storage.js";
import { logActivity } from "../lib/activity.js";
import { ROLES, roleAtLeast, DEFAULT_PINS } from "../config/roles.js";
import { approverRoleFor } from "../lib/permissions.js";

const ACTION_LABELS = {
  "sale.void":"void this sale",
  "sale.refund":"process this refund",
  "sale.priceOverride":"override this price",
  "settings.edit":"change settings",
};

export function ApprovalGate({ action, onApproved, onCancel, title }){
  const [pin,setPin]=useState("");
  const [error,setError]=useState("");
  const minRole = approverRoleFor(action) || "Manager";
  const minLabel = ROLES[minRole]?.label || minRole;
  const pins = { ...DEFAULT_PINS, ...(LS.get("restopos_pins") || {}) };

  function submit(){
    const entered=(pin||"").trim();
    if(!entered){ setError("Enter a PIN"); return; }
    // Which role owns this PIN? Accept it only if that role outranks-or-equals
    // the action's minimum. Highest-ranked matching role wins.
    const matching = Object.keys(pins)
      .filter(r => pins[r] && String(pins[r])===entered && ROLES[r])
      .sort((a,b)=>(ROLES[b].rank)-(ROLES[a].rank))[0];
    if(!matching){ setError("PIN not recognised"); setPin(""); return; }
    if(!roleAtLeast(matching, minRole)){
      setError(`${matching} can't approve this — needs ${minLabel} or higher`); setPin(""); return;
    }
    try{ logActivity("APPROVAL_GRANTED",{after:{action,approvedBy:matching}},matching); }catch(e){}
    onApproved && onApproved(matching);
  }

  return (
    <Modal title={title || `${minLabel} approval required`} onClose={onCancel} width={380}>
      <div style={{fontSize:13,color:C.textMid,marginBottom:14}}>
        Enter a {minLabel}-or-above PIN to {ACTION_LABELS[action]||"approve this action"}.
      </div>
      <input
        type="password" inputMode="numeric" autoFocus value={pin}
        onChange={e=>{setPin(e.target.value);setError("");}}
        onKeyDown={e=>{ if(e.key==="Enter") submit(); }}
        placeholder="Approver PIN"
        style={{width:"100%",padding:"12px 14px",border:`1.5px solid ${error?C.danger:C.border}`,borderRadius:10,fontSize:18,fontFamily:"inherit",letterSpacing:"0.3em",textAlign:"center"}}
      />
      {error && <div style={{fontSize:12,color:C.danger,marginTop:8,textAlign:"center"}}>{error}</div>}
      <div style={{display:"flex",gap:10,marginTop:16}}>
        <Btn variant="ghost" onClick={onCancel} style={{flex:1}}>Cancel</Btn>
        <Btn onClick={submit} style={{flex:1}}>Approve</Btn>
      </div>
    </Modal>
  );
}
