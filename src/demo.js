// ═══════════════════════════════════════════════════════════════════
// DEMO MODE — "try before you register"
//
// A prospective client can explore the complete POS (menu, billing,
// receipts, reports, VAT dashboard…) filled with sample data, without
// a license key, without an account, and without touching anything real.
//
// Two guarantees make that safe:
//
//   1. STORAGE IS SANDBOXED. Before React mounts, window.localStorage is
//      replaced with a shim that prefixes every key with DEMO_PREFIX. All
//      existing code (LS.get/set and the many direct localStorage calls)
//      therefore reads and writes an isolated namespace — a real client's
//      menu, sales and ZATCA invoice chain on the same browser are never
//      read, overwritten or deleted. Leaving the demo drops the namespace.
//
//   2. THE NETWORK IS OFF. App.jsx checks isDemo() at every Firestore /
//      Cloud Function / ZATCA-service call site and returns early, so a
//      demo session cannot write to client_data, pending_activations or
//      zatca_invoices, and cannot report an invoice to FATOORA.
//
// The same switch also supports a permanently-demo deployment (e.g.
// demo.restopos.store) by building with VITE_DEMO_MODE=true.
// ═══════════════════════════════════════════════════════════════════

export const DEMO_SESSION_KEY = "restopos_demo_session";
export const DEMO_PREFIX = "restopos_demo_sandbox::";
const DEMO_ERROR_KEY = "restopos_demo_error";
export const DEMO_LICENSE_KEY = "DEMO-TRIAL";

// A whole deployment can be a demo. sessionStorage (not localStorage) holds the
// per-tab flag, so it lives outside the sandbox and dies with the tab.
const BUILD_IS_DEMO = String(import.meta.env.VITE_DEMO_MODE || "") === "true";
// Where "Exit demo" should send a visitor on a demo-only deployment.
const DEMO_EXIT_URL = import.meta.env.VITE_DEMO_EXIT_URL || "";

let _demoActive = false;

/** True while this tab is running a sandboxed demo session. */
export function isDemo() { return _demoActive; }

/** True when the whole build is a demo deployment (no way back to signup). */
export function isDemoBuild() { return BUILD_IS_DEMO; }

function demoFlagSet() {
  if (BUILD_IS_DEMO) return true;
  try { return sessionStorage.getItem(DEMO_SESSION_KEY) === "1"; } catch (e) { return false; }
}

// ── Storage sandbox ────────────────────────────────────────────────
function sandboxKeys(real) {
  const out = [];
  for (let i = 0; i < real.length; i++) {
    const k = real.key(i);
    if (k && k.startsWith(DEMO_PREFIX)) out.push(k.slice(DEMO_PREFIX.length));
  }
  return out;
}

function makeSandbox(real) {
  const full = (k) => DEMO_PREFIX + String(k);
  return {
    get length() { return sandboxKeys(real).length; },
    key(i) { const ks = sandboxKeys(real); return (i >= 0 && i < ks.length) ? ks[i] : null; },
    getItem(k) { return real.getItem(full(k)); },
    setItem(k, v) { real.setItem(full(k), String(v)); },
    removeItem(k) { real.removeItem(full(k)); },
    clear() { sandboxKeys(real).forEach((k) => real.removeItem(full(k))); },
  };
}

/** Delete every sandboxed key from the real store. Never touches real data. */
function purgeSandbox(real) {
  try { sandboxKeys(real).forEach((k) => real.removeItem(DEMO_PREFIX + k)); } catch (e) {}
}

/**
 * Install the sandbox and seed sample data — call from main.jsx BEFORE App.jsx
 * (and therefore Firebase) is imported, so every consumer sees the same store.
 * Returns true when the demo is live.
 */
export function installDemoSandbox() {
  let real;
  try { real = window.localStorage; } catch (e) { return false; }
  if (!real) return false;

  if (!demoFlagSet()) {
    // Not in a demo: clean up anything a previous demo session left behind.
    purgeSandbox(real);
    return false;
  }
  try {
    Object.defineProperty(window, "localStorage", {
      value: makeSandbox(real), configurable: true, writable: false,
    });
  } catch (e) {
    // Browser won't let us shadow localStorage — refuse rather than risk
    // writing demo data over a real client's records.
    console.warn("[Demo] storage sandbox unavailable:", e && e.message);
    try {
      sessionStorage.removeItem(DEMO_SESSION_KEY);
      sessionStorage.setItem(DEMO_ERROR_KEY, "1"); // surfaced on the registration screen
    } catch (e2) {}
    return false;
  }
  _demoActive = true;
  seedDemoData();
  return true;
}

/**
 * True once if the last demo attempt couldn't sandbox storage — so the
 * registration screen can explain the failure instead of silently doing nothing.
 * Reading it clears it.
 */
export function consumeDemoStartError() {
  try {
    if (sessionStorage.getItem(DEMO_ERROR_KEY) !== "1") return false;
    sessionStorage.removeItem(DEMO_ERROR_KEY);
    return true;
  } catch (e) { return false; }
}

/** Enter the demo (reloads so the sandbox installs before anything else runs). */
export function startDemo() {
  try { sessionStorage.setItem(DEMO_SESSION_KEY, "1"); } catch (e) {
    alert("Your browser is blocking site storage, so the demo can't start.\nEnable cookies/site data for this site and try again.");
    return false;
  }
  window.location.reload();
  return true;
}

/** Leave the demo: forget the flag, drop all demo data, return to registration. */
export function exitDemo() {
  try { window.localStorage.clear(); } catch (e) {} // sandboxed → demo keys only
  try { sessionStorage.removeItem(DEMO_SESSION_KEY); } catch (e) {}
  if (BUILD_IS_DEMO && DEMO_EXIT_URL) { window.location.href = DEMO_EXIT_URL; return; }
  window.location.reload();
}

/** Wipe whatever the visitor did and re-seed the original sample business. */
export function resetDemo() {
  try { window.localStorage.clear(); } catch (e) {}
  window.location.reload();
}

// ═══════════════════════════════════════════════════════════════════
// SAMPLE BUSINESS
// ═══════════════════════════════════════════════════════════════════

export const DEMO_LICENSE = {
  licenseKey: DEMO_LICENSE_KEY,
  businessName: "Bayt Al Mandi (Demo)",
  businessNameAr: "بيت المندي (تجريبي)",
  ownerName: "Demo User",
  email: "demo@restopos.store",
  crNumber: "1010999999",
  vatNumber: "300000000000003",
  address: "King Fahd Road, Al Olaya",
  city: "Riyadh",
  phone: "+966 53 836 0053",
  businessType: "restaurant",
  isOwner: true,
  subscriptionPlan: "premium",
  activatedAt: new Date().toISOString(),
  isDemo: true,
};

const DEMO_CATEGORIES = ["Mandi & Rice", "Grills", "Appetizers", "Sides", "Drinks", "Desserts"];

const DEMO_ITEMS = [
  { name: "Chicken Mandi (Half)", nameAr: "مندي دجاج نص", category: "Mandi & Rice", price: 27, cost: 12, stock: 60 },
  { name: "Chicken Mandi (Full)", nameAr: "مندي دجاج كامل", category: "Mandi & Rice", price: 49, cost: 22, stock: 40 },
  { name: "Lamb Mandi (Half)", nameAr: "مندي لحم نص", category: "Mandi & Rice", price: 58, cost: 30, stock: 25 },
  { name: "Lamb Mandi (Full)", nameAr: "مندي لحم كامل", category: "Mandi & Rice", price: 105, cost: 55, stock: 15 },
  { name: "Chicken Kabsa", nameAr: "كبسة دجاج", category: "Mandi & Rice", price: 32, cost: 14, stock: 45 },
  { name: "Biryani Rice", nameAr: "رز برياني", category: "Mandi & Rice", price: 18, cost: 6, stock: 50 },
  { name: "Mixed Grill Platter", nameAr: "مشاوي مشكلة", category: "Grills", price: 72, cost: 34, stock: 20 },
  { name: "Shish Tawook", nameAr: "شيش طاووق", category: "Grills", price: 38, cost: 17, stock: 30 },
  { name: "Lamb Kofta", nameAr: "كفتة لحم", category: "Grills", price: 42, cost: 19, stock: 28 },
  { name: "Grilled Hammour", nameAr: "هامور مشوي", category: "Grills", price: 68, cost: 33, stock: 12 },
  { name: "Hummus", nameAr: "حمص", category: "Appetizers", price: 14, cost: 4, stock: 60 },
  { name: "Mutabbal", nameAr: "متبل", category: "Appetizers", price: 15, cost: 5, stock: 50 },
  { name: "Fattoush Salad", nameAr: "سلطة فتوش", category: "Appetizers", price: 19, cost: 6, stock: 40 },
  { name: "Cheese Sambousek", nameAr: "سمبوسة جبن", category: "Appetizers", price: 12, cost: 4, stock: 70 },
  { name: "French Fries", nameAr: "بطاطس مقلية", category: "Sides", price: 11, cost: 3, stock: 120 },
  { name: "Arabic Bread", nameAr: "خبز عربي", category: "Sides", price: 4, cost: 1, stock: 200 },
  { name: "Garlic Sauce", nameAr: "صلصة ثوم", category: "Sides", price: 5, cost: 1, stock: 150 },
  { name: "Soft Drink Can", nameAr: "مشروب غازي", category: "Drinks", price: 6, cost: 2, stock: 200 },
  { name: "Fresh Lemon Mint", nameAr: "ليمون بالنعناع", category: "Drinks", price: 16, cost: 4, stock: 60 },
  { name: "Saudi Coffee Pot", nameAr: "دلة قهوة عربية", category: "Drinks", price: 22, cost: 6, stock: 35 },
  { name: "Water 600ml", nameAr: "مياه", category: "Drinks", price: 3, cost: 1, stock: 300 },
  { name: "Umm Ali", nameAr: "أم علي", category: "Desserts", price: 20, cost: 7, stock: 25 },
  { name: "Kunafa", nameAr: "كنافة", category: "Desserts", price: 24, cost: 9, stock: 20 },
  { name: "Date Cake", nameAr: "كيكة التمر", category: "Desserts", price: 18, cost: 6, stock: 22 },
];

const DEMO_CUSTOMER_NAMES = [
  ["Abdullah Al Qahtani", "0551234567"], ["Sara Al Harbi", "0559876543"],
  ["Mohammed Al Otaibi", "0533221144"], ["Layla Al Zahrani", "0544556677"],
  ["Faisal Al Dossary", "0566778899"], ["Noura Al Shammari", "0577889900"],
];

// Deterministic PRNG — the same demo dataset every time, so screenshots,
// support answers and sales walkthroughs all line up.
function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const r2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().split("T")[0];

/**
 * ~5 weeks of trading history, so Dashboard / Reports / Financials / VAT all
 * have something real to show the moment the visitor lands.
 */
function buildDemoSales(items) {
  const rng = makeRng(20260727);
  const sales = [];
  const today = new Date();
  let vno = 1000;

  for (let back = 34; back >= 0; back--) {
    const day = new Date(today);
    day.setDate(day.getDate() - back);
    const date = iso(day);
    const dow = day.getDay();                       // 5 = Friday (busiest)
    const base = dow === 5 ? 26 : dow === 4 || dow === 6 ? 21 : 14;
    const count = Math.max(4, Math.round(base + (rng() - 0.5) * 8) - (back === 0 ? 6 : 0));

    for (let n = 0; n < count; n++) {
      const lineCount = 1 + Math.floor(rng() * 4);
      const chosen = [];
      for (let l = 0; l < lineCount; l++) {
        const it = pick(rng, items);
        if (chosen.some((c) => c.id === it.id)) continue;
        chosen.push({ ...it, qty: 1 + Math.floor(rng() * 3) });
      }
      if (!chosen.length) continue;

      const gross = r2(chosen.reduce((s, i) => s + i.price * i.qty, 0));
      const vat = r2(gross * (15 / 115));
      const subtotal = r2(gross - vat);
      const type = rng() < 0.45 ? "Dine-in" : rng() < 0.75 ? "Takeaway" : "Delivery";
      const payMethod = rng() < 0.42 ? "Cash" : rng() < 0.85 ? "Mada" : "Card";
      const hour = 11 + Math.floor(rng() * 12);
      const minute = Math.floor(rng() * 60);
      const at = new Date(day);
      at.setHours(hour, minute, 0, 0);
      const named = rng() < 0.4 ? pick(rng, DEMO_CUSTOMER_NAMES) : null;
      vno += 1;

      sales.push({
        id: "INV-" + vno,
        token: n + 1,
        voucher: "INV-" + vno,
        user: "Demo Cashier",
        date,
        time: at.toLocaleTimeString("en-SA", { hour: "2-digit", minute: "2-digit" }),
        createdAt: at.toISOString(),
        type,
        billType: "normal",
        table: type === "Dine-in" ? 1 + Math.floor(rng() * 12) : null,
        items: chosen,
        subtotal,
        discount: 0,
        manualDiscount: 0,
        promoDiscount: 0,
        promoCode: "",
        vat,
        total: gross,
        status: "completed",
        cashier: "Demo Cashier",
        note: "",
        customer: named ? named[0] : "",
        customerPhone: named ? named[1] : "",
        customerAddress: "",
        payMethod,
        given: payMethod === "Cash" ? Math.ceil(gross / 10) * 10 : gross,
        change: payMethod === "Cash" ? r2(Math.ceil(gross / 10) * 10 - gross) : 0,
        cashAmount: payMethod === "Cash" ? gross : 0,
        cardAmount: payMethod === "Cash" ? 0 : gross,
        printAndSave: true,
        isDraft: false,
        isKotOnly: false,
        isDemo: true,
      });
    }
  }
  return { sales, lastVno: vno };
}

function buildDemoCustomers(sales) {
  const now = new Date().toISOString();
  return DEMO_CUSTOMER_NAMES.map(([name, phone], i) => {
    const mine = sales.filter((s) => s.customerPhone === phone);
    return {
      id: 900000 + i,
      name,
      phone,
      email: "",
      address: "Riyadh",
      notes: "",
      createdAt: now,
      updatedAt: now,
      loyaltyPoints: Math.round(mine.reduce((s, x) => s + x.total, 0) / 10),
      creditBalance: 0,
      creditLimit: 0,
    };
  });
}

function buildDemoExpenses() {
  const today = new Date();
  const dayAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
  return [
    { id: 910001, date: dayAgo(28), category: "Rent", description: "Monthly shop rent", amount: 9000, paidBy: "Bank" },
    { id: 910002, date: dayAgo(21), category: "Salaries", description: "Kitchen staff", amount: 14500, paidBy: "Bank" },
    { id: 910003, date: dayAgo(14), category: "Supplies", description: "Meat & poultry", amount: 6200, paidBy: "Cash" },
    { id: 910004, date: dayAgo(7), category: "Utilities", description: "Electricity & water", amount: 1850, paidBy: "Bank" },
    { id: 910005, date: dayAgo(3), category: "Supplies", description: "Vegetables & bread", amount: 1420, paidBy: "Cash" },
  ];
}

/**
 * Write the sample business into the sandbox. Only runs on a fresh sandbox —
 * once the visitor starts changing things, their demo session is preserved
 * across reloads until they exit or hit "Reset demo".
 */
export function seedDemoData() {
  const set = (k, v) => { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const raw = (k, v) => { try { window.localStorage.setItem(k, String(v)); } catch (e) {} };
  let already = false;
  try { already = !!window.localStorage.getItem("restopos_demo_seeded"); } catch (e) {}
  if (already) return;

  const items = DEMO_ITEMS.map((it, i) => ({
    ...it, id: 800001 + i, active: true, barcode: "", weighed: false,
  }));
  const { sales, lastVno } = buildDemoSales(items);

  set("restopos_license_v2", DEMO_LICENSE);
  // Marks the account approved + active so the demo lands straight in the POS
  // instead of the credentials / pending-approval screens.
  set("restopos_client_creds", { username: "demo", approved: true, active: true, isDemo: true });
  set("restopos_categories", DEMO_CATEGORIES);
  set("restopos_items", items);
  set("restopos_sales", sales);
  set("restopos_vno", lastVno);
  set("restopos_kot", 1);
  set("restopos_customers", buildDemoCustomers(sales));
  set("restopos_expenses", buildDemoExpenses());
  set("restopos_tables", Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, status: i === 2 || i === 5 || i === 8 ? "occupied" : "free", capacity: i < 8 ? 4 : 6,
  })));
  set("restopos_promos", [
    { id: 920001, code: "WELCOME10", type: "%", value: 10, minOrder: 50, active: true },
    { id: 920002, code: "FAMILY20", type: "SAR", value: 20, minOrder: 150, active: true },
  ]);
  set("restopos_company", {
    name: DEMO_LICENSE.businessName, phone: DEMO_LICENSE.phone, email: DEMO_LICENSE.email,
    address: DEMO_LICENSE.address, city: DEMO_LICENSE.city, vatNumber: DEMO_LICENSE.vatNumber,
    crNumber: DEMO_LICENSE.crNumber,
  });
  set("restopos_users", [
    { id: 930001, name: "Demo Admin", username: "demo.admin", role: "Admin", active: true, lastLogin: "Never" },
    { id: 930002, name: "Demo Cashier", username: "demo.cashier", role: "Cashier", active: true, lastLogin: "Never" },
  ]);
  // ZATCA counters start fresh — the demo never touches the real invoice chain.
  raw("zatca_icv_v2", "1000");
  set("restopos_daily_token", { date: iso(new Date()), token: 0 });
  raw("restopos_demo_seeded", "1");
  console.log(`[Demo] Sample business seeded — ${items.length} items, ${sales.length} invoices.`);
}
