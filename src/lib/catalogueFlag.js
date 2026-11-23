// ═══════════════════════════════════════════════════════════════════
// CATALOGUE SUBCOLLECTION FLAG (R1) — decides whether a tenant uses the
// Firestore catalogue subcollection instead of the client_data blob.
//
// PER-LICENSE: the flag is a cloud-synced account setting (in SYNC_KEYS), so
// flipping it on one device propagates to every device of that licence on their
// next restore — a tenant-wide switch, not a per-device one. An admin/server can
// also force it from the licence document (license.catalogueSubcollection),
// which always wins. A per-device localStorage value is still honoured so one
// till can be piloted or rolled back on its own if needed.
//
// resolveCatalogueFlag is pure (testable); catalogueSubEnabled reads storage.
// ═══════════════════════════════════════════════════════════════════
import { LS } from "./storage.js";
import { debouncedSync } from "./sync.js";

export const CATALOGUE_FLAG_KEY = "restopos_catalogue_subcollection";

/** Pure resolution: licence-level flag wins, else the (synced/local) account flag. */
export function resolveCatalogueFlag(license, flagValue) {
  if (license && license.catalogueSubcollection === true) return true;
  return flagValue === true;
}

/** Effective on/off for this device right now. */
export function catalogueSubEnabled() {
  try { return resolveCatalogueFlag(LS.get("restopos_license_v2"), LS.get(CATALOGUE_FLAG_KEY)); }
  catch { return false; }
}

/**
 * Set the account-wide flag and sync it to this tenant's other devices.
 * (The licence-level override, if present, still wins on read.)
 */
export function setCatalogueSubEnabled(on) {
  try {
    LS.set(CATALOGUE_FLAG_KEY, !!on);
    const lk = LS.get("restopos_license_v2")?.licenseKey;
    if (lk) debouncedSync(lk, CATALOGUE_FLAG_KEY, !!on);
  } catch (e) { /* best-effort */ }
}
