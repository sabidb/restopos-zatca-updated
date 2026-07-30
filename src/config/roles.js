// ═══════════════════════════════════════════════════════════════════
// ROLES REGISTRY — single source of truth for staff roles.
//
// Extends the existing Admin / Manager / Cashier system with a new
// Supervisor role, without changing anything for existing types: which
// roles are *available* is decided per business type (see ROLES_FOR_TYPE
// and businessTypes.js). Restaurant and Supermarket keep exactly the
// three roles they have today; a type can opt Supervisor in.
//
// `rank` gives an approval hierarchy — a higher rank can approve an action
// gated to a lower one. This is what powers manager-approval overrides
// (void / refund / price override) in src/lib/permissions.js.
// ═══════════════════════════════════════════════════════════════════

// All roles the app knows about. Order is low → high authority.
export const ROLES = {
  Cashier:    { id:"Cashier",    label:"Cashier",    labelAr:"كاشير",  icon:"🖥️", rank:1, desc:"POS billing only" },
  Supervisor: { id:"Supervisor", label:"Supervisor", labelAr:"مشرف",   icon:"🛡️", rank:2, desc:"Approves till overrides" },
  Manager:    { id:"Manager",    label:"Manager",    labelAr:"مدير",    icon:"📊", rank:3, desc:"Reports & management" },
  Admin:      { id:"Admin",      label:"Admin",      labelAr:"مدير عام", icon:"👑", rank:4, desc:"Full access" },
};

// The roles that existed before Supervisor — the default set for any type
// that doesn't say otherwise, so nothing changes for restaurant/supermarket.
export const LEGACY_ROLES = ["Admin","Manager","Cashier"];

// The rank of a role id (0 for anything unknown — never throws).
export function roleRank(roleId){ return ROLES[roleId]?.rank || 0; }

// Does `roleId` outrank-or-equal `minRoleId`? Used for approval checks.
export function roleAtLeast(roleId, minRoleId){ return roleRank(roleId) >= roleRank(minRoleId); }

// The active roles for a business-type profile. A profile may list
// `roles:[...]`; otherwise it gets the legacy three. Always returned in
// rank order (low → high) so login screens list them consistently.
export function rolesForProfile(profile){
  const ids = (profile && Array.isArray(profile.roles) && profile.roles.length) ? profile.roles : LEGACY_ROLES;
  return ids
    .filter(id => ROLES[id])
    .sort((a,b) => roleRank(a) - roleRank(b))
    .map(id => ROLES[id]);
}
