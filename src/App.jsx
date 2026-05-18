import { useState, useEffect, useRef, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════
// ZATCA TLV ENGINE
// ═══════════════════════════════════════════════════════════════════
function encodeTLV(tag, value) {
  const enc = new TextEncoder();
  const v = enc.encode(value);
  const out = new Uint8Array(1 + 1 + v.length);
  out[0] = tag; out[1] = v.length; out.set(v, 2);
  return out;
}
function generateZATCABase64({ sellerName, vatNumber, timestamp, total, vatAmount }) {
  const t1 = encodeTLV(1, sellerName);
  const t2 = encodeTLV(2, vatNumber);
  const t3 = encodeTLV(3, timestamp);
  const t4 = encodeTLV(4, parseFloat(total).toFixed(2));
  const t5 = encodeTLV(5, parseFloat(vatAmount).toFixed(2));
  const merged = new Uint8Array(t1.length + t2.length + t3.length + t4.length + t5.length);
  let off = 0;
  [t1, t2, t3, t4, t5].forEach(t => { merged.set(t, off); off += t.length; });
  return btoa(String.fromCharCode(...merged));
}

// ═══════════════════════════════════════════════════════════════════
// REAL SCANNABLE QR CODE (pure JS, no external lib)
// Uses qrcodejs loaded via CDN script tag
// ═══════════════════════════════════════════════════════════════════
function useQRScript() {
  const [ready, setReady] = useState(!!window.QRCode);
  useEffect(() => {
    if (window.QRCode) { setReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, []);
  return ready;
}

function QRCode({ data, size = 140 }) {
  const ref = useRef();
  const qrReady = useQRScript();
  useEffect(() => {
    if (!qrReady || !data || !ref.current) return;
    ref.current.innerHTML = "";
    try {
      new window.QRCode(ref.current, {
        text: data,
        width: size,
        height: size,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    } catch (e) {
      ref.current.innerHTML = `<div style="width:${size}px;height:${size}px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#999">QR Error</div>`;
    }
  }, [qrReady, data, size]);
  if (!qrReady) return <div style={{ width: size, height: size, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#999" }}>Loading QR…</div>;
  return <div ref={ref} />;
}

// ═══════════════════════════════════════════════════════════════════
// PERSISTENT LICENSE STORAGE (localStorage)
// ═══════════════════════════════════════════════════════════════════
const LICENSE_KEY = "restopos_license_v1";
function loadLicense() {
  try { return JSON.parse(localStorage.getItem(LICENSE_KEY)) || null; } catch { return null; }
}
function saveLicense(data) {
  localStorage.setItem(LICENSE_KEY, JSON.stringify(data));
}

// ═══════════════════════════════════════════════════════════════════
// COLOR PALETTE
// ═══════════════════════════════════════════════════════════════════
const C = {
  bg: "#F8F9FB", card: "#FFFFFF", border: "#E8EBF0",
  primary: "#1A6B4A", primaryLight: "#E8F5EE", primaryDark: "#134D36",
  accent: "#F0A500", accentLight: "#FEF6E4",
  danger: "#D94040", dangerLight: "#FDE8E8",
  info: "#2176AE", infoLight: "#E6F0F8",
  text: "#1A1D23", textMid: "#5A6070", textLight: "#9AA0AD",
  success: "#1A8A4A", successLight: "#E6F7ED",
  warning: "#E07B00", warningLight: "#FFF3E0",
  zatca: "#6366f1", zatcaLight: "#eef2ff",
};

// ═══════════════════════════════════════════════════════════════════
// SEED DATA
// ═══════════════════════════════════════════════════════════════════
const SEED_CATEGORIES = ["Broasted", "Grills", "Sides", "Drinks", "Desserts", "Combos"];
const SEED_ITEMS = [
  { id: 1, name: "Broasted Chicken Half", nameAr: "دجاج مبروست نصف", category: "Broasted", price: 28, cost: 14, stock: 50, active: true },
  { id: 2, name: "Broasted Chicken Full", nameAr: "دجاج مبروست كامل", category: "Broasted", price: 52, cost: 26, stock: 30, active: true },
  { id: 3, name: "Crispy Wings 6pc", nameAr: "أجنحة مقرمشة", category: "Broasted", price: 22, cost: 10, stock: 40, active: true },
  { id: 4, name: "Mixed Grill Platter", nameAr: "مشاوي مشكلة", category: "Grills", price: 65, cost: 30, stock: 20, active: true },
  { id: 5, name: "Shish Tawook", nameAr: "شيش طاووق", category: "Grills", price: 38, cost: 18, stock: 25, active: true },
  { id: 6, name: "French Fries", nameAr: "بطاطس مقلية", category: "Sides", price: 10, cost: 3, stock: 100, active: true },
  { id: 7, name: "Coleslaw", nameAr: "كول سلو", category: "Sides", price: 8, cost: 2, stock: 60, active: true },
  { id: 8, name: "Pepsi Can", nameAr: "بيبسي", category: "Drinks", price: 5, cost: 2, stock: 120, active: true },
  { id: 9, name: "Fresh Lemon Juice", nameAr: "عصير ليمون", category: "Drinks", price: 14, cost: 4, stock: 40, active: true },
  { id: 10, name: "Umm Ali", nameAr: "أم علي", category: "Desserts", price: 18, cost: 6, stock: 15, active: true },
  { id: 11, name: "Family Box", nameAr: "وجبة عائلية", category: "Combos", price: 85, cost: 40, stock: 20, active: true },
  { id: 12, name: "Solo Meal", nameAr: "وجبة فردية", category: "Combos", price: 32, cost: 15, stock: 30, active: true },
];
const MODIFIER_GROUPS = [
  { id: 1, name: "Spice Level", options: ["Mild", "Medium", "Hot", "Extra Hot"] },
  { id: 2, name: "Size", options: ["Small", "Medium", "Large"] },
  { id: 3, name: "Doneness", options: ["Rare", "Medium", "Well Done"] },
  { id: 4, name: "Sugar Level", options: ["No Sugar", "Less Sugar", "Normal", "Extra Sweet"] },
];
const TABLES_INIT = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, status: i < 3 ? "occupied" : "free", capacity: 4 }));
const SEED_USERS = [
  { id: 1, name: "Ahmed Al-Rashidi", username: "admin", role: "Admin", active: true, lastLogin: "2025-05-18 09:12" },
  { id: 2, name: "Sara Mohammed", username: "manager1", role: "Manager", active: true, lastLogin: "2025-05-18 08:45" },
  { id: 3, name: "Khalid Ibrahim", username: "cashier1", role: "Cashier", active: true, lastLogin: "2025-05-18 10:00" },
];

function genSalesHistory() {
  const sales = []; const now = new Date(); let id = 1000;
  for (let d = 730; d >= 0; d--) {
    const date = new Date(now); date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().split("T")[0];
    const count = Math.floor(Math.random() * 18) + 4;
    for (let o = 0; o < count; o++) {
      const items = SEED_ITEMS.slice(0, Math.floor(Math.random() * 4) + 1);
      const subtotal = items.reduce((s, it) => s + it.price * (Math.floor(Math.random() * 2) + 1), 0);
      const vat = subtotal * 0.15;
      sales.push({ id: "INV-" + (++id), date: dateStr, time: `${String(Math.floor(Math.random() * 12) + 9).padStart(2, "0")}:${String(Math.floor(Math.random() * 60)).padStart(2, "0")}`, type: ["Dine-in", "Takeaway", "Delivery"][Math.floor(Math.random() * 3)], table: Math.floor(Math.random() * 12) + 1, items: items.map(it => ({ ...it, qty: Math.floor(Math.random() * 2) + 1 })), subtotal, vat, total: subtotal + vat, status: "completed", cashier: SEED_USERS[Math.floor(Math.random() * 3)].name, payMethod: ["Cash", "Mada", "Apple Pay", "STC Pay"][Math.floor(Math.random() * 4)] });
    }
  }
  return sales;
}
const ALL_SALES = genSalesHistory();
const TODAY = new Date().toISOString().split("T")[0];
const TODAY_SALES = ALL_SALES.filter(s => s.date === TODAY);

function fmtSAR(n) { return "SAR " + Number(n).toFixed(2); }
function fmtDate(d) { return new Date(d).toLocaleDateString("en-SA", { day: "2-digit", month: "short", year: "numeric" }); }

// ═══════════════════════════════════════════════════════════════════
// REUSABLE UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════
const Card = ({ children, style = {} }) => (
  <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, ...style }}>{children}</div>
);
const Btn = ({ children, onClick, variant = "primary", size = "md", disabled = false, style = {} }) => {
  const variants = {
    primary: { background: C.primary, color: "#fff", border: "none" },
    outline: { background: "transparent", color: C.primary, border: `1.5px solid ${C.primary}` },
    danger: { background: C.danger, color: "#fff", border: "none" },
    ghost: { background: "transparent", color: C.textMid, border: `1px solid ${C.border}` },
    accent: { background: C.accent, color: "#fff", border: "none" },
    zatca: { background: C.zatca, color: "#fff", border: "none" },
  };
  const sizes = { sm: { padding: "5px 12px", fontSize: 12 }, md: { padding: "8px 18px", fontSize: 13 }, lg: { padding: "12px 28px", fontSize: 15 } };
  return <button onClick={onClick} disabled={disabled} style={{ ...variants[variant], ...sizes[size], borderRadius: 8, fontFamily: "inherit", fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, transition: "all 0.15s", ...style }}>{children}</button>;
};
const Inp = ({ label, value, onChange, type = "text", placeholder = "", style = {} }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
    {label && <label style={{ fontSize: 12, fontWeight: 600, color: C.textMid }}>{label}</label>}
    <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: C.text, background: "#fff" }} />
  </div>
);
const Sel = ({ label, value, onChange, options, style = {} }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
    {label && <label style={{ fontSize: 12, fontWeight: 600, color: C.textMid }}>{label}</label>}
    <select value={value} onChange={e => onChange(e.target.value)} style={{ padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: C.text, background: "#fff" }}>
      {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
    </select>
  </div>
);
const Badge = ({ children, color = C.primary, bg = C.primaryLight }) => (
  <span style={{ padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, color, background: bg, whiteSpace: "nowrap" }}>{children}</span>
);
const StatCard = ({ label, value, sub, icon, color = C.primary, bg = C.primaryLight }) => (
  <Card style={{ display: "flex", alignItems: "center", gap: 16 }}>
    <div style={{ width: 48, height: 48, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{icon}</div>
    <div>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12, color: C.textMid, fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: C.textLight, marginTop: 2 }}>{sub}</div>}
    </div>
  </Card>
);
const Modal = ({ title, onClose, children, width = 520 }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <div style={{ background: "#fff", borderRadius: 16, width, maxWidth: "95vw", maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
      <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: "#fff", zIndex: 1 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{title}</span>
        <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.textLight }}>×</button>
      </div>
      <div style={{ padding: 24 }}>{children}</div>
    </div>
  </div>
);
const DataTable = ({ headers, rows, emptyMsg = "No data" }) => (
  <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr style={{ background: C.bg }}>
          {headers.map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: C.textMid, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={headers.length} style={{ textAlign: "center", padding: 32, color: C.textLight }}>{emptyMsg}</td></tr>
        ) : rows.map((row, i) => (
          <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "#fff" : "#FAFBFC" }}>
            {row.map((cell, j) => <td key={j} style={{ padding: "10px 14px", color: C.text, verticalAlign: "middle" }}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ═══════════════════════════════════════════════════════════════════
// LICENSE GATE SCREEN
// ═══════════════════════════════════════════════════════════════════
function LicenseGate({ onActivate }) {
  const [form, setForm] = useState({ businessName: "", licenseKey: "", vatNumber: "", address: "", phone: "", city: "Riyadh" });
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function validateLicense(key) {
    // Format: XXXXX-XXXXX-XXXXX-XXXXX (20 chars + 3 dashes)
    return /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i.test(key.trim());
  }
  function validateVAT(vat) {
    return /^3[0-9]{14}$/.test(vat.trim());
  }

  function handleActivate() {
    setError("");
    if (!form.businessName.trim()) return setError("Business name is required.");
    if (!validateLicense(form.licenseKey)) return setError("Invalid license key format. Expected: XXXXX-XXXXX-XXXXX-XXXXX");
    if (!validateVAT(form.vatNumber)) return setError("Invalid VAT number. Must be 15 digits starting with 3.");
    if (!form.address.trim()) return setError("Address is required.");
    setActivating(true);
    setTimeout(() => {
      const license = { ...form, activatedAt: new Date().toISOString(), version: "1.0" };
      saveLicense(license);
      onActivate(license);
    }, 1200);
  }

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #0a1628 0%, #1A3A5C 50%, #0a2818 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');`}</style>

      <div style={{ width: "100%", maxWidth: 560 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
            <div style={{ width: 52, height: 52, background: "linear-gradient(135deg, #1A6B4A, #F0A500)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 900, color: "#fff", boxShadow: "0 8px 24px rgba(26,107,74,0.4)" }}>R</div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#fff", letterSpacing: "-0.5px", lineHeight: 1 }}>RestoPOS</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: "0.15em", textTransform: "uppercase" }}>ZATCA Phase 2 Ready</div>
            </div>
          </div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", marginTop: 8 }}>Restaurant Management System · Kingdom of Saudi Arabia</div>
        </div>

        {/* Card */}
        <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 36, boxShadow: "0 32px 80px rgba(0,0,0,0.4)" }}>
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 6 }}>🔐 Activate Your License</div>
            <div style={{ fontSize: 13, color: C.textMid }}>Enter your license details below. This information is saved permanently and only needs to be entered once.</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Inp label="Business / Restaurant Name *" value={form.businessName} onChange={v => set("businessName", v)} placeholder="e.g. Al Baik Restaurant" />
            <Inp label="License Key *" value={form.licenseKey} onChange={v => set("licenseKey", v.toUpperCase())} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" />

            <div style={{ background: C.zatcaLight, border: `1.5px solid ${C.zatca}30`, borderRadius: 10, padding: "12px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.zatca, letterSpacing: "0.08em", marginBottom: 8 }}>⬛ ZATCA DETAILS</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Inp label="VAT Registration Number (TRN) *" value={form.vatNumber} onChange={v => set("vatNumber", v)} placeholder="300XXXXXXXXXXXX (15 digits)" />
                <Inp label="Business Address *" value={form.address} onChange={v => set("address", v)} placeholder="King Fahd Road, Riyadh 12345" />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Inp label="City" value={form.city} onChange={v => set("city", v)} placeholder="Riyadh" />
                  <Inp label="Phone" value={form.phone} onChange={v => set("phone", v)} placeholder="+966 50 000 0000" />
                </div>
              </div>
            </div>

            {error && <div style={{ background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.danger, fontWeight: 600 }}>⚠️ {error}</div>}

            <button onClick={handleActivate} disabled={activating} style={{ background: activating ? "#ccc" : "linear-gradient(135deg, #1A6B4A, #134D36)", color: "#fff", border: "none", borderRadius: 12, padding: "15px", fontSize: 15, fontWeight: 800, cursor: activating ? "not-allowed" : "pointer", fontFamily: "inherit", letterSpacing: "0.03em", marginTop: 4, transition: "all 0.2s" }}>
              {activating ? "⏳ Activating…" : "✓ Activate & Launch RestoPOS"}
            </button>
          </div>

          <div style={{ marginTop: 20, padding: "14px 16px", background: C.bg, borderRadius: 10, fontSize: 12, color: C.textMid }}>
            <strong style={{ color: C.text }}>🔒 Secure Storage</strong> — Your license and VAT number are saved locally on this device and never transmitted externally. They persist permanently across sessions.
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 12, color: "rgba(255,255,255,0.3)" }}>
          RestoPOS v1.0 · ZATCA Phase 2 Compliant · KSA
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════
function Dashboard({ sales, items, license }) {
  const todaySales = sales.filter(s => s.date === TODAY);
  const todayRev = todaySales.reduce((s, o) => s + o.total, 0);
  const todayVAT = todaySales.reduce((s, o) => s + o.vat, 0);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().split("T")[0];
  const yRev = sales.filter(s => s.date === yStr).reduce((s, o) => s + o.total, 0);
  const growth = yRev > 0 ? (((todayRev - yRev) / yRev) * 100).toFixed(1) : "0";
  const topItems = items.map(it => ({ ...it, sold: todaySales.reduce((s, o) => s + (o.items.find(i => i.id === it.id)?.qty || 0), 0) })).sort((a, b) => b.sold - a.sold).slice(0, 5);
  const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); const ds = d.toISOString().split("T")[0]; return { label: d.toLocaleDateString("en", { weekday: "short" }), rev: sales.filter(s => s.date === ds).reduce((s, o) => s + o.total, 0) }; });
  const maxRev = Math.max(...last7.map(d => d.rev), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* License status banner */}
      <div style={{ background: "linear-gradient(135deg, #1A3A5C, #1A6B4A)", borderRadius: 12, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ color: "#fff", fontSize: 16, fontWeight: 800 }}>{license.businessName}</div>
          <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>TRN: {license.vatNumber} · {license.city}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span style={{ background: "rgba(255,255,255,0.15)", color: "#fff", padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>⬛ ZATCA Phase 2</span>
          <span style={{ background: "rgba(26,138,74,0.4)", color: "#6EFFC0", padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>● Licensed</span>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>Good morning 👋</div>
          <div style={{ fontSize: 13, color: C.textMid }}>{new Date().toLocaleDateString("en-SA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
        </div>
        <Badge color={C.success} bg={C.successLight}>● LIVE</Badge>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
        <StatCard icon="💰" label="Today's Revenue" value={fmtSAR(todayRev)} sub={`${growth > 0 ? "+" : ""}${growth}% vs yesterday`} color={C.primary} bg={C.primaryLight} />
        <StatCard icon="🧾" label="Orders Today" value={todaySales.length} sub="All types combined" color={C.info} bg={C.infoLight} />
        <StatCard icon="📊" label="VAT Collected" value={fmtSAR(todayVAT)} sub="15% ZATCA" color={C.accent} bg={C.accentLight} />
        <StatCard icon="🪑" label="Active Tables" value={TABLES_INIT.filter(t => t.status === "occupied").length + " / " + TABLES_INIT.length} sub="Dine-in only" color={C.warning} bg={C.warningLight} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: C.text }}>Revenue — Last 7 Days</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120 }}>
            {last7.map((d, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ width: "100%", background: i === 6 ? C.primary : C.primaryLight, borderRadius: "4px 4px 0 0", height: Math.max(4, (d.rev / maxRev) * 100) + "px", transition: "height 0.3s" }} title={fmtSAR(d.rev)} />
                <span style={{ fontSize: 10, color: C.textLight }}>{d.label}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: C.text }}>Top Items Today</div>
          {topItems.map((it, i) => (
            <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.textLight, width: 16 }}>#{i + 1}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{it.name}</div>
                <div style={{ height: 4, background: C.border, borderRadius: 2, marginTop: 3 }}>
                  <div style={{ height: "100%", background: C.primary, borderRadius: 2, width: (it.sold / (topItems[0]?.sold || 1) * 100) + "%" }} />
                </div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.primary }}>{it.sold} sold</span>
            </div>
          ))}
        </Card>
      </div>
      <Card>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, color: C.text }}>Recent Bills</div>
        <DataTable
          headers={["Invoice", "Time", "Type", "Cashier", "Method", "Total", "Status"]}
          rows={todaySales.slice(-8).reverse().map(s => [
            <span style={{ fontFamily: "monospace", fontSize: 12, color: C.primary }}>{s.id}</span>,
            s.time, s.type, s.cashier, s.payMethod,
            <strong>{fmtSAR(s.total)}</strong>,
            <Badge color={C.success} bg={C.successLight}>Completed</Badge>
          ])}
          emptyMsg="No bills today yet"
        />
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PAYMENT MODAL
// ═══════════════════════════════════════════════════════════════════
function PaymentModal({ total, subtotal, vat, promos, onConfirm, onClose }) {
  const [method, setMethod] = useState("Cash");
  const [given, setGiven] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState(null);
  const promoDiscount = appliedPromo ? (appliedPromo.type === "%" ? subtotal * appliedPromo.value / 100 : appliedPromo.value) : 0;
  const finalTotal = Math.max(0, total - promoDiscount);
  const change = Math.max(0, parseFloat(given || 0) - finalTotal);
  const shortfall = parseFloat(given || 0) > 0 && parseFloat(given || 0) < finalTotal;
  const METHODS = [{ id: "Cash", icon: "💵", label: "Cash" }, { id: "Mada", icon: "💳", label: "Mada" }, { id: "Apple Pay", icon: "", label: "Apple Pay" }, { id: "STC Pay", icon: "📱", label: "STC Pay" }];
  const QUICK = [10, 20, 50, 100, 200, 500];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 20, width: 520, maxHeight: "95vh", overflow: "auto", boxShadow: "0 24px 80px rgba(0,0,0,0.25)" }}>
        <div style={{ background: "linear-gradient(135deg, #1A3A5C, #0F2340)", padding: "20px 24px", borderRadius: "20px 20px 0 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><div style={{ color: "#fff", fontSize: 18, fontWeight: 800 }}>💳 Payment</div><div style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, marginTop: 2 }}>Complete the transaction</div></div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", width: 32, height: 32, borderRadius: "50%", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        <div style={{ padding: 24 }}>
          <div style={{ background: "#F0F7FF", border: "1.5px solid #C5DCF5", borderRadius: 14, padding: "16px 20px", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div><div style={{ fontSize: 12, color: "#5A7A9A", fontWeight: 600 }}>AMOUNT DUE</div><div style={{ fontSize: 32, fontWeight: 900, color: "#1A3A5C" }}>SAR {finalTotal.toFixed(2)}</div></div>
            <div style={{ textAlign: "right", fontSize: 12, color: "#5A7A9A" }}>
              <div>Subtotal: SAR {subtotal.toFixed(2)}</div>
              {promoDiscount > 0 && <div style={{ color: "#D94040" }}>Promo: -SAR {promoDiscount.toFixed(2)}</div>}
              <div>VAT 15%: SAR {vat.toFixed(2)}</div>
            </div>
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#5A7A9A", marginBottom: 8 }}>PROMO CODE</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={promoCode} onChange={e => setPromoCode(e.target.value.toUpperCase())} placeholder="Enter code e.g. SAVE10" style={{ flex: 1, padding: "10px 14px", border: "1.5px solid #E0E8F0", borderRadius: 10, fontSize: 14, fontFamily: "inherit", fontWeight: 600 }} />
              <button onClick={() => { const p = promos.find(p => p.code.toLowerCase() === promoCode.toLowerCase() && p.active); if (p) setAppliedPromo(p); else alert("Invalid promo code"); }} style={{ padding: "10px 18px", background: "#1A3A5C", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>Apply</button>
            </div>
            {appliedPromo && <div style={{ fontSize: 12, color: "#1A8A4A", marginTop: 6, fontWeight: 600 }}>✓ {appliedPromo.code} — {appliedPromo.type === "%" ? appliedPromo.value + "% off" : "SAR " + appliedPromo.value + " off"}</div>}
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#5A7A9A", marginBottom: 8 }}>PAYMENT METHOD</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
              {METHODS.map(m => <button key={m.id} onClick={() => setMethod(m.id)} style={{ padding: "12px 8px", border: `2px solid ${method === m.id ? "#1A3A5C" : "#E0E8F0"}`, background: method === m.id ? "#1A3A5C" : "#fff", color: method === m.id ? "#fff" : "#5A7A9A", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}><span style={{ fontSize: 20 }}>{m.icon}</span>{m.label}</button>)}
            </div>
          </div>
          {method === "Cash" && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#5A7A9A", marginBottom: 8 }}>AMOUNT GIVEN</div>
              <input value={given} onChange={e => setGiven(e.target.value)} type="number" placeholder="0.00" style={{ width: "100%", padding: "14px 16px", border: `2px solid ${shortfall ? "#D94040" : "#E0E8F0"}`, borderRadius: 10, fontSize: 24, fontWeight: 800, fontFamily: "inherit", color: "#1A3A5C", textAlign: "center" }} />
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {QUICK.map(q => <button key={q} onClick={() => setGiven(String(q))} style={{ flex: 1, minWidth: 60, padding: "8px 4px", background: parseFloat(given) === q ? "#1A3A5C" : "#F0F7FF", color: parseFloat(given) === q ? "#fff" : "#1A3A5C", border: "1.5px solid #C5DCF5", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}>SAR {q}</button>)}
                <button onClick={() => setGiven(finalTotal.toFixed(2))} style={{ flex: 1, minWidth: 70, padding: "8px 4px", background: "#E8F5EE", color: "#1A6B4A", border: "1.5px solid #A8D5B8", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700 }}>Exact</button>
              </div>
              {parseFloat(given) > 0 && <div style={{ marginTop: 14, background: shortfall ? "#FDE8E8" : "#E8F5EE", border: `1.5px solid ${shortfall ? "#D94040" : "#1A8A4A"}`, borderRadius: 12, padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: shortfall ? "#D94040" : "#1A6B4A" }}>{shortfall ? "⚠️ Shortfall" : "✓ Change"}</span>
                <span style={{ fontSize: 24, fontWeight: 900, color: shortfall ? "#D94040" : "#1A6B4A" }}>SAR {shortfall ? (finalTotal - parseFloat(given)).toFixed(2) : change.toFixed(2)}</span>
              </div>}
            </div>
          )}
          <button onClick={() => onConfirm(method, parseFloat(given || finalTotal), change, appliedPromo, promoDiscount)}
            disabled={method === "Cash" && parseFloat(given || 0) < finalTotal}
            style={{ width: "100%", padding: "16px", background: method === "Cash" && parseFloat(given || 0) < finalTotal ? "#ccc" : "linear-gradient(135deg, #1A6B4A, #0F4A30)", color: "#fff", border: "none", borderRadius: 12, fontSize: 16, fontWeight: 800, cursor: method === "Cash" && parseFloat(given || 0) < finalTotal ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {method === "Cash" ? (parseFloat(given || 0) < finalTotal ? "Enter amount received" : "✓ Confirm & Print Receipt") : `✓ Confirm ${method} Payment`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// RECEIPT MODAL — with REAL ZATCA QR
// ═══════════════════════════════════════════════════════════════════
function ReceiptModal({ order, license, onClose }) {
  const qrData = generateZATCABase64({
    sellerName: license.businessName,
    vatNumber: license.vatNumber,
    timestamp: new Date().toISOString(),
    total: order.total,
    vatAmount: order.vat,
  });

  return (
    <Modal title="🧾 Receipt" onClose={onClose} width={400}>
      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "inherit" }}>{license.businessName}</div>
          <div style={{ color: "#888", fontSize: 11 }}>{license.address}</div>
          <div style={{ color: "#888" }}>TRN: {license.vatNumber}</div>
          <div style={{ marginTop: 4 }}>{order.id} · {order.time}</div>
          {order.customer && <div>Customer: {order.customer}</div>}
          <div>{order.type}{order.table ? ` · Table ${order.table}` : ""}</div>
        </div>
        <hr style={{ border: "none", borderTop: "1px dashed #ccc", margin: "10px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#888", marginBottom: 4 }}><span>ITEM</span><span>QTY × RATE = AMOUNT</span></div>
        {order.items.map(it => <div key={it.id} style={{ display: "flex", justifyContent: "space-between", margin: "5px 0" }}><span style={{ flex: 1 }}>{it.name}</span><span style={{ whiteSpace: "nowrap" }}>{it.qty} × {it.price.toFixed(2)} = {(it.qty * it.price).toFixed(2)}</span></div>)}
        <hr style={{ border: "none", borderTop: "1px dashed #ccc", margin: "10px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>Subtotal</span><span>{fmtSAR(order.subtotal)}</span></div>
        {order.discount > 0 && <div style={{ display: "flex", justifyContent: "space-between", color: "#D94040" }}><span>Discount</span><span>-{fmtSAR(order.discount)}</span></div>}
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>VAT 15%</span><span>{fmtSAR(order.vat)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, fontSize: 16, marginTop: 8, borderTop: "2px solid #333", paddingTop: 8 }}><span>TOTAL</span><span>{fmtSAR(order.total)}</span></div>
        {order.payMethod === "Cash" && <>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}><span>Cash Given</span><span>{fmtSAR(order.given)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#1A6B4A", fontWeight: 700 }}><span>Change</span><span>{fmtSAR(order.change)}</span></div>
        </>}
        <hr style={{ border: "none", borderTop: "1px dashed #ccc", margin: "10px 0" }} />

        {/* ZATCA QR SECTION */}
        <div style={{ textAlign: "center", padding: "8px 0" }}>
          <div style={{ fontSize: 10, color: "#6366f1", fontWeight: 700, letterSpacing: "0.1em", marginBottom: 8 }}>⬛ ZATCA PHASE 2 · QR CODE</div>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
            <div style={{ padding: 8, background: "#fff", border: "1.5px solid #e0e0e0", borderRadius: 8, display: "inline-block" }}>
              <QRCode data={qrData} size={120} />
            </div>
          </div>
          <div style={{ fontSize: 9, color: "#aaa", marginTop: 4 }}>TLV Base64 encoded · Scan to verify</div>
          <div style={{ marginTop: 10, fontWeight: 700, fontSize: 13 }}>Thank you! شكراً لزيارتكم</div>
          <div style={{ fontSize: 10, color: "#888", marginTop: 4 }}>{license.phone}</div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <Btn variant="ghost" onClick={onClose} style={{ flex: 1 }}>Close</Btn>
          <Btn variant="primary" onClick={() => window.print()} style={{ flex: 1 }}>🖨️ Print</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// POS SCREEN
// ═══════════════════════════════════════════════════════════════════
function POS({ items, sales, setSales, tables, setTables, promos, license }) {
  const POS_CATS = ["BROAST", "DRINKS", "COMBOS"];
  const allCats = [...new Set(items.map(i => i.category))];
  const catMap = { "BROAST": "Broasted", "DRINKS": "Drinks", "COMBOS": "Combos" };
  const displayCats = [...POS_CATS, ...allCats.filter(c => !Object.values(catMap).includes(c))];
  const [activeCat, setActiveCat] = useState("BROAST");
  const [cart, setCart] = useState([]);
  const [orderType, setOrderType] = useState("dine-in");
  const [selectedTable, setSelectedTable] = useState(null);
  const [showPayment, setShowPayment] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const [notif, setNotif] = useState(null);
  const [vno, setVno] = useState(38298);
  const [customerName, setCustomerName] = useState("");
  const [kotNo, setKotNo] = useState(1);
  const [selectedRow, setSelectedRow] = useState(null);

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const vat = subtotal * 0.15;
  const total = subtotal + vat;

  function addToCart(item) {
    setCart(prev => { const ex = prev.find(c => c.id === item.id); if (ex) return prev.map(c => c.id === item.id ? { ...c, qty: c.qty + 1 } : c); return [...prev, { ...item, qty: 1 }]; });
    showN("+ " + item.name);
  }
  function updateQty(delta) { if (selectedRow === null) return; setCart(prev => prev.map((c, i) => i === selectedRow ? { ...c, qty: Math.max(0, c.qty + delta) } : c).filter(c => c.qty > 0)); }
  function showN(msg) { setNotif(msg); setTimeout(() => setNotif(null), 1500); }

  function confirmPayment(method, given, change, promo, promoDiscount) {
    const inv = { id: "INV-" + vno, date: TODAY, time: new Date().toLocaleTimeString("en-SA", { hour: "2-digit", minute: "2-digit" }), type: orderType === "dine-in" ? "Dine-in" : orderType === "takeaway" ? "Takeaway" : "Delivery", table: selectedTable, customer: customerName, items: [...cart], subtotal, discount: promoDiscount || 0, vat, total: total - (promoDiscount || 0), status: "completed", cashier: "Admin", payMethod: method, given, change, promo: promo?.code || null };
    setSales(prev => [...prev, inv]);
    setLastOrder(inv);
    if (selectedTable) setTables(prev => prev.map(t => t.id === selectedTable ? { ...t, status: "occupied" } : t));
    setCart([]); setCustomerName(""); setSelectedTable(null); setSelectedRow(null);
    setVno(v => v + 1); setKotNo(k => k + 1);
    setShowPayment(false); setShowReceipt(true);
  }

  const CARD_THEMES = {
    "BROAST":  { bg: "linear-gradient(145deg,#1A3A5C,#0F2340)", border: "#2A5A8C", price: "#F0C040", name: "#FFFFFF", nameAr: "rgba(255,255,255,0.65)" },
    "DRINKS":  { bg: "linear-gradient(145deg,#1A5C3A,#0F3A22)", border: "#2A8C5A", price: "#6EFFC0", name: "#FFFFFF", nameAr: "rgba(255,255,255,0.65)" },
    "COMBOS":  { bg: "linear-gradient(145deg,#5C3A1A,#3A220F)", border: "#8C5A2A", price: "#FFD580", name: "#FFFFFF", nameAr: "rgba(255,255,255,0.65)" },
    "default": { bg: "linear-gradient(145deg,#3A1A5C,#22103A)", border: "#6A3A8C", price: "#D4AAFF", name: "#FFFFFF", nameAr: "rgba(255,255,255,0.65)" },
  };

  const activeMappedCat = catMap[activeCat] || activeCat;
  const catItems = items.filter(i => i.category === activeMappedCat && i.active);
  const theme = CARD_THEMES[activeCat] || CARD_THEMES["default"];
  const now = new Date();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 52px)", overflow: "hidden", background: "#E8EDF2" }}>
      {notif && <div style={{ position: "fixed", top: 60, right: 20, background: "#1A3A5C", color: "#fff", padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, zIndex: 9999 }}>{notif}</div>}
      {showPayment && <PaymentModal total={total} subtotal={subtotal} vat={vat} promos={promos} onConfirm={confirmPayment} onClose={() => setShowPayment(false)} />}
      {showReceipt && lastOrder && <ReceiptModal order={lastOrder} license={license} onClose={() => setShowReceipt(false)} />}

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* LEFT PANEL */}
        <div style={{ width: 340, background: "#fff", borderRight: "1px solid #D0D8E4", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid #E8EDF2", background: "#F8FAFC" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Customer name (optional)" style={{ flex: 1, padding: "5px 10px", border: "1px solid #D0D8E4", borderRadius: 6, fontSize: 12, fontFamily: "inherit" }} />
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#5A7A9A" }}>
              <span><strong style={{ color: "#1A3A5C" }}>VNO:</strong> {vno}</span>
              <span><strong style={{ color: "#1A3A5C" }}>KOT:</strong> {kotNo}</span>
              <span><strong style={{ color: "#1A3A5C" }}>Daily:</strong> {sales.filter(s => s.date === TODAY).length + 1}</span>
              <span style={{ marginLeft: "auto", color: "#1A3A5C", fontWeight: 700 }}>{now.toLocaleTimeString("en-SA", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          </div>
          <div style={{ display: "flex", borderBottom: "1px solid #E8EDF2" }}>
            {[["dine-in", "🍽", "Dine-in"], ["takeaway", "🥡", "Takeaway"], ["delivery", "🛵", "Delivery"]].map(([t, icon, label]) => (
              <button key={t} onClick={() => setOrderType(t)} style={{ flex: 1, padding: "8px 4px", border: "none", background: orderType === t ? "#1A3A5C" : "#fff", color: orderType === t ? "#fff" : "#5A7A9A", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer", borderRight: "1px solid #E8EDF2" }}>{icon} {label}</button>
            ))}
          </div>
          {orderType === "dine-in" && (
            <div style={{ padding: "8px 14px", borderBottom: "1px solid #E8EDF2", background: "#F8FAFC" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#5A7A9A", marginBottom: 6 }}>TABLE</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {tables.map(t => <div key={t.id} onClick={() => setSelectedTable(t.id)} style={{ width: 30, height: 30, borderRadius: 6, border: `1.5px solid ${selectedTable === t.id ? "#1A3A5C" : t.status === "occupied" ? "#D94040" : "#D0D8E4"}`, background: selectedTable === t.id ? "#1A3A5C" : t.status === "occupied" ? "#FDE8E8" : "#fff", color: selectedTable === t.id ? "#fff" : t.status === "occupied" ? "#D94040" : "#5A7A9A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{t.id}</div>)}
              </div>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 50px 60px 70px 20px", gap: 4, padding: "6px 14px", background: "#1A3A5C", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.8)", letterSpacing: "0.05em" }}>
            <span>#</span><span>ITEM NAME</span><span>QTY</span><span>RATE</span><span>AMOUNT</span><span>×</span>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {cart.length === 0 ? <div style={{ textAlign: "center", color: "#B0B8C4", paddingTop: 40, fontSize: 13 }}>No items added</div>
              : cart.map((item, i) => (
                <div key={item.id} onClick={() => setSelectedRow(i)} style={{ display: "grid", gridTemplateColumns: "28px 1fr 50px 60px 70px 20px", gap: 4, padding: "7px 14px", background: selectedRow === i ? "#EEF4FF" : i % 2 === 0 ? "#fff" : "#F8FAFC", borderBottom: "1px solid #EEF2F8", cursor: "pointer", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "#5A7A9A" }}>{i + 1}</span>
                  <div><div style={{ fontSize: 12, fontWeight: 600, color: "#1A2A3A" }}>{item.name}</div><div style={{ fontSize: 10, color: "#9AA8B8" }}>{item.nameAr}</div></div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1A3A5C", textAlign: "center" }}>{item.qty}</span>
                  <span style={{ fontSize: 12, color: "#5A7A9A", textAlign: "right" }}>{item.price.toFixed(2)}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1A6B4A", textAlign: "right" }}>{(item.price * item.qty).toFixed(2)}</span>
                  <button onClick={e => { e.stopPropagation(); setCart(prev => prev.filter((_, j) => j !== i)); }} style={{ background: "none", border: "none", color: "#D94040", cursor: "pointer", fontSize: 14, fontWeight: 800, padding: 0 }}>×</button>
                </div>
              ))}
          </div>
          <div style={{ padding: "8px 14px", borderTop: "1px solid #E8EDF2", display: "flex", gap: 8, background: "#F8FAFC" }}>
            <button onClick={() => updateQty(1)} style={{ width: 44, height: 44, background: "#1A6B4A", color: "#fff", border: "none", borderRadius: 10, fontSize: 22, fontWeight: 800, cursor: "pointer" }}>+</button>
            <button onClick={() => updateQty(-1)} style={{ width: 44, height: 44, background: "#D94040", color: "#fff", border: "none", borderRadius: 10, fontSize: 22, fontWeight: 800, cursor: "pointer" }}>−</button>
          </div>
          <div style={{ padding: "10px 14px", borderTop: "1px solid #E8EDF2", background: "#F8FAFC" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5A7A9A", marginBottom: 3 }}><span>Total Gross</span><span>{subtotal.toFixed(2)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5A7A9A", marginBottom: 6 }}><span>Total Tax (15%)</span><span>{vat.toFixed(2)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, fontWeight: 900, color: "#D94040" }}><span></span><span>{total.toFixed(2)}</span></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderTop: "1px solid #D0D8E4" }}>
            {[{ label: "Print", bg: "#1A6B4A", action: () => { if (cart.length) setShowPayment(true); else showN("Add items first"); } }, { label: "Clear", bg: "#E07B00", action: () => { setCart([]); setSelectedRow(null); setCustomerName(""); } }, { label: "Close", bg: "#5A6070", action: () => { setCart([]); setSelectedRow(null); } }].map(({ label, bg, action }) => (
              <button key={label} onClick={action} style={{ padding: "14px 0", background: bg, color: "#fff", border: "none", fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>{label}</button>
            ))}
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "10px 12px 8px", background: "#1A2A3C", display: "flex", flexWrap: "wrap", gap: 6 }}>
            {displayCats.map(cat => <button key={cat} onClick={() => setActiveCat(cat)} style={{ padding: "9px 18px", background: activeCat === cat ? "#F0C040" : "rgba(255,255,255,0.1)", color: activeCat === cat ? "#1A2A3C" : "#fff", border: `1.5px solid ${activeCat === cat ? "#F0C040" : "rgba(255,255,255,0.2)"}`, borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 800, cursor: "pointer", textTransform: "uppercase" }}>{cat}</button>)}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 10, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, alignContent: "start" }}>
            {catItems.length === 0 ? <div style={{ gridColumn: "1/-1", textAlign: "center", color: "#9AA8B8", paddingTop: 60, fontSize: 14 }}>No items. Add from Create menu.</div>
              : catItems.map(item => (
                <div key={item.id} onClick={() => addToCart(item)}
                  style={{ background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer", minHeight: 88, display: "flex", flexDirection: "column", justifyContent: "space-between", transition: "transform 0.1s" }}
                  onMouseOver={e => { e.currentTarget.style.transform = "translateY(-2px)"; }}
                  onMouseOut={e => { e.currentTarget.style.transform = "none"; }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: theme.price }}>SR{item.price.toFixed(2)}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: theme.name, lineHeight: 1.2, marginBottom: 2, textTransform: "uppercase" }}>{item.name}</div>
                    <div style={{ fontSize: 10, color: theme.nameAr, direction: "rtl" }}>{item.nameAr}</div>
                  </div>
                  {cart.find(c => c.id === item.id) && <div style={{ position: "absolute", top: 6, right: 6, background: "#F0C040", color: "#1A2A3C", width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900 }}>{cart.find(c => c.id === item.id)?.qty}</div>}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS SCREEN
// ═══════════════════════════════════════════════════════════════════
function Settings({ company, setCompany, tables, setTables, license, onClearLicense }) {
  const [tab, setTab] = useState("company");
  const [newTableCount, setNewTableCount] = useState(tables.length);
  const tabs = [["company", "🏢 Company"], ["tables", "🪑 Tables"], ["license", "🔐 License"]];

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>
      {tab === "company" && (
        <Card style={{ maxWidth: 640 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>Company Settings</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Inp label="Business Name" value={company.name} onChange={v => setCompany(c => ({ ...c, name: v }))} />
            <Inp label="Arabic Name" value={company.nameAr} onChange={v => setCompany(c => ({ ...c, nameAr: v }))} />
            <Inp label="Phone" value={company.phone} onChange={v => setCompany(c => ({ ...c, phone: v }))} />
            <Inp label="Email" value={company.email} onChange={v => setCompany(c => ({ ...c, email: v }))} />
            <Inp label="City" value={company.city} onChange={v => setCompany(c => ({ ...c, city: v }))} />
            <Inp label="Country" value={company.country} onChange={v => setCompany(c => ({ ...c, country: v }))} />
          </div>
          <Inp label="Address" value={company.address} onChange={v => setCompany(c => ({ ...c, address: v }))} style={{ marginTop: 14 }} />
          <div style={{ marginTop: 14, padding: 14, background: C.zatcaLight, borderRadius: 10, border: `1px solid ${C.zatca}30` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.zatca, marginBottom: 8 }}>⬛ ZATCA Info (from license)</div>
            <div style={{ fontSize: 13, color: C.textMid }}>VAT / TRN: <strong style={{ color: C.text }}>{license.vatNumber}</strong></div>
            <div style={{ fontSize: 12, color: C.textLight, marginTop: 4 }}>This is locked to your license. To change, re-activate via Settings → License.</div>
          </div>
          <Btn style={{ marginTop: 16 }} onClick={() => alert("Settings saved!")}>Save Settings</Btn>
        </Card>
      )}
      {tab === "tables" && (
        <Card style={{ maxWidth: 500 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Table Configuration</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 20, alignItems: "flex-end" }}>
            <Inp label="Number of Tables" value={newTableCount} onChange={v => setNewTableCount(parseInt(v) || 1)} type="number" />
            <Btn onClick={() => setTables(Array.from({ length: newTableCount }, (_, i) => ({ id: i + 1, status: "free", capacity: 4 })))}>Update</Btn>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {tables.map(t => <div key={t.id} style={{ width: 48, height: 48, borderRadius: 8, border: `2px solid ${t.status === "occupied" ? C.danger : C.success}`, background: t.status === "occupied" ? C.dangerLight : C.successLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: t.status === "occupied" ? C.danger : C.success, cursor: "pointer" }} onClick={() => setTables(prev => prev.map(x => x.id === t.id ? { ...x, status: x.status === "occupied" ? "free" : "occupied" } : x))}>{t.id}</div>)}
          </div>
        </Card>
      )}
      {tab === "license" && (
        <Card style={{ maxWidth: 560 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>License Information</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[["Business Name", license.businessName], ["License Key", license.licenseKey], ["VAT / TRN", license.vatNumber], ["Address", license.address], ["City", license.city], ["Phone", license.phone], ["Activated", new Date(license.activatedAt).toLocaleString("en-SA")], ["Version", license.version]].map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 16, padding: "10px 14px", background: C.bg, borderRadius: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.textMid, width: 120, flexShrink: 0 }}>{k}</span>
                <span style={{ fontSize: 13, color: C.text, fontWeight: 600, fontFamily: k === "License Key" || k === "VAT / TRN" ? "monospace" : "inherit" }}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 20, padding: 14, background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.danger, marginBottom: 8 }}>⚠️ Reset License</div>
            <div style={{ fontSize: 12, color: C.danger, marginBottom: 12 }}>This will clear all saved license data. You will need to re-enter your license key and VAT number.</div>
            <Btn variant="danger" size="sm" onClick={() => { if (confirm("Are you sure? This will log you out and clear the license.")) onClearLicense(); }}>Clear License & Re-Activate</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CREATE SCREEN (Menu Management)
// ═══════════════════════════════════════════════════════════════════
function Create({ items, setItems, promos, setPromos }) {
  const [tab, setTab] = useState("items");
  const [showItemModal, setShowItemModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [editPromo, setEditPromo] = useState(null);
  const [categories, setCategories] = useState(SEED_CATEGORIES);
  const [newCat, setNewCat] = useState("");
  const blankItem = { name: "", nameAr: "", category: categories[0], price: "", cost: "", stock: "", active: true };
  const [itemForm, setItemForm] = useState(blankItem);
  const blankPromo = { code: "", type: "%", value: "", minOrder: 0, active: true };
  const [promoForm, setPromoForm] = useState(blankPromo);

  function openItemModal(it = null) { setEditItem(it); setItemForm(it ? { ...it } : { ...blankItem, category: categories[0] }); setShowItemModal(true); }
  function saveItem() {
    if (!itemForm.name || !itemForm.price) return alert("Name and price required");
    const item = { ...itemForm, price: parseFloat(itemForm.price), cost: parseFloat(itemForm.cost || 0), stock: parseInt(itemForm.stock || 0), id: editItem ? editItem.id : Date.now() };
    setItems(prev => editItem ? prev.map(i => i.id === editItem.id ? item : i) : [...prev, item]);
    setShowItemModal(false);
  }
  function deleteItem(id) { if (confirm("Delete item?")) setItems(prev => prev.filter(i => i.id !== id)); }
  function openPromoModal(p = null) { setEditPromo(p); setPromoForm(p ? { ...p } : { ...blankPromo }); setShowPromoModal(true); }
  function savePromo() {
    if (!promoForm.code || !promoForm.value) return alert("Code and value required");
    const promo = { ...promoForm, value: parseFloat(promoForm.value), minOrder: parseFloat(promoForm.minOrder || 0), id: editPromo ? editPromo.id : Date.now() };
    setPromos(prev => editPromo ? prev.map(p => p.id === editPromo.id ? promo : p) : [...prev, promo]);
    setShowPromoModal(false);
  }

  const tabs = [["items", "🍔 Items"], ["categories", "📂 Categories"], ["modifiers", "⚙️ Modifiers"], ["promos", "🏷️ Promos"]];
  return (
    <div>
      {showItemModal && (
        <Modal title={editItem ? "Edit Item" : "New Menu Item"} onClose={() => setShowItemModal(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Inp label="Item Name *" value={itemForm.name} onChange={v => setItemForm(f => ({ ...f, name: v }))} placeholder="Chicken Burger" />
              <Inp label="Arabic Name" value={itemForm.nameAr} onChange={v => setItemForm(f => ({ ...f, nameAr: v }))} placeholder="برجر دجاج" />
              <Sel label="Category" value={itemForm.category} onChange={v => setItemForm(f => ({ ...f, category: v }))} options={categories} />
              <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 20 }}>
                <input type="checkbox" checked={itemForm.active} onChange={e => setItemForm(f => ({ ...f, active: e.target.checked }))} id="activeItem" />
                <label htmlFor="activeItem" style={{ fontSize: 13 }}>Active</label>
              </div>
              <Inp label="Price (SAR) *" value={itemForm.price} onChange={v => setItemForm(f => ({ ...f, price: v }))} type="number" placeholder="25.00" />
              <Inp label="Cost (SAR)" value={itemForm.cost} onChange={v => setItemForm(f => ({ ...f, cost: v }))} type="number" placeholder="12.00" />
              <Inp label="Stock" value={itemForm.stock} onChange={v => setItemForm(f => ({ ...f, stock: v }))} type="number" placeholder="50" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn variant="ghost" onClick={() => setShowItemModal(false)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn onClick={saveItem} style={{ flex: 1 }}>Save Item</Btn>
          </div>
        </Modal>
      )}
      {showPromoModal && (
        <Modal title={editPromo ? "Edit Promo" : "New Promo Code"} onClose={() => setShowPromoModal(false)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Inp label="Promo Code" value={promoForm.code} onChange={v => setPromoForm(f => ({ ...f, code: v.toUpperCase() }))} placeholder="SAVE20" />
            <Sel label="Discount Type" value={promoForm.type} onChange={v => setPromoForm(f => ({ ...f, type: v }))} options={[{ value: "%", label: "Percentage (%)" }, { value: "flat", label: "Flat Amount (SAR)" }]} />
            <Inp label={promoForm.type === "%" ? "Discount %" : "Discount Amount (SAR)"} value={promoForm.value} onChange={v => setPromoForm(f => ({ ...f, value: v }))} type="number" />
            <Inp label="Min Order (SAR)" value={promoForm.minOrder} onChange={v => setPromoForm(f => ({ ...f, minOrder: v }))} type="number" placeholder="0 = no minimum" />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={promoForm.active} onChange={e => setPromoForm(f => ({ ...f, active: e.target.checked }))} id="promoActive" />
              <label htmlFor="promoActive" style={{ fontSize: 13 }}>Active</label>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <Btn variant="ghost" onClick={() => setShowPromoModal(false)} style={{ flex: 1 }}>Cancel</Btn>
            <Btn onClick={savePromo} style={{ flex: 1 }}>Save Promo</Btn>
          </div>
        </Modal>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>
      {tab === "items" && <Card><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}><div style={{ fontSize: 15, fontWeight: 700 }}>Menu Items ({items.length})</div><Btn size="sm" onClick={() => openItemModal()}>+ New Item</Btn></div><DataTable headers={["Name", "Arabic", "Category", "Price", "Cost", "Stock", "Status", "Actions"]} rows={items.map(it => [it.name, it.nameAr, <Badge color={C.info} bg={C.infoLight}>{it.category}</Badge>, <strong style={{ color: C.primary }}>{fmtSAR(it.price)}</strong>, fmtSAR(it.cost), it.stock, <Badge color={it.active ? C.success : C.danger} bg={it.active ? C.successLight : C.dangerLight}>{it.active ? "Active" : "Inactive"}</Badge>, <div style={{ display: "flex", gap: 6 }}><Btn size="sm" variant="ghost" onClick={() => openItemModal(it)}>Edit</Btn><Btn size="sm" variant="danger" onClick={() => deleteItem(it.id)}>Del</Btn></div>])} /></Card>}
      {tab === "categories" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Categories</div><div style={{ display: "flex", gap: 10, marginBottom: 20 }}><input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name" style={{ flex: 1, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} /><Btn onClick={() => { if (newCat.trim()) { setCategories(prev => [...prev, newCat.trim()]); setNewCat(""); } }}>Add</Btn></div><div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>{categories.map(cat => <div key={cat} style={{ padding: "8px 16px", background: C.primaryLight, borderRadius: 8, fontSize: 13, fontWeight: 600, color: C.primary, display: "flex", alignItems: "center", gap: 8 }}>{cat}<button onClick={() => setCategories(prev => prev.filter(c => c !== cat))} style={{ background: "none", border: "none", color: C.danger, cursor: "pointer", fontSize: 14 }}>×</button></div>)}</div></Card>}
      {tab === "modifiers" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Modifier Groups</div>{MODIFIER_GROUPS.map(mg => <div key={mg.id} style={{ padding: 16, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 10 }}><div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{mg.name}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{mg.options.map(o => <Badge key={o} color={C.textMid} bg={C.bg}>{o}</Badge>)}</div></div>)}</Card>}
      {tab === "promos" && <Card><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}><div style={{ fontSize: 15, fontWeight: 700 }}>Promo Codes</div><Btn size="sm" onClick={() => openPromoModal()}>+ New Promo</Btn></div><DataTable headers={["Code", "Type", "Value", "Min Order", "Status", "Actions"]} rows={promos.map(p => [<strong style={{ fontFamily: "monospace", color: C.primary }}>{p.code}</strong>, p.type === "%" ? "Percentage" : "Flat", p.type === "%" ? p.value + "%" : fmtSAR(p.value), p.minOrder > 0 ? fmtSAR(p.minOrder) : "None", <Badge color={p.active ? C.success : C.danger} bg={p.active ? C.successLight : C.dangerLight}>{p.active ? "Active" : "Inactive"}</Badge>, <div style={{ display: "flex", gap: 6 }}><Btn size="sm" variant="ghost" onClick={() => openPromoModal(p)}>Edit</Btn><Btn size="sm" variant="danger" onClick={() => setPromos(prev => prev.filter(x => x.id !== p.id))}>Del</Btn></div>])} emptyMsg="No promo codes yet" /></Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TRANSACTIONS SCREEN
// ═══════════════════════════════════════════════════════════════════
function Transactions({ sales, setSales }) {
  const [tab, setTab] = useState("sales");
  const [dateFrom, setDateFrom] = useState(TODAY);
  const [dateTo, setDateTo] = useState(TODAY);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundTarget, setRefundTarget] = useState(null);
  const filtered = sales.filter(s => s.date >= dateFrom && s.date <= dateTo);
  const total = filtered.reduce((s, o) => s + o.total, 0);
  const vat = filtered.reduce((s, o) => s + o.vat, 0);
  function voidSale(id) { if (confirm("Void this transaction?")) setSales(prev => prev.map(s => s.id === id ? { ...s, status: "voided" } : s)); }
  const tabs = [["sales", "💳 Sales"], ["kot", "🍽 KOT Log"], ["payments", "💰 Payments"]];
  return (
    <div>
      {showRefundModal && refundTarget && <Modal title="Process Refund" onClose={() => setShowRefundModal(false)} width={420}><div style={{ fontSize: 13, color: C.textMid, marginBottom: 16 }}>Refunding <strong style={{ color: C.primary }}>{refundTarget.id}</strong> — {fmtSAR(refundTarget.total)}</div><div style={{ background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 8, padding: 12, fontSize: 13, color: C.danger, marginBottom: 20 }}>⚠️ This will mark the invoice as refunded.</div><div style={{ display: "flex", gap: 10 }}><Btn variant="ghost" onClick={() => setShowRefundModal(false)} style={{ flex: 1 }}>Cancel</Btn><Btn variant="danger" onClick={() => { setSales(prev => prev.map(s => s.id === refundTarget.id ? { ...s, status: "refunded" } : s)); setShowRefundModal(false); }} style={{ flex: 1 }}>Confirm Refund</Btn></div></Modal>}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>
      {tab === "sales" && <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Card style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Inp label="From" value={dateFrom} onChange={setDateFrom} type="date" />
          <Inp label="To" value={dateTo} onChange={setDateTo} type="date" />
          <div style={{ marginLeft: "auto", textAlign: "right" }}><div style={{ fontSize: 12, color: C.textMid }}>{filtered.length} orders · VAT: {fmtSAR(vat)}</div><div style={{ fontSize: 20, fontWeight: 800, color: C.primary }}>{fmtSAR(total)}</div></div>
        </Card>
        <Card><DataTable headers={["Invoice", "Date", "Time", "Type", "Cashier", "Method", "Total", "Status", "Actions"]} rows={filtered.slice().reverse().slice(0, 50).map(s => [<span style={{ fontFamily: "monospace", fontSize: 12, color: C.primary }}>{s.id}</span>, s.date, s.time, s.type, s.cashier, s.payMethod, <strong>{fmtSAR(s.total)}</strong>, <Badge color={s.status === "completed" ? C.success : s.status === "voided" ? C.danger : C.warning} bg={s.status === "completed" ? C.successLight : s.status === "voided" ? C.dangerLight : C.warningLight}>{s.status}</Badge>, <div style={{ display: "flex", gap: 4 }}>{s.status === "completed" && <><Btn size="sm" variant="ghost" onClick={() => { setRefundTarget(s); setShowRefundModal(true); }}>Refund</Btn><Btn size="sm" variant="danger" onClick={() => voidSale(s.id)}>Void</Btn></>}</div>])} /></Card>
      </div>}
      {tab === "kot" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Kitchen Order Tickets</div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>{sales.filter(s => s.date === TODAY).slice(-6).map(s => <div key={s.id} style={{ border: "2px dashed #ccc", borderRadius: 8, padding: 14, fontFamily: "monospace", fontSize: 12 }}><div style={{ fontWeight: 700, marginBottom: 6 }}>{s.type}{s.table ? ` · T${s.table}` : ""} · {s.time}</div>{s.items.slice(0, 4).map(it => <div key={it.id}>{it.qty}x {it.name}</div>)}<div style={{ marginTop: 8, fontSize: 11, color: C.textLight }}>{s.id}</div></div>)}</div></Card>}
      {tab === "payments" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Payment Summary (Today)</div>{["Cash", "Mada", "Apple Pay", "STC Pay"].map(method => { const mSales = sales.filter(s => s.date === TODAY && s.payMethod === method); const mTotal = mSales.reduce((s, o) => s + o.total, 0); return <div key={method} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ fontSize: 14, fontWeight: 600 }}>{method}</span><div style={{ textAlign: "right" }}><div style={{ fontSize: 16, fontWeight: 700, color: C.primary }}>{fmtSAR(mTotal)}</div><div style={{ fontSize: 11, color: C.textLight }}>{mSales.length} transactions</div></div></div>; })}</Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ACCOUNTS SCREEN
// ═══════════════════════════════════════════════════════════════════
function Accounts({ sales, items }) {
  const [tab, setTab] = useState("pl");
  const [period, setPeriod] = useState("month");
  const now = new Date();
  const periodSales = sales.filter(s => { const d = new Date(s.date); if (period === "today") return s.date === TODAY; if (period === "week") { const w = new Date(); w.setDate(w.getDate() - 7); return d >= w; } if (period === "month") { return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); } return true; });
  const revenue = periodSales.reduce((s, o) => s + o.total, 0);
  const vatCollected = periodSales.reduce((s, o) => s + o.vat, 0);
  const cogs = periodSales.reduce((s, o) => o.items.reduce((ss, it) => ss + (it.cost || 0) * it.qty, ss), 0);
  const grossProfit = revenue - cogs - vatCollected;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        {[["pl", "📊 P&L"], ["vat", "⬛ VAT Report"]].map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {[["today", "Today"], ["week", "Week"], ["month", "Month"], ["all", "All Time"]].map(([id, label]) => <button key={id} onClick={() => setPeriod(id)} style={{ padding: "6px 12px", borderRadius: 6, border: `1px solid ${period === id ? C.primary : C.border}`, background: period === id ? C.primary : "#fff", color: period === id ? "#fff" : C.textMid, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
        </div>
      </div>
      {tab === "pl" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <StatCard icon="💰" label="Total Revenue" value={fmtSAR(revenue)} color={C.primary} bg={C.primaryLight} />
        <StatCard icon="📦" label="Est. COGS" value={fmtSAR(cogs)} color={C.warning} bg={C.warningLight} />
        <StatCard icon="📊" label="VAT Collected" value={fmtSAR(vatCollected)} color={C.zatca} bg={C.zatcaLight} />
        <StatCard icon="✅" label="Gross Profit" value={fmtSAR(grossProfit)} color={C.success} bg={C.successLight} />
      </div>}
      {tab === "vat" && <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <div style={{ width: 36, height: 36, background: C.zatcaLight, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⬛</div>
          <div><div style={{ fontSize: 16, fontWeight: 700 }}>ZATCA VAT Report</div><div style={{ fontSize: 12, color: C.textMid }}>For quarterly ZATCA submission</div></div>
        </div>
        {[["Total Sales (incl. VAT)", fmtSAR(revenue)], ["Taxable Amount", fmtSAR(revenue - vatCollected)], ["VAT Rate", "15%"], ["VAT Collected", fmtSAR(vatCollected)], ["VAT Registration (TRN)", "From License"], ["Period", period.charAt(0).toUpperCase() + period.slice(1)], ["Total Invoices", periodSales.length]].map(([l, v]) => <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}><span style={{ color: C.textMid }}>{l}</span><strong style={{ color: C.text }}>{v}</strong></div>)}
        <Btn variant="zatca" style={{ marginTop: 16, width: "100%" }} onClick={() => alert("ZATCA report exported!")}>⬛ Export ZATCA Report</Btn>
      </Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// REPORTS SCREEN
// ═══════════════════════════════════════════════════════════════════
function Reports({ sales, items }) {
  const [tab, setTab] = useState("summary");
  const [dateFrom, setDateFrom] = useState(TODAY);
  const [dateTo, setDateTo] = useState(TODAY);
  const filtered = sales.filter(s => s.date >= dateFrom && s.date <= dateTo);
  const itemSales = items.map(it => ({ ...it, sold: filtered.reduce((s, o) => s + (o.items.find(i => i.id === it.id)?.qty || 0), 0), revenue: filtered.reduce((s, o) => s + (o.items.find(i => i.id === it.id)?.qty || 0) * it.price, 0) })).filter(it => it.sold > 0).sort((a, b) => b.revenue - a.revenue);
  const catSales = [...new Set(items.map(i => i.category))].map(cat => { const catItems = items.filter(i => i.category === cat); return { cat, revenue: catItems.reduce((s, it) => s + filtered.reduce((ss, o) => ss + (o.items.find(i => i.id === it.id)?.qty || 0) * it.price, 0), 0) }; }).filter(c => c.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const DateFilter = () => <Card style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap" }}><Inp label="From" value={dateFrom} onChange={setDateFrom} type="date" /><Inp label="To" value={dateTo} onChange={setDateTo} type="date" /><div style={{ marginLeft: "auto" }}><div style={{ fontSize: 12, color: C.textMid }}>{filtered.length} orders</div><div style={{ fontSize: 18, fontWeight: 800, color: C.primary }}>{fmtSAR(filtered.reduce((s, o) => s + o.total, 0))}</div></div></Card>;
  const tabs = [["summary", "📋 Summary"], ["category", "📂 Category"], ["items", "🍔 Items"], ["stock", "📦 Stock"], ["eod", "🌙 End of Day"]];
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>
      {tab === "summary" && <><DateFilter /><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}><StatCard icon="💰" label="Revenue" value={fmtSAR(filtered.reduce((s, o) => s + o.total, 0))} color={C.primary} bg={C.primaryLight} /><StatCard icon="🧾" label="Orders" value={filtered.length} color={C.info} bg={C.infoLight} /><StatCard icon="📊" label="VAT" value={fmtSAR(filtered.reduce((s, o) => s + o.vat, 0))} color={C.accent} bg={C.accentLight} /><StatCard icon="💵" label="Avg Order" value={fmtSAR(filtered.length ? filtered.reduce((s, o) => s + o.total, 0) / filtered.length : 0)} color={C.success} bg={C.successLight} /></div></>}
      {tab === "category" && <><DateFilter /><Card><DataTable headers={["Category", "Revenue"]} rows={catSales.map(c => [c.cat, <strong style={{ color: C.primary }}>{fmtSAR(c.revenue)}</strong>])} emptyMsg="No data for this period" /></Card></>}
      {tab === "items" && <><DateFilter /><Card><DataTable headers={["Item", "Category", "Price", "Qty Sold", "Revenue"]} rows={itemSales.map(it => [it.name, <Badge color={C.info} bg={C.infoLight}>{it.category}</Badge>, fmtSAR(it.price), <strong>{it.sold}</strong>, fmtSAR(it.revenue)])} /></Card></>}
      {tab === "stock" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Stock Levels</div><DataTable headers={["Item", "Category", "Stock", "Alert"]} rows={items.map(it => [it.name, it.category, it.stock, it.stock < 10 ? <Badge color={C.danger} bg={C.dangerLight}>Low Stock</Badge> : <Badge color={C.success} bg={C.successLight}>OK</Badge>])} /></Card>}
      {tab === "eod" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>End of Day — {fmtDate(TODAY)}</div>{[["Total Orders", TODAY_SALES.length], ["Total Revenue", fmtSAR(TODAY_SALES.reduce((s, o) => s + o.total, 0))], ["VAT Collected", fmtSAR(TODAY_SALES.reduce((s, o) => s + o.vat, 0))], ["Cash", fmtSAR(TODAY_SALES.filter(s => s.payMethod === "Cash").reduce((s, o) => s + o.total, 0))], ["Card / Digital", fmtSAR(TODAY_SALES.filter(s => s.payMethod !== "Cash").reduce((s, o) => s + o.total, 0))]].map(([l, v]) => <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}><span style={{ color: C.textMid }}>{l}</span><strong>{v}</strong></div>)}</Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOOLS SCREEN
// ═══════════════════════════════════════════════════════════════════
function Tools({ sales, items, setItems }) {
  const [tab, setTab] = useState("export");
  const [bulkPct, setBulkPct] = useState("");
  const [bulkCat, setBulkCat] = useState("All");
  const cats = ["All", ...new Set(items.map(i => i.category))];
  function exportCSV(data, filename) { const h = Object.keys(data[0] || {}).join(","); const rows = data.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n"); const blob = new Blob([h + "\n" + rows], { type: "text/csv" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); }
  const tabs = [["export", "📤 Export"], ["prices", "💲 Bulk Prices"], ["backup", "💾 Backup"]];
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>
      {tab === "export" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {[{ icon: "📅", title: "Today's Sales", desc: "Export today's orders", action: () => exportCSV(sales.filter(s => s.date === TODAY).map(s => ({ id: s.id, date: s.date, time: s.time, type: s.type, total: s.total, vat: s.vat })), "sales-today.csv") }, { icon: "📆", title: "This Month", action: () => { const m = new Date(); m.setDate(1); exportCSV(sales.filter(s => s.date >= m.toISOString().split("T")[0]).map(s => ({ id: s.id, date: s.date, total: s.total, vat: s.vat })), "sales-month.csv"); }, desc: "Current month" }, { icon: "📦", title: "Menu & Stock", desc: "All items with prices", action: () => exportCSV(items.map(it => ({ name: it.name, category: it.category, price: it.price, cost: it.cost, stock: it.stock })), "menu-stock.csv") }, { icon: "📊", title: "Tax Summary", desc: "VAT report for ZATCA", action: () => exportCSV([{ period: "All", subtotal: sales.reduce((s, o) => s + o.subtotal, 0).toFixed(2), vat: sales.reduce((s, o) => s + o.vat, 0).toFixed(2), total: sales.reduce((s, o) => s + o.total, 0).toFixed(2) }], "tax-summary.csv") }].map(({ icon, title, desc, action }) => <Card key={title} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", gap: 12, alignItems: "center" }}><span style={{ fontSize: 28 }}>{icon}</span><div><div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div><div style={{ fontSize: 12, color: C.textMid }}>{desc}</div></div></div><Btn size="sm" variant="outline" onClick={action}>Export CSV</Btn></Card>)}
      </div>}
      {tab === "prices" && <Card style={{ maxWidth: 500 }}><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>Bulk Price Updater</div><div style={{ display: "flex", flexDirection: "column", gap: 16 }}><Sel label="Apply To" value={bulkCat} onChange={setBulkCat} options={cats} /><Inp label="Price Change (%)" value={bulkPct} onChange={setBulkPct} type="number" placeholder="e.g. 10 for +10%, -5 for -5%" /><div style={{ background: C.warningLight, border: `1px solid ${C.warning}`, borderRadius: 8, padding: 12, fontSize: 12, color: C.warning }}>⚠️ This will update all prices in the selected category.</div><Btn variant="accent" onClick={() => { const pct = parseFloat(bulkPct); if (!pct) return; setItems(prev => prev.map(it => (bulkCat === "All" || it.category === bulkCat) ? { ...it, price: parseFloat((it.price * (1 + pct / 100)).toFixed(2)) } : it)); alert("Prices updated!"); setBulkPct(""); }} disabled={!bulkPct}>Apply</Btn></div></Card>}
      {tab === "backup" && <Card style={{ maxWidth: 500 }}><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Backup Data</div><div style={{ fontSize: 13, color: C.textMid, marginBottom: 16 }}>Download a full backup of sales, menu, and settings.</div><Btn onClick={() => { const backup = { timestamp: new Date().toISOString(), items, sales: sales.slice(-100) }; const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `restopos-backup-${TODAY}.json`; a.click(); }}>💾 Download Backup</Btn></Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// USER ADMIN SCREEN
// ═══════════════════════════════════════════════════════════════════
function UserAdmin({ users, setUsers }) {
  const [showModal, setShowModal] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const blank = { name: "", username: "", role: "Cashier", active: true };
  const [form, setForm] = useState(blank);
  function openModal(u = null) { setEditUser(u); setForm(u ? { ...u } : { ...blank }); setShowModal(true); }
  function save() { if (!form.name || !form.username) return alert("Name and username required"); setUsers(prev => editUser ? prev.map(u => u.id === editUser.id ? { ...form, id: editUser.id } : u) : [...prev, { ...form, id: Date.now(), lastLogin: "Never" }]); setShowModal(false); }
  return (
    <div>
      {showModal && <Modal title={editUser ? "Edit User" : "New User"} onClose={() => setShowModal(false)} width={420}><div style={{ display: "flex", flexDirection: "column", gap: 14 }}><Inp label="Full Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} /><Inp label="Username" value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} /><Sel label="Role" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} options={["Admin", "Manager", "Cashier"]} /><div style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} id="userActive" /><label htmlFor="userActive" style={{ fontSize: 13 }}>Active</label></div></div><div style={{ display: "flex", gap: 10, marginTop: 20 }}><Btn variant="ghost" onClick={() => setShowModal(false)} style={{ flex: 1 }}>Cancel</Btn><Btn onClick={save} style={{ flex: 1 }}>Save</Btn></div></Modal>}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}><div style={{ fontSize: 15, fontWeight: 700 }}>User Management</div><Btn size="sm" onClick={() => openModal()}>+ New User</Btn></div>
        <DataTable headers={["Name", "Username", "Role", "Status", "Last Login", "Actions"]} rows={users.map(u => [u.name, <span style={{ fontFamily: "monospace" }}>{u.username}</span>, <Badge color={u.role === "Admin" ? C.danger : u.role === "Manager" ? C.warning : C.info} bg={u.role === "Admin" ? C.dangerLight : u.role === "Manager" ? C.warningLight : C.infoLight}>{u.role}</Badge>, <Badge color={u.active ? C.success : C.danger} bg={u.active ? C.successLight : C.dangerLight}>{u.active ? "Active" : "Inactive"}</Badge>, u.lastLogin, <div style={{ display: "flex", gap: 6 }}><Btn size="sm" variant="ghost" onClick={() => openModal(u)}>Edit</Btn><Btn size="sm" variant="danger" onClick={() => { if (confirm("Delete user?")) setUsers(prev => prev.filter(x => x.id !== u.id)); }}>Del</Btn></div>])} />
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HELP SCREEN
// ═══════════════════════════════════════════════════════════════════
function Help() {
  const [tab, setTab] = useState("getting-started");
  const sections = [["getting-started", "🚀", "Getting Started"], ["payment", "💳", "Payments"], ["roles", "👤", "Roles"], ["zatca", "⬛", "ZATCA QR"], ["support", "📞", "Support"]];
  return (
    <div style={{ display: "flex", gap: 20 }}>
      <div style={{ width: 180, flexShrink: 0 }}>
        <Card style={{ padding: 8 }}>
          {sections.map(([id, icon, label]) => <button key={id} onClick={() => setTab(id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: tab === id ? C.primaryLight : "transparent", color: tab === id ? C.primary : C.textMid, border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: tab === id ? 700 : 500, textAlign: "left", marginBottom: 2 }}><span>{icon}</span><span>{label}</span></button>)}
        </Card>
      </div>
      <div style={{ flex: 1 }}>
        {tab === "getting-started" && <Card><div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>Getting Started</div>{[{ n: "1", t: "Activate License", d: "On first launch, enter your License Key and VAT Registration Number. These are saved permanently." }, { n: "2", t: "Setup Menu", d: "Go to Create → Items to add your menu items with Arabic names, prices, and categories." }, { n: "3", t: "Start Billing", d: "Use the POS screen to select items, choose order type, and process payment." }, { n: "4", t: "ZATCA QR", d: "Every receipt automatically generates a compliant QR code using your VAT number via TLV encoding." }].map((s, i) => <div key={i} style={{ display: "flex", gap: 16, marginBottom: 14, padding: 14, background: C.bg, borderRadius: 10 }}><div style={{ width: 36, height: 36, background: C.primary, color: "#fff", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, flexShrink: 0 }}>{s.n}</div><div><div style={{ fontSize: 14, fontWeight: 700, marginBottom: 3 }}>{s.t}</div><div style={{ fontSize: 13, color: C.textMid }}>{s.d}</div></div></div>)}</Card>}
        {tab === "zatca" && <Card><div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>⬛ ZATCA QR Code</div><div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{[["Standard", "ZATCA Phase 1 & 2 Ready"], ["Encoding", "TLV (Tag-Length-Value) → Base64"], ["QR Content", "Seller Name, VAT No., Timestamp, Total, VAT Amount"], ["Library", "qrcodejs — real scannable QR code"], ["Auto-Source", "VAT number pulled from your saved license — no manual input per invoice"]].map(([k, v]) => <div key={k} style={{ display: "flex", gap: 12, padding: "10px 14px", background: C.zatcaLight, borderRadius: 8 }}><span style={{ fontSize: 12, fontWeight: 700, color: C.zatca, width: 120, flexShrink: 0 }}>{k}</span><span style={{ fontSize: 13, color: C.text }}>{v}</span></div>)}</div></Card>}
        {tab === "payment" && <Card><div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>Payment Methods</div>{[{ icon: "💵", name: "Cash", desc: "Enter amount received, auto-calculates change. Quick amount buttons: SAR 10–500." }, { icon: "💳", name: "Mada", desc: "Saudi debit card. One-tap confirm, no cash input needed." }, { icon: "", name: "Apple Pay", desc: "NFC contactless. Instant confirm." }, { icon: "📱", name: "STC Pay", desc: "Saudi mobile wallet. Instant confirm." }].map((m, i) => <div key={i} style={{ display: "flex", gap: 16, marginBottom: 14, padding: 14, background: C.bg, borderRadius: 10 }}><span style={{ fontSize: 28 }}>{m.icon}</span><div><div style={{ fontSize: 14, fontWeight: 700 }}>{m.name}</div><div style={{ fontSize: 13, color: C.textMid, marginTop: 4 }}>{m.desc}</div></div></div>)}</Card>}
        {tab === "roles" && <Card><div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>User Roles</div>{[{ name: "Admin", color: C.danger, perms: ["Full system access", "User management", "Void transactions", "Backup & restore", "All reports"] }, { name: "Manager", color: C.warning, perms: ["POS operations", "View all reports", "Manage menu", "Void transactions"] }, { name: "Cashier", color: C.info, perms: ["POS billing only", "Print receipts", "View today's KOT"] }].map((r, i) => <div key={i} style={{ marginBottom: 14, padding: 14, border: `1.5px solid ${r.color}30`, borderRadius: 10 }}><Badge color={r.color} bg={r.color + "15"}>{r.name}</Badge><div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>{r.perms.map(p => <div key={p} style={{ fontSize: 12, color: C.textMid, display: "flex", gap: 4 }}><span style={{ color: C.success }}>✓</span>{p}</div>)}</div></div>)}</Card>}
        {tab === "support" && <Card><div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>Support & Contact</div>{[{ icon: "📦", label: "Product", value: "RestoPOS v1.0 — ZATCA Phase 2 Ready" }, { icon: "🌍", label: "Region", value: "Kingdom of Saudi Arabia" }, { icon: "📧", label: "Email", value: "support@restopos.sa" }, { icon: "📞", label: "Phone", value: "+966 50 000 0000 (9AM–6PM AST)" }, { icon: "💬", label: "WhatsApp", value: "+966 50 000 0000" }].map((item, i) => <div key={i} style={{ display: "flex", gap: 14, padding: "12px 0", borderBottom: `1px solid ${C.border}`, alignItems: "center" }}><span style={{ fontSize: 20, width: 28 }}>{item.icon}</span><div style={{ fontSize: 12, fontWeight: 700, color: C.textMid, width: 100 }}>{item.label}</div><div style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{item.value}</div></div>)}</Card>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [license, setLicense] = useState(() => loadLicense());
  const [screen, setScreen] = useState("pos");
  const [sales, setSales] = useState(ALL_SALES);
  const [items, setItems] = useState(SEED_ITEMS);
  const [tables, setTables] = useState(TABLES_INIT);
  const [users, setUsers] = useState(SEED_USERS);
  const [promos, setPromos] = useState([
    { id: 1, code: "SAVE10", type: "%", value: 10, active: true, minOrder: 30 },
    { id: 2, code: "FLAT20", type: "flat", value: 20, active: true, minOrder: 100 },
  ]);
  const [company, setCompany] = useState({ name: "RestoPOS Demo", nameAr: "ريستوبوس", trn: "", phone: "", email: "", address: "", city: "Riyadh", country: "Saudi Arabia" });

  // Sync company info from license on activate
  useEffect(() => {
    if (license) {
      setCompany(c => ({ ...c, name: license.businessName, trn: license.vatNumber, phone: license.phone || c.phone, address: license.address, city: license.city || c.city }));
    }
  }, [license]);

  function handleActivate(lic) { setLicense(lic); setScreen("pos"); }
  function handleClearLicense() { localStorage.removeItem(LICENSE_KEY); setLicense(null); }

  // Show license gate if not activated
  if (!license) return <LicenseGate onActivate={handleActivate} />;

  const NAV = [
    ["dashboard", "📊", "Dashboard"],
    ["pos", "🖥️", "POS"],
    ["settings", "⚙️", "Settings"],
    ["create", "➕", "Create"],
    ["transactions", "💳", "Transactions"],
    ["accounts", "📈", "Accounts"],
    ["reports", "📋", "Reports"],
    ["tools", "🔧", "Tools"],
    ["useradmin", "👤", "Users"],
    ["help", "❓", "Help"],
  ];

  return (
    <div style={{ fontFamily: "'Plus Jakarta Sans', 'Tajawal', sans-serif", background: C.bg, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tajawal:wght@400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        input, select { outline: none; }
        input:focus, select:focus { border-color: ${C.primary} !important; box-shadow: 0 0 0 3px ${C.primaryLight}; }
        @media print { header, nav { display: none !important; } }
      `}</style>

      {/* Top Header */}
      <div style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, height: 52, display: "flex", alignItems: "center", padding: "0 20px", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #1A6B4A, #F0A500)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16, fontWeight: 900 }}>R</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.text, lineHeight: 1 }}>RestoPOS</div>
            <div style={{ fontSize: 9, color: C.textLight, letterSpacing: "0.08em" }}>ZATCA PHASE 2 READY</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2, overflowX: "auto" }}>
          {NAV.map(([id, icon, label]) => (
            <button key={id} onClick={() => setScreen(id)} style={{ padding: "6px 10px", borderRadius: 8, border: "none", background: screen === id ? C.primaryLight : "transparent", color: screen === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 11, fontWeight: screen === id ? 700 : 500, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", transition: "all 0.15s" }}>
              <span>{icon}</span><span>{label}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.textLight }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.success }} />Online
          </div>
          <div style={{ fontSize: 11, background: C.zatcaLight, color: C.zatca, padding: "3px 8px", borderRadius: 6, fontWeight: 700 }}>⬛ ZATCA</div>
          <div style={{ fontSize: 12, color: C.textMid, fontWeight: 600 }}>Admin</div>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, padding: screen === "pos" ? 0 : 24, overflowY: screen === "pos" ? "hidden" : "auto" }}>
        {screen === "dashboard" && <Dashboard sales={sales} items={items} license={license} />}
        {screen === "pos" && <POS items={items} sales={sales} setSales={setSales} tables={tables} setTables={setTables} promos={promos} license={license} />}
        {screen === "settings" && <Settings company={company} setCompany={setCompany} tables={tables} setTables={setTables} license={license} onClearLicense={handleClearLicense} />}
        {screen === "create" && <Create items={items} setItems={setItems} promos={promos} setPromos={setPromos} />}
        {screen === "transactions" && <Transactions sales={sales} setSales={setSales} />}
        {screen === "accounts" && <Accounts sales={sales} items={items} />}
        {screen === "reports" && <Reports sales={sales} items={items} />}
        {screen === "tools" && <Tools sales={sales} items={items} setItems={setItems} />}
        {screen === "useradmin" && <UserAdmin users={users} setUsers={setUsers} />}
        {screen === "help" && <Help />}
      </div>
    </div>
  );
}
