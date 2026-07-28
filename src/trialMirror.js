// ═══════════════════════════════════════════════════════════════════
// TRIAL DATA MIRROR — everything a trial does, readable in Firebase
//
// A trial already backs itself up to client_data/{key}, but that document
// stores each localStorage key as one long JSON *string*. It restores
// perfectly and is useless to look at: the Firebase console shows a wall of
// escaped text.
//
// This mirrors the same data into a `trials` collection as real documents
// with real fields, so the operator can open the Firebase console (or the
// admin panel) and actually read a trial:
//
//   trials/{TRIAL-05xxxxxxxx}                  ← who they are + how they're using it
//     ├── sales/{INV-1042}                     ← every invoice, one doc each
//     ├── products/{itemId}                    ← their catalogue
//     └── customers/{customerId}               ← their CRM
//
// client_data stays the restore path — this is the readable view alongside
// it, never a replacement.
//
// Everything here is best-effort: a failed mirror write must never break the
// till, so every path is wrapped and errors are logged, not thrown.
// ═══════════════════════════════════════════════════════════════════

const MIRROR_STATE_KEY = "restopos_trial_mirror_state";
const DEBOUNCE_MS = 6000;
const BATCH_LIMIT = 400; // Firestore caps a batch at 500; leave headroom.

let fb = null;          // injected Firestore handles
let timer = null;
let inFlight = false;
let pending = null;

/**
 * Wire up the Firestore functions from App.jsx rather than initialising a
 * second Firebase app here — one app, one auth session, one connection.
 */
export function initTrialMirror(deps) { fb = deps; }

function loadState() {
  try { return JSON.parse(localStorage.getItem(MIRROR_STATE_KEY) || "{}"); } catch (e) { return {}; }
}
function saveState(s) {
  try { localStorage.setItem(MIRROR_STATE_KEY, JSON.stringify(s)); } catch (e) {}
}

// Cheap content fingerprint, so unchanged rows aren't rewritten every cycle.
function fingerprint(obj) {
  const s = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h.toString(36);
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const str = (v) => (v == null ? "" : String(v));

// ── Shapes: small, flat and readable in the console ────────────────
function saleDoc(s) {
  return {
    invoiceNo: str(s.id),
    date: str(s.date),
    time: str(s.time),
    createdAt: str(s.createdAt || ""),
    orderType: str(s.type),
    payMethod: str(s.payMethod),
    subtotal: num(s.subtotal),
    vat: num(s.vat),
    discount: num(s.discount),
    total: num(s.total),
    itemCount: (s.items || []).reduce((n, i) => n + (Number(i.qty) || 0), 0),
    items: (s.items || []).slice(0, 40).map((i) => ({
      name: str(i.name), qty: Number(i.qty) || 0, price: num(i.price), category: str(i.category),
    })),
    cashier: str(s.cashier || s.user),
    customer: str(s.customer),
    customerPhone: str(s.customerPhone),
    status: str(s.status || "completed"),
    table: s.table == null ? null : String(s.table),
  };
}

function productDoc(i) {
  return {
    name: str(i.name), nameAr: str(i.nameAr), category: str(i.category),
    price: num(i.price), cost: num(i.cost), stock: Number(i.stock) || 0,
    barcode: str(i.barcode), weighed: !!i.weighed, active: i.active !== false,
  };
}

function customerDoc(c) {
  return {
    name: str(c.name), phone: str(c.phone), email: str(c.email), address: str(c.address),
    loyaltyPoints: Number(c.loyaltyPoints) || 0, createdAt: str(c.createdAt || ""),
  };
}

/**
 * The at-a-glance record: who signed up, how far into the trial they are, and
 * what they've actually done with it. This is the document to read when
 * deciding whether a trial is worth a phone call.
 */
function summaryDoc({ meta, license, sales, items, customers, appVersion }) {
  const completed = sales.filter((s) => s.status !== "voided" && !s.isDraft);
  const revenue = completed.reduce((n, s) => n + (Number(s.total) || 0), 0);
  const vat = completed.reduce((n, s) => n + (Number(s.vat) || 0), 0);

  // Per-day totals — a trial is 14 days, so this stays small and readable.
  const byDay = {};
  const payMix = {};
  const byProduct = {};
  for (const s of completed) {
    const d = str(s.date) || "unknown";
    if (!byDay[d]) byDay[d] = { orders: 0, total: 0 };
    byDay[d].orders += 1;
    byDay[d].total = num(byDay[d].total + (Number(s.total) || 0));

    const pm = str(s.payMethod) || "Other";
    payMix[pm] = num((payMix[pm] || 0) + (Number(s.total) || 0));

    for (const it of s.items || []) {
      const k = str(it.name) || "—";
      if (!byProduct[k]) byProduct[k] = { name: k, qty: 0, total: 0 };
      byProduct[k].qty += Number(it.qty) || 0;
      byProduct[k].total = num(byProduct[k].total + (Number(it.price) || 0) * (Number(it.qty) || 0));
    }
  }
  const dates = completed.map((s) => str(s.createdAt || s.date)).filter(Boolean).sort();
  const endsAt = meta.endsAt || "";
  const daysLeft = endsAt
    ? Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86400000))
    : null;

  return {
    // identity — matches pending_activations/TRIAL-<mobile>
    trialKey: str(meta.key),
    mobile: str(meta.phone),
    businessName: str(meta.businessName || license?.businessName),
    ownerName: str(meta.ownerName),
    email: str(meta.email),
    city: str(meta.city),
    businessType: str(license?.businessType || meta.businessType),

    // where they are in the 14 days
    trialStartedAt: str(meta.startedAt),
    trialEndsAt: str(endsAt),
    daysLeft,
    daysUsed: meta.startedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(meta.startedAt).getTime()) / 86400000))
      : null,
    expired: endsAt ? Date.now() > new Date(endsAt).getTime() : false,

    // what they've actually done with it
    productCount: items.length,
    customerCount: customers.length,
    invoiceCount: completed.length,
    revenueTotal: num(revenue),
    vatTotal: num(vat),
    averageOrder: completed.length ? num(revenue / completed.length) : 0,
    firstSaleAt: dates[0] || "",
    lastSaleAt: dates[dates.length - 1] || "",
    activeDays: Object.keys(byDay).length,
    salesByDay: byDay,
    paymentMix: payMix,
    topProducts: Object.values(byProduct).sort((a, b) => b.qty - a.qty).slice(0, 8),

    // housekeeping
    appVersion: str(appVersion),
    lastActiveAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Write docs in chunks that stay under Firestore's batch cap. */
async function commitChunks(ops) {
  const { db, writeBatch, doc, collection } = fb;
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + BATCH_LIMIT)) {
      const ref = doc(collection(db, "trials", op.parent, op.sub), op.id);
      if (op.delete) batch.delete(ref);
      else batch.set(ref, op.data, { merge: true });
    }
    await batch.commit();
  }
}

/**
 * Mirror one collection (sales / products / customers), writing only what
 * changed and removing rows the client has deleted. `rows` is [{id, data}].
 */
function diffOps(parent, sub, rows, state) {
  const prev = state[sub] || {};
  const next = {};
  const ops = [];
  for (const r of rows) {
    const id = String(r.id);
    if (!id || id === "undefined") continue;
    const fp = fingerprint(r.data);
    next[id] = fp;
    if (prev[id] !== fp) ops.push({ parent, sub, id, data: r.data });
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) ops.push({ parent, sub, id, delete: true });
  }
  state[sub] = next;
  return ops;
}

async function runMirror(payload) {
  const { db, doc, setDoc } = fb;
  const { meta } = payload;
  if (!meta || !meta.key) return;
  const key = meta.key;
  const state = loadState();

  // 1. The summary always goes out — it carries lastActiveAt, which is how
  //    the operator can tell a live trial from an abandoned one.
  await setDoc(doc(db, "trials", key), summaryDoc(payload), { merge: true });

  // 2. Then only the rows that actually changed.
  const ops = [
    ...diffOps(key, "sales", payload.sales
      .filter((s) => s.status !== "voided")
      .slice(-800)                                   // a 14-day trial won't approach this
      .map((s) => ({ id: s.id, data: saleDoc(s) })), state),
    ...diffOps(key, "products", payload.items.map((i) => ({ id: i.id, data: productDoc(i) })), state),
    ...diffOps(key, "customers", payload.customers.map((c) => ({ id: c.id, data: customerDoc(c) })), state),
  ];
  if (ops.length) await commitChunks(ops);
  saveState(state);
  if (ops.length) console.log(`[TrialMirror] ${key}: summary + ${ops.length} row(s) updated.`);
}

/**
 * Queue a mirror. Debounced, and never overlapping — a burst of sales during
 * a lunch rush results in one write cycle, not fifty.
 */
export function mirrorTrialData(payload) {
  if (!fb || !payload?.meta?.key) return;
  pending = payload;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (inFlight) { timer = setTimeout(() => mirrorTrialData(pending), 2000); return; }
    inFlight = true;
    const p = pending;
    try { await runMirror(p); }
    catch (e) { console.warn("[TrialMirror] failed:", e && e.message); }
    finally { inFlight = false; }
  }, DEBOUNCE_MS);
}

/** Flush immediately — used when the tab is closing. */
export async function flushTrialMirror(payload) {
  if (!fb || !payload?.meta?.key || inFlight) return;
  if (timer) { clearTimeout(timer); timer = null; }
  inFlight = true;
  try { await runMirror(payload); }
  catch (e) { console.warn("[TrialMirror] flush failed:", e && e.message); }
  finally { inFlight = false; }
}

/** Forget what's been mirrored, so the next cycle rewrites everything. */
export function resetTrialMirrorState() { saveState({}); }
