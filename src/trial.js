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

export const TRIAL_DAYS = 14;

// These live in the REAL localStorage (outside the trial namespace) — they are
// the switch that decides whether the namespace is installed at all.
const FLAG_KEY = "restopos_trial_active";
const META_KEY = "restopos_trial_meta";
const ERROR_KEY = "restopos_trial_error";
const PREFIX_ROOT = "restopos_trial::";

// A whole deployment can be trial-only (e.g. try.restopos.store).
const BUILD_IS_TRIAL = String(import.meta.env.VITE_TRIAL_MODE || "") === "true";
const TRIAL_EXIT_URL = import.meta.env.VITE_TRIAL_EXIT_URL || "";

/** What the visitor is told up front, and what the banner repeats. */
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

/** Days remaining, rounded up; 0 once expired. Never negative. */
export function trialDaysLeft(meta) {
  const m = meta || _meta;
  if (!m || !m.endsAt) return 0;
  return Math.max(0, Math.ceil((new Date(m.endsAt).getTime() - Date.now()) / 86400000));
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
    businessType: details.businessType === "supermarket" ? "supermarket" : "restaurant",
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

/** Persist a mode change (Restaurant ⇄ Supermarket) into the trial meta. */
export function setTrialBusinessType(businessType) {
  const real = realStore();
  const bt = businessType === "supermarket" ? "supermarket" : "restaurant";
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

// ═══════════════════════════════════════════════════════════════════
// OPTIONAL SAMPLE MENUS
// A trial starts clean — the point is for the client to enter their own
// products. These are one click away for anyone who just wants a stocked
// screen to look at, and are clearly labelled as samples.
// ═══════════════════════════════════════════════════════════════════

export const SAMPLE_MENUS = {
  restaurant: {
    categories: ["Mandi & Rice", "Grills", "Appetizers", "Sides", "Drinks", "Desserts"],
    items: [
      ["Chicken Mandi (Half)", "مندي دجاج نص", "Mandi & Rice", 27, 12, 60],
      ["Chicken Mandi (Full)", "مندي دجاج كامل", "Mandi & Rice", 49, 22, 40],
      ["Lamb Mandi (Half)", "مندي لحم نص", "Mandi & Rice", 58, 30, 25],
      ["Chicken Kabsa", "كبسة دجاج", "Mandi & Rice", 32, 14, 45],
      ["Biryani Rice", "رز برياني", "Mandi & Rice", 18, 6, 50],
      ["Mixed Grill Platter", "مشاوي مشكلة", "Grills", 72, 34, 20],
      ["Shish Tawook", "شيش طاووق", "Grills", 38, 17, 30],
      ["Lamb Kofta", "كفتة لحم", "Grills", 42, 19, 28],
      ["Hummus", "حمص", "Appetizers", 14, 4, 60],
      ["Mutabbal", "متبل", "Appetizers", 15, 5, 50],
      ["Fattoush Salad", "سلطة فتوش", "Appetizers", 19, 6, 40],
      ["French Fries", "بطاطس مقلية", "Sides", 11, 3, 120],
      ["Arabic Bread", "خبز عربي", "Sides", 4, 1, 200],
      ["Soft Drink Can", "مشروب غازي", "Drinks", 6, 2, 200],
      ["Fresh Lemon Mint", "ليمون بالنعناع", "Drinks", 16, 4, 60],
      ["Saudi Coffee Pot", "دلة قهوة عربية", "Drinks", 22, 6, 35],
      ["Umm Ali", "أم علي", "Desserts", 20, 7, 25],
      ["Kunafa", "كنافة", "Desserts", 24, 9, 20],
    ],
  },
  supermarket: {
    categories: ["Bakery", "Dairy & Eggs", "Produce", "Pantry", "Beverages", "Household"],
    // Trailing flag marks a weighed item — supermarket mode prices those per kg.
    items: [
      ["Arabic Bread 6pc", "خبز عربي", "Bakery", 4, 1.5, 200, "6281000110016"],
      ["Croissant", "كرواسون", "Bakery", 3.5, 1.2, 80, "6281000110023"],
      ["Fresh Milk 1L", "حليب طازج", "Dairy & Eggs", 7, 4.5, 120, "6281000110030"],
      ["Laban 1L", "لبن", "Dairy & Eggs", 6.5, 4, 100, "6281000110047"],
      ["Eggs 30pc Tray", "بيض ٣٠ حبة", "Dairy & Eggs", 19, 13, 60, "6281000110054"],
      ["Halloumi Cheese 250g", "جبن حلومي", "Dairy & Eggs", 18, 11, 45, "6281000110061"],
      ["Tomatoes", "طماطم", "Produce", 6.5, 3.5, 0, "", true],
      ["Cucumber", "خيار", "Produce", 5.5, 3, 0, "", true],
      ["Bananas", "موز", "Produce", 8, 5, 0, "", true],
      ["Potatoes", "بطاطس", "Produce", 4.5, 2.5, 0, "", true],
      ["Basmati Rice 5kg", "رز بسمتي", "Pantry", 62, 45, 40, "6281000110078"],
      ["Sunflower Oil 1.8L", "زيت دوار الشمس", "Pantry", 24, 17, 50, "6281000110085"],
      ["White Sugar 2kg", "سكر أبيض", "Pantry", 13, 9, 70, "6281000110092"],
      ["Dates 1kg", "تمر", "Pantry", 32, 20, 35, "6281000110108"],
      ["Water 600ml x12", "مياه ١٢ حبة", "Beverages", 9, 5.5, 90, "6281000110115"],
      ["Soft Drink Can", "مشروب غازي", "Beverages", 3, 1.8, 240, "6281000110122"],
      ["Orange Juice 1L", "عصير برتقال", "Beverages", 11, 7, 60, "6281000110139"],
      ["Dish Soap 750ml", "صابون أطباق", "Household", 12, 7.5, 55, "6281000110146"],
      ["Tissue Box", "مناديل", "Household", 7, 4, 100, "6281000110153"],
    ],
  },
};

/**
 * Write a sample catalogue into the current workspace. Appends to whatever the
 * client has already entered rather than replacing it.
 * Returns the number of items added.
 */
export function loadSampleMenu(businessType) {
  const mode = businessType === "supermarket" ? "supermarket" : "restaurant";
  const sample = SAMPLE_MENUS[mode];
  const get = (k, fb) => { try { const v = window.localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
  const set = (k, v) => { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  const existing = get("restopos_items", []) || [];
  const haveNames = new Set(existing.map((i) => String(i.name || "").toLowerCase()));
  const base = Date.now();
  const added = sample.items
    .filter(([name]) => !haveNames.has(String(name).toLowerCase()))
    .map(([name, nameAr, category, price, cost, stock, barcode, weighed], i) => ({
      id: base + i,
      name, nameAr, category,
      price, cost, stock: stock || 0,
      active: true,
      barcode: barcode || "",
      weighed: !!weighed,
      isSample: true,
    }));

  const cats = get("restopos_categories", []) || [];
  const mergedCats = [...cats];
  sample.categories.forEach((c) => { if (!mergedCats.includes(c)) mergedCats.push(c); });

  set("restopos_categories", mergedCats);
  set("restopos_items", [...existing, ...added]);
  return added.length;
}
