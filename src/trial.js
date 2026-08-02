// ═══════════════════════════════════════════════════════════════════
// 14-DAY FREE TRIAL — "try before you register"
//
// A prospective client starts a real, working 14-day trial from the
// registration screen: no license key, no CR/VAT, no admin approval.
// They give a business name and a 10-digit mobile number, pick
// Restaurant or Supermarket mode, and get a clean POS they can load
// their own menu into and actually trade on.
//
// Unlike a throwaway demo, a trial is a real account:
//
//   * Their work is saved. Every keystroke syncs to Firestore under the
//     trial key, exactly like a paid client, so yesterday's sales are
//     still there tomorrow and the trial can be resumed on another
//     device with just the mobile number.
//   * The operator sees it. Starting a trial writes a
//     pending_activations/TRIAL-<mobile> document, which lands in the
//     admin panel's Trials tab with the mobile number, business type and
//     days remaining — and the admin's Extend / Convert buttons work on
//     it through the existing kill-switch watchdog.
//
// What a trial still is NOT is a ZATCA-onboarded tax terminal: it has no
// CSID, so invoices are never reported to FATOORA and every receipt is
// stamped "NOT A VALID TAX INVOICE". See TRIAL_LIMITS below.
//
// STORAGE ISOLATION. main.jsx installs a localStorage shim, before
// App.jsx and Firebase load, that prefixes every key with the trial's
// own namespace. Existing code is untouched — it just reads and writes
// an isolated namespace. That means a real client evaluating a second
// mode on their own browser can never have their live menu, sales or
// ZATCA hash chain overwritten by the trial, and two trials on one
// browser don't collide. On registration, promoteTrialWorkspace() lifts
// the namespace into the real one so 14 days of work carries over.
// ═══════════════════════════════════════════════════════════════════
import { BUSINESS_TYPES } from "./businessTypes/index.js";

export const TRIAL_DAYS = 14;

// A business type is valid iff it exists in the registry. New types added
// under src/businessTypes/ are accepted automatically — no list to update here.
const isValidBusinessType = (t) => !!BUSINESS_TYPES[t];

// These live in the REAL localStorage (outside the trial namespace) — they are
// the switch that decides whether the namespace is installed at all.
const FLAG_KEY = "restopos_trial_active";
const META_KEY = "restopos_trial_meta";
const ERROR_KEY = "restopos_trial_error";
const PREFIX_ROOT = "restopos_trial::";

// A whole deployment can be trial-only (e.g. try.restopos.store).
const BUILD_IS_TRIAL = String(import.meta.env.VITE_TRIAL_MODE || "") === "true";
const TRIAL_EXIT_URL = import.meta.env.VITE_TRIAL_EXIT_URL || "";

/**
 * What the visitor is told up front, and what the banner repeats.
 *
 * Note there is deliberately no sample/demo data inside a trial: the till
 * starts empty and the first thing in it is the client's own menu. Prospects
 * who want to see a stocked system look at the preview gallery on the landing
 * page instead, where it is clearly labelled as a sample business.
 */
export const TRIAL_LIMITS = [
  "Invoices are not reported to ZATCA — receipts are marked \"not a valid tax invoice\"",
  "ZATCA Phase 2 onboarding needs a real CR and VAT number, so it stays switched off",
  "Everything you enter is saved to your mobile number and carries over when you register",
  "Your work is kept separate from any other RestoPOS account on this browser",
];

let _active = false;
let _meta = null;
let _realStore = null;

/** True while this browser is running a trial workspace. */
export function isTrial() { return _active; }

/** True when the whole build is trial-only. */
export function isTrialBuild() { return BUILD_IS_TRIAL; }

/** {key, phone, businessName, ownerName, city, businessType, startedAt, endsAt} */
export function trialMeta() { return _meta; }

// ── Real-store access ──────────────────────────────────────────────
// After the shim is installed, window.localStorage is the namespace, so the
// flag and meta must be reached through the handle captured at install time.
function realStore() {
  if (_realStore) return _realStore;
  try { return window.localStorage; } catch (e) { return null; }
}
function readJSON(store, k) {
  try { const v = store && store.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

function loadMeta(store) {
  const m = readJSON(store, META_KEY);
  if (!m || !m.key || !m.endsAt) return null;
  return m;
}

/**
 * Whole days remaining, counting calendar days rather than elapsed hours.
 *
 * A trial ends at the END of its last day: the server stores customExpiryDate
 * as a date, and the watchdog reads it back as <date>T23:59:59. Measuring that
 * against "right now" leaves 14 days plus part of today, which rounds up to 15
 * on a 14-day trial. Comparing end-of-day to end-of-day gives the number a
 * person would count. Rounded, not floored, so a DST shift can't drop a day.
 */
export function trialDaysLeft(meta) {
  const m = meta || _meta;
  if (!m || !m.endsAt) return 0;
  const end = new Date(m.endsAt); end.setHours(23, 59, 59, 999);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  return Math.max(0, Math.round((end.getTime() - today.getTime()) / 86400000));
}

/** Local expiry check — works offline; the server copy still wins when online. */
export function trialExpired(meta) {
  const m = meta || _meta;
  if (!m || !m.endsAt) return false;
  return Date.now() > new Date(m.endsAt).getTime();
}

/** Firestore doc id / license key for a mobile number. */
export function trialKeyForPhone(phone) { return "TRIAL-" + normalizePhone(phone); }

/** Digits only. Saudi mobiles are 10 digits starting 05. */
export function normalizePhone(phone) { return String(phone || "").replace(/\D/g, ""); }

/** The one validation rule the operator asked for: exactly 10 digits. */
export function isValidMobile(phone) { return /^\d{10}$/.test(normalizePhone(phone)); }

/** The license object the app runs on during a trial. */
export function trialLicense(meta) {
  const m = meta || _meta || {};
  return {
    licenseKey: m.key,
    businessName: m.businessName || "My Business",
    businessNameAr: m.businessNameAr || "",
    ownerName: m.ownerName || "",
    email: m.email || "",
    phone: m.phone || "",
    crNumber: "",
    vatNumber: "",
    address: m.address || "",
    city: m.city || "Riyadh",
    businessType: m.businessType || "restaurant",
    isOwner: true,
    subscriptionPlan: "trial",
    activatedAt: m.startedAt,
    customExpiryDate: (m.endsAt || "").slice(0, 10),
    isTrial: true,
  };
}

// ── Storage namespace ──────────────────────────────────────────────
function prefixFor(key) { return PREFIX_ROOT + key + "::"; }

function namespaceKeys(real, prefix) {
  const out = [];
  for (let i = 0; i < real.length; i++) {
    const k = real.key(i);
    if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}

function makeShim(real, prefix) {
  const full = (k) => prefix + String(k);
  return {
    get length() { return namespaceKeys(real, prefix).length; },
    key(i) { const ks = namespaceKeys(real, prefix); return (i >= 0 && i < ks.length) ? ks[i] : null; },
    getItem(k) { return real.getItem(full(k)); },
    setItem(k, v) { real.setItem(full(k), String(v)); },
    removeItem(k) { real.removeItem(full(k)); },
    clear() { namespaceKeys(real, prefix).forEach((k) => real.removeItem(full(k))); },
  };
}

function eraseNamespace(real, key) {
  const prefix = prefixFor(key);
  try { namespaceKeys(real, prefix).forEach((k) => real.removeItem(prefix + k)); } catch (e) {}
}

/**
 * Install the trial workspace — call from main.jsx BEFORE App.jsx (and
 * therefore Firebase) is imported, so every consumer sees the same store.
 * Returns true when a trial is live.
 */
export function installTrialWorkspace() {
  let real;
  try { real = window.localStorage; } catch (e) { return false; }
  if (!real) return false;
  _realStore = real;

  const flagged = BUILD_IS_TRIAL || real.getItem(FLAG_KEY) === "1";
  const meta = loadMeta(real);
  if (!flagged || !meta) return false;

  try {
    Object.defineProperty(window, "localStorage", {
      value: makeShim(real, prefixFor(meta.key)), configurable: true, writable: false,
    });
  } catch (e) {
    // Browser won't let us shadow localStorage. Refuse rather than run the
    // trial on top of whatever real account may live on this browser.
    console.warn("[Trial] storage isolation unavailable:", e && e.message);
    try { real.removeItem(FLAG_KEY); real.setItem(ERROR_KEY, "1"); } catch (e2) {}
    return false;
  }
  _active = true;
  _meta = meta;
  // Make sure the workspace always has a license to run on, even on the very
  // first boot or after the visitor clears the app's own storage.
  try {
    if (!window.localStorage.getItem("restopos_license_v2")) {
      window.localStorage.setItem("restopos_license_v2", JSON.stringify(trialLicense(meta)));
    }
  } catch (e) {}
  return true;
}

/**
 * True once if the last attempt couldn't isolate storage, so the registration
 * screen can explain instead of appearing to do nothing. Reading clears it.
 */
export function consumeTrialStartError() {
  const real = realStore();
  try {
    if (!real || real.getItem(ERROR_KEY) !== "1") return false;
    real.removeItem(ERROR_KEY);
    return true;
  } catch (e) { return false; }
}

// ── Lifecycle ──────────────────────────────────────────────────────

/**
 * Enter (or re-enter) a trial. `details` comes from the signup form or from a
 * resumed trial's Firestore document. Reloads so the workspace installs first.
 */
export function beginTrial(details) {
  const real = realStore();
  const phone = normalizePhone(details.phone);
  const startedAt = details.startedAt || new Date().toISOString();
  const endsAt = details.endsAt || new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
  const meta = {
    key: details.key || trialKeyForPhone(phone),
    phone,
    businessName: details.businessName || "My Business",
    businessNameAr: details.businessNameAr || "",
    ownerName: details.ownerName || "",
    email: details.email || "",
    address: details.address || "",
    city: details.city || "Riyadh",
    businessType: isValidBusinessType(details.businessType) ? details.businessType : "restaurant",
    startedAt,
    endsAt,
  };
  try {
    real.setItem(META_KEY, JSON.stringify(meta));
    real.setItem(FLAG_KEY, "1");
  } catch (e) {
    alert("Your browser is blocking site storage, so the trial can't start.\nEnable cookies/site data for this site and try again.");
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * Step out of the trial without destroying anything — the workspace and the
 * cloud copy both survive, and the same mobile number resumes it.
 */
export function leaveTrial() {
  const real = realStore();
  try { real.removeItem(FLAG_KEY); } catch (e) {}
  if (BUILD_IS_TRIAL && TRIAL_EXIT_URL) { window.location.href = TRIAL_EXIT_URL; return; }
  window.location.reload();
}

/** Leave and delete the local workspace. The cloud copy still holds the data. */
export function endTrialAndErase() {
  const real = realStore();
  const meta = _meta || loadMeta(real);
  try {
    if (meta) eraseNamespace(real, meta.key);
    real.removeItem(FLAG_KEY);
    real.removeItem(META_KEY);
  } catch (e) {}
  window.location.reload();
}

/** Throw away trial work and start the workspace over, keeping the same trial. */
export function resetTrialData() {
  try { window.localStorage.clear(); } catch (e) {}
  window.location.reload();
}

/**
 * Registration hand-off: lift the trial namespace into the real one so the
 * menu, customers and 14 days of sales survive becoming a paying client.
 *
 * Refuses when another RestoPOS account already occupies the real namespace —
 * overwriting a live till's data is never the right call, and the trial's
 * cloud copy can be restored onto a clean device instead.
 * Returns {ok:true, moved} or {ok:false, reason}.
 */
export function promoteTrialWorkspace() {
  const real = realStore();
  const meta = _meta || loadMeta(real);
  if (!real || !meta) return { ok: false, reason: "no-trial" };
  if (real.getItem("restopos_license_v2") || real.getItem("restopos_items")) {
    return { ok: false, reason: "occupied" };
  }
  const prefix = prefixFor(meta.key);
  const keys = namespaceKeys(real, prefix);
  let moved = 0;
  for (const k of keys) {
    // The trial licence is not a real one — registration issues the real
    // licence, so let that flow write it rather than carrying a stale copy.
    if (k === "restopos_license_v2" || k === "restopos_client_creds") continue;
    try {
      const v = real.getItem(prefix + k);
      if (v !== null) { real.setItem(k, v); moved++; }
    } catch (e) { /* quota — keep whatever moved */ }
  }
  try {
    eraseNamespace(real, meta.key);
    real.removeItem(FLAG_KEY);
    real.removeItem(META_KEY);
  } catch (e) {}
  return { ok: true, moved };
}

/** Persist a mode change (Restaurant ⇄ Supermarket ⇄ Hypermarket) into the trial meta. */
export function setTrialBusinessType(businessType) {
  const real = realStore();
  const bt = isValidBusinessType(businessType) ? businessType : "restaurant";
  if (_meta) _meta = { ..._meta, businessType: bt };
  try { if (_meta) real.setItem(META_KEY, JSON.stringify(_meta)); } catch (e) {}
  return bt;
}

/** Keep local meta in step with the server (admin extends / changes the trial). */
export function syncTrialMeta(patch) {
  const real = realStore();
  if (!_meta) return null;
  _meta = { ..._meta, ...patch };
  try { real.setItem(META_KEY, JSON.stringify(_meta)); } catch (e) {}
  return _meta;
}
