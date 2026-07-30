// ═══════════════════════════════════════════════════════════════════
// PERMISSIONS — declarative "who can do what", built once and reused.
//
// Two independent questions:
//   1. can(action, role)        — is this role allowed to do the action at all?
//   2. requiresApproval(action) — must a higher-ranked person approve it,
//                                  for the ACTIVE business type?
//
// (1) replaces scattered role checks; (2) powers the manager-approval
// override flow (void / refund / price override). Approval is OFF unless a
// business type opts in via features.approvals, so existing restaurant and
// supermarket behave exactly as before.
//
// Pure module — no React, no storage. The active license is read through
// bizProfile() only to look up the per-type approval flags.
// ═══════════════════════════════════════════════════════════════════
import { roleAtLeast } from "../config/roles.js";
import { bizProfile } from "../config/businessTypes.js";

// Minimum role required to perform each gated action. Anything not listed
// here is allowed for everyone (no gate) — same as today.
export const ACTION_MIN_ROLE = {
  "sale.void":          "Supervisor",  // cancel/void a completed sale
  "sale.refund":        "Supervisor",  // refund / return
  "sale.priceOverride": "Supervisor",  // change an item's price at the till
  "settings.edit":      "Admin",       // change settings (today: Admin-only nav)
};

// Can this role perform the action outright (ignoring approval)?
// Unlisted actions are always allowed.
export function can(action, roleId){
  const min = ACTION_MIN_ROLE[action];
  if(!min) return true;
  return roleAtLeast(roleId, min);
}

// Does the ACTIVE business type require a higher-ranked approval for this
// action? Reads features.approvals from the profile; absent/empty = off,
// so existing types never prompt. `license` optional (defaults to saved).
export function requiresApproval(action, license){
  const approvals = bizProfile(license)?.features?.approvals;
  if(!approvals) return false;                 // type hasn't opted in → off
  if(approvals === true) return !!ACTION_MIN_ROLE[action]; // opt-in to all gated actions
  return !!approvals[action];                  // or a per-action map { "sale.void":true, ... }
}

// The minimum role id that can approve an action (for the approval modal).
export function approverRoleFor(action){ return ACTION_MIN_ROLE[action] || null; }
