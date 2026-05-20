import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, where, getDocs, updateDoc, doc, addDoc, getDoc } from "firebase/firestore";

// ═══════════════════════════════════════════════════════════════════
// FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyDcVRHCOafLYt-0rCTfafaC6MFpyQVfG9o",
  authDomain: "restopos-db.firebaseapp.com",
  projectId: "restopos-db",
  storageBucket: "restopos-db.firebasestorage.app",
  messagingSenderId: "82816670819",
  appId: "1:82816670819:web:1a589e6a6b0b12edb4ec56"
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

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
// QR CODE
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
function QRCodeDisplay({ data, size = 140 }) {
  const ref = useRef();
  const qrReady = useQRScript();
  useEffect(() => {
    if (!qrReady || !data || !ref.current) return;
    ref.current.innerHTML = "";
    try {
      new window.QRCode(ref.current, { text: data, width: size, height: size, colorDark: "#000000", colorLight: "#ffffff", correctLevel: window.QRCode?.CorrectLevel?.M });
    } catch (e) {
      ref.current.innerHTML = `<div style="width:${size}px;height:${size}px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#999">QR Error</div>`;
    }
  }, [qrReady, data, size]);
  if (!qrReady) return <div style={{ width: size, height: size, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#999" }}>Loading…</div>;
  return <div ref={ref} />;
}

// ═══════════════════════════════════════════════════════════════════
// LOCAL STORAGE HELPERS
// ═══════════════════════════════════════════════════════════════════
const LS = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem(k),
};

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
const SEED_ITEMS = [
  { id: 1, name: "Broasted Chicken Half", nameAr: "دجاج مبروست نصف", category: "Broasted", price: 28, cost: 14, stock: 50, active: true, barcode: "" },
  { id: 2, name: "Broasted Chicken Full", nameAr: "دجاج مبروست كامل", category: "Broasted", price: 52, cost: 26, stock: 30, active: true, barcode: "" },
  { id: 3, name: "Crispy Wings 6pc", nameAr: "أجنحة مقرمشة", category: "Broasted", price: 22, cost: 10, stock: 40, active: true, barcode: "" },
  { id: 4, name: "Mixed Grill Platter", nameAr: "مشاوي مشكلة", category: "Grills", price: 65, cost: 30, stock: 20, active: true, barcode: "" },
  { id: 5, name: "Shish Tawook", nameAr: "شيش طاووق", category: "Grills", price: 38, cost: 18, stock: 25, active: true, barcode: "" },
  { id: 6, name: "French Fries", nameAr: "بطاطس مقلية", category: "Sides", price: 10, cost: 3, stock: 100, active: true, barcode: "" },
  { id: 7, name: "Coleslaw", nameAr: "كول سلو", category: "Sides", price: 8, cost: 2, stock: 60, active: true, barcode: "" },
  { id: 8, name: "Pepsi Can", nameAr: "بيبسي", category: "Drinks", price: 5, cost: 2, stock: 120, active: true, barcode: "" },
  { id: 9, name: "Fresh Lemon Juice", nameAr: "عصير ليمون", category: "Drinks", price: 14, cost: 4, stock: 40, active: true, barcode: "" },
  { id: 10, name: "Umm Ali", nameAr: "أم علي", category: "Desserts", price: 18, cost: 6, stock: 15, active: true, barcode: "" },
  { id: 11, name: "Family Box", nameAr: "وجبة عائلية", category: "Combos", price: 85, cost: 40, stock: 20, active: true, barcode: "" },
  { id: 12, name: "Solo Meal", nameAr: "وجبة فردية", category: "Combos", price: 32, cost: 15, stock: 30, active: true, barcode: "" },
];
const SEED_CATEGORIES = ["Broasted", "Grills", "Sides", "Drinks", "Desserts", "Combos"];
const TABLES_INIT = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, status: i < 3 ? "occupied" : "free", capacity: 4 }));

// Default PINs
const DEFAULT_PINS = { Admin: "1234", Manager: "2345", Cashier: "3456" };

// No demo data — sales starts empty for real use

const TODAY = new Date().toISOString().split("T")[0];
function fmtSAR(n) { return "SAR " + Number(n).toFixed(2); }
function fmtDate(d) { return new Date(d).toLocaleDateString("en-SA", { day: "2-digit", month: "short", year: "numeric" }); }
function fmtDateTime(d) { return new Date(d).toLocaleString("en-SA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

// ═══════════════════════════════════════════════════════════════════
// REUSABLE UI
// ═══════════════════════════════════════════════════════════════════
const Card = ({ children, style = {} }) => <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, ...style }}>{children}</div>;
const Btn = ({ children, onClick, variant = "primary", size = "md", disabled = false, style = {} }) => {
  const variants = { primary: { background: C.primary, color: "#fff", border: "none" }, outline: { background: "transparent", color: C.primary, border: `1.5px solid ${C.primary}` }, danger: { background: C.danger, color: "#fff", border: "none" }, ghost: { background: "transparent", color: C.textMid, border: `1px solid ${C.border}` }, accent: { background: C.accent, color: "#fff", border: "none" }, zatca: { background: C.zatca, color: "#fff", border: "none" } };
  const sizes = { sm: { padding: "5px 12px", fontSize: 12 }, md: { padding: "8px 18px", fontSize: 13 }, lg: { padding: "12px 28px", fontSize: 15 } };
  return <button onClick={onClick} disabled={disabled} style={{ ...variants[variant], ...sizes[size], borderRadius: 8, fontFamily: "inherit", fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, transition: "all 0.15s", ...style }}>{children}</button>;
};
const Inp = ({ label, value, onChange, type = "text", placeholder = "", style = {}, readOnly = false }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
    {label && <label style={{ fontSize: 12, fontWeight: 600, color: C.textMid }}>{label}</label>}
    <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} readOnly={readOnly}
      style={{ padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", color: C.text, background: readOnly ? C.bg : "#fff" }} />
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
const Badge = ({ children, color = C.primary, bg = C.primaryLight }) => <span style={{ padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, color, background: bg, whiteSpace: "nowrap" }}>{children}</span>;
const StatCard = ({ label, value, sub, icon, color = C.primary, bg = C.primaryLight }) => (
  <Card style={{ display: "flex", alignItems: "center", gap: 16 }}>
    <div style={{ width: 48, height: 48, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{icon}</div>
    <div><div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div><div style={{ fontSize: 12, color: C.textMid, fontWeight: 600 }}>{label}</div>{sub && <div style={{ fontSize: 11, color: C.textLight, marginTop: 2 }}>{sub}</div>}</div>
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
      <thead><tr style={{ background: C.bg }}>{headers.map(h => <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: C.textMid, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
      <tbody>{rows.length === 0 ? <tr><td colSpan={headers.length} style={{ textAlign: "center", padding: 32, color: C.textLight }}>{emptyMsg}</td></tr> : rows.map((row, i) => <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? "#fff" : "#FAFBFC" }}>{row.map((cell, j) => <td key={j} style={{ padding: "10px 14px", color: C.text, verticalAlign: "middle" }}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>
);

// ═══════════════════════════════════════════════════════════════════
// STEP 1 — BUSINESS REGISTRATION SCREEN
// ═══════════════════════════════════════════════════════════════════
function BusinessRegistration({ onNext }) {
  const [form, setForm] = useState({ businessName: "", crNumber: "", vatNumber: "", address: "", city: "Riyadh", phone: "" });
  const [error, setError] = useState("");
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function handleNext() {
    setError("");
    if (!form.businessName.trim()) return setError("Business name is required.");
    if (!/^\d{12}$/.test(form.crNumber.trim())) return setError("CR Number must be exactly 12 digits.");
    if (!/^3\d{14}$/.test(form.vatNumber.trim())) return setError("VAT number must be 15 digits starting with 3.");
    if (!form.address.trim()) return setError("Address is required.");
    onNext(form);
  }

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #0a1628 0%, #1A3A5C 50%, #0a2818 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{ width: "100%", maxWidth: 520 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ width: 48, height: 48, background: "linear-gradient(135deg,#1A6B4A,#F0A500)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 900, color: "#fff" }}>R</div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontSize: 26, fontWeight: 900, color: "#fff", lineHeight: 1 }}>RestoPOS</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.15em" }}>ZATCA PHASE 2 READY · KSA</div>
            </div>
          </div>
        </div>
        <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 32, boxShadow: "0 32px 80px rgba(0,0,0,0.4)" }}>
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 19, fontWeight: 800, color: C.text, marginBottom: 4 }}>🏢 Business Registration</div>
            <div style={{ fontSize: 13, color: C.textMid }}>Step 1 of 2 — Enter your business details</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Inp label="Business / Restaurant Name *" value={form.businessName} onChange={v => set("businessName", v)} placeholder="e.g. Al Baik Restaurant" />
            <Inp label="Commercial Registration Number (CR) * — 12 digits" value={form.crNumber} onChange={v => set("crNumber", v)} placeholder="123456789012" />
            <Inp label="VAT Registration Number (TRN) * — 15 digits" value={form.vatNumber} onChange={v => set("vatNumber", v)} placeholder="300XXXXXXXXXXXX" />
            <Inp label="Business Address *" value={form.address} onChange={v => set("address", v)} placeholder="King Fahd Road, Riyadh 12345" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Inp label="City" value={form.city} onChange={v => set("city", v)} placeholder="Riyadh" />
              <Inp label="Phone" value={form.phone} onChange={v => set("phone", v)} placeholder="+966 50 000 0000" />
            </div>
          </div>
          {error && <div style={{ background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.danger, fontWeight: 600, marginTop: 12 }}>⚠️ {error}</div>}
          <button onClick={handleNext} style={{ width: "100%", marginTop: 18, background: "linear-gradient(135deg,#1A6B4A,#134D36)", color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
            Next — Enter License Key →
          </button>
        </div>

        {/* OWNER LOGIN BOX */}
        <div style={{ marginTop: 16, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 16, padding: "20px 24px", backdropFilter: "blur(8px)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.9)", marginBottom: 2 }}>👑 Are you the owner?</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>Access your admin dashboard to manage all clients</div>
            </div>
            <button onClick={() => { window._ownerMode = true; window.dispatchEvent(new Event("ownerLogin")); }}
              style={{ padding: "9px 18px", background: "linear-gradient(135deg,#F0A500,#e09000)", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
              Owner Login →
            </button>
          </div>
        </div>

        {/* CONTACT SUPPORT */}
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 20, padding: "14px 0" }}>
          <a href="mailto:support@restopos.sa" style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, textDecoration: "none", display: "flex", alignItems: "center", gap: 5 }}>📧 support@restopos.sa</a>
          <span style={{ color: "rgba(255,255,255,0.2)" }}>|</span>
          <a href="tel:+966500000000" style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, textDecoration: "none", display: "flex", alignItems: "center", gap: 5 }}>📞 +966 50 000 0000</a>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STEP 2 — LICENSE KEY VERIFICATION + DOCUMENT UPLOAD + PENDING APPROVAL
// ═══════════════════════════════════════════════════════════════════
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function LicenseVerification({ businessData, onSuccess, onBack }) {
  const [subStep, setSubStep] = useState("key"); // "key" | "docs" | "pending"
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [licDocRef, setLicDocRef] = useState(null);
  const [deviceId] = useState(() => {
    let id = localStorage.getItem("restopos_device_id");
    if (!id) { id = "dev_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10); localStorage.setItem("restopos_device_id", id); }
    return id;
  });

  // Doc upload state
  const [vatCert, setVatCert] = useState(null);
  const [bizLicense, setBizLicense] = useState(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const vatRef = useRef();
  const bizRef = useRef();

  // Pending polling state
  const [pendingId, setPendingId] = useState(() => localStorage.getItem("restopos_pending_id"));
  const [pollStatus, setPollStatus] = useState("pending");
  const [pollMsg, setPollMsg] = useState("");

  // If already pending from a previous session, jump straight to pending screen
  useEffect(() => {
    const savedPending = localStorage.getItem("restopos_pending_id");
    const savedLicense = LS.get("restopos_license_v2");
    if (savedLicense) return; // already approved
    if (savedPending) { setPendingId(savedPending); setSubStep("pending"); }
  }, []);

  // Poll Firestore every 10s while on pending screen
  useEffect(() => {
    if (subStep !== "pending" || !pendingId) return;
    async function poll() {
      try {
        const snap = await getDoc(doc(db, "pending_activations", pendingId));
        if (!snap.exists()) return;
        const d = snap.data();
        if (d.status === "approved") {
          // Build license from the approval data and proceed
          const license = { businessName: d.businessName, crNumber: d.crNumber, vatNumber: d.vatNumber, address: d.address, city: d.city, phone: d.phone, licenseKey: d.licenseKey, activatedAt: new Date().toISOString(), docId: d.licDocId, deviceId };
          LS.set("restopos_license_v2", license);
          localStorage.removeItem("restopos_pending_id");
          setPollStatus("approved");
          setTimeout(() => onSuccess(license), 1800);
        } else if (d.status === "rejected") {
          setPollStatus("rejected");
          setPollMsg(d.rejectReason || "Your application was rejected. Please contact support.");
          localStorage.removeItem("restopos_pending_id");
        }
      } catch (e) { /* network hiccup, ignore */ }
    }
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [subStep, pendingId]);

  // STEP A: Verify license key exists and is valid
  async function handleVerifyKey() {
    setError("");
    const key = licenseKey.trim();
    if (key.length !== 12) return setError("License key must be exactly 12 digits.");
    if (!/^\d{12}$/.test(key)) return setError("License key must contain numbers only.");
    setLoading(true);
    try {
      const q = query(collection(db, "licenses"), where("key", "==", key), where("active", "==", true));
      const snap = await getDocs(q);
      if (snap.empty) { setError("Invalid or inactive license key. Please contact support."); setLoading(false); return; }
      const docRef = snap.docs[0];
      const licData = docRef.data();
      if (licData.deviceId && licData.deviceId !== deviceId) {
        setError("❌ This license key is already activated on another device. Contact support to transfer.");
        setLoading(false); return;
      }
      // Check if this key already has a pending activation
      if (licData.pendingId) {
        setPendingId(licData.pendingId);
        localStorage.setItem("restopos_pending_id", licData.pendingId);
        setSubStep("pending");
        setLoading(false); return;
      }
      setLicDocRef(docRef);
      setSubStep("docs");
    } catch (e) { setError("Connection error. Please check your internet and try again."); }
    setLoading(false);
  }

  function handleFileSelect(e, setter) {
    const file = e.target.files[0];
    if (!file) return;
    const allowed = ["image/jpeg", "image/jpg", "image/png", "application/pdf"];
    if (!allowed.includes(file.type)) { setUploadError("Only JPG, PNG, or PDF files are allowed."); return; }
    if (file.size > 5 * 1024 * 1024) { setUploadError("File must be under 5MB."); return; }
    setUploadError("");
    setter(file);
  }

  // STEP B: Upload documents and create pending_activations record
  async function handleSubmitDocs() {
    setUploadError("");
    if (!vatCert) return setUploadError("Please upload your VAT Registration Certificate.");
    if (!bizLicense) return setUploadError("Please upload your Commercial Business License.");
    setUploadLoading(true);
    try {
      // Convert files to base64 and store in Firestore (files ≤5MB each → fits in Firestore doc)
      const vatBase64 = await fileToBase64(vatCert);
      const bizBase64 = await fileToBase64(bizLicense);

      // Create pending activation record
      const pendingRef = await addDoc(collection(db, "pending_activations"), {
        businessName: businessData.businessName,
        crNumber: businessData.crNumber,
        vatNumber: businessData.vatNumber,
        address: businessData.address,
        city: businessData.city,
        phone: businessData.phone,
        licenseKey: licenseKey.trim(),
        licDocId: licDocRef.id,
        deviceId,
        status: "pending",
        submittedAt: new Date().toISOString(),
        vatCertName: vatCert.name,
        vatCertType: vatCert.type,
        vatCertBase64: vatBase64,
        bizLicenseName: bizLicense.name,
        bizLicenseType: bizLicense.type,
        bizLicenseBase64: bizBase64,
      });

      // Link pending ID to the license doc so we can find it on re-login
      await updateDoc(doc(db, "licenses", licDocRef.id), { pendingId: pendingRef.id, pendingAt: new Date().toISOString() });

      setPendingId(pendingRef.id);
      localStorage.setItem("restopos_pending_id", pendingRef.id);
      setSubStep("pending");
    } catch (e) {
      setUploadError("Upload failed. Check your connection and try again. (" + e.message + ")");
    }
    setUploadLoading(false);
  }

  const BG = "linear-gradient(135deg,#0a1628,#1A3A5C 50%,#0a2818)";
  const Logo = () => (
    <div style={{ textAlign: "center", marginBottom: 28 }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 48, height: 48, background: "linear-gradient(135deg,#1A6B4A,#F0A500)", borderRadius: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 900, color: "#fff" }}>R</div>
        <div style={{ fontSize: 26, fontWeight: 900, color: "#fff" }}>RestoPOS</div>
      </div>
    </div>
  );

  // ── PENDING SCREEN ────────────────────────────────────────────────
  if (subStep === "pending") {
    if (pollStatus === "approved") return (
      <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
        <div style={{ textAlign: "center", color: "#fff" }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Approved!</div>
          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)" }}>Launching RestoPOS…</div>
        </div>
      </div>
    );
    if (pollStatus === "rejected") return (
      <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
        <Logo />
        <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 32, maxWidth: 460, width: "100%", boxShadow: "0 32px 80px rgba(0,0,0,0.4)", textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>❌</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.danger, marginBottom: 8 }}>Application Rejected</div>
          <div style={{ fontSize: 14, color: C.textMid, marginBottom: 20 }}>{pollMsg}</div>
          <button onClick={() => { setSubStep("key"); setPollStatus("pending"); }} style={{ padding: "12px 28px", background: C.primary, color: "#fff", border: "none", borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Try Again</button>
        </div>
      </div>
    );
    return (
      <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
        <div style={{ width: "100%", maxWidth: 480 }}>
          <Logo />
          <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 36, boxShadow: "0 32px 80px rgba(0,0,0,0.4)", textAlign: "center" }}>
            <div style={{ width: 72, height: 72, background: "linear-gradient(135deg,#F0A500,#e09000)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36, margin: "0 auto 20px" }}>⏳</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 8 }}>Awaiting Manual Approval</div>
            <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.7, marginBottom: 24 }}>
              Your documents have been submitted successfully.<br/>
              Our team is reviewing your <strong>VAT Certificate</strong> and <strong>Commercial License</strong>.<br/>
              This usually takes <strong>a few hours</strong>.
            </div>
            <div style={{ background: C.warningLight, border: `1px solid ${C.accent}40`, borderRadius: 12, padding: "14px 18px", marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.warning, marginBottom: 6 }}>📋 WHAT HAPPENS NEXT</div>
              <div style={{ fontSize: 13, color: C.textMid, textAlign: "left", lineHeight: 1.8 }}>
                1. Our team reviews your submitted documents<br/>
                2. We verify your CR & VAT registration<br/>
                3. You'll be automatically approved and logged in<br/>
                4. Keep this page open or come back later
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: C.textLight }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.accent, animation: "pulse 1.5s infinite" }} />
              Checking for approval every 10 seconds…
            </div>
            <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
          </div>
        </div>
      </div>
    );
  }

  // ── DOCUMENT UPLOAD SCREEN ────────────────────────────────────────
  if (subStep === "docs") {
    const FileBox = ({ label, file, inputRef, onChange, accept }) => (
      <div style={{ border: `2px dashed ${file ? C.primary : C.border}`, borderRadius: 12, padding: "18px 16px", background: file ? C.primaryLight : C.bg, cursor: "pointer", transition: "all 0.15s" }}
        onClick={() => inputRef.current?.click()}>
        <input ref={inputRef} type="file" accept={accept} style={{ display: "none" }} onChange={onChange} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 6 }}>{file ? "✅" : "📄"}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: file ? C.primary : C.textMid, marginBottom: 4 }}>{label}</div>
          {file ? (
            <div style={{ fontSize: 11, color: C.primary, fontWeight: 600 }}>✓ {file.name}</div>
          ) : (
            <div style={{ fontSize: 11, color: C.textLight }}>Click to upload · JPG, PNG or PDF · Max 5MB</div>
          )}
        </div>
      </div>
    );
    return (
      <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
        <div style={{ width: "100%", maxWidth: 500 }}>
          <Logo />
          <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 32, boxShadow: "0 32px 80px rgba(0,0,0,0.4)" }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 19, fontWeight: 800, color: C.text, marginBottom: 4 }}>📎 Upload Verification Documents</div>
              <div style={{ fontSize: 13, color: C.textMid }}>Step 3 of 3 — Required for manual approval</div>
            </div>
            <div style={{ background: C.primaryLight, border: `1px solid ${C.primary}30`, borderRadius: 10, padding: "10px 14px", marginBottom: 20, fontSize: 13 }}>
              <div style={{ fontWeight: 700, color: C.primary, marginBottom: 2 }}>✓ {businessData.businessName}</div>
              <div style={{ color: C.textMid, fontSize: 12 }}>CR: {businessData.crNumber} · VAT: {businessData.vatNumber} · Key: {licenseKey.trim()}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
              <FileBox label="VAT Registration Certificate" file={vatCert} inputRef={vatRef} accept=".jpg,.jpeg,.png,.pdf" onChange={e => handleFileSelect(e, setVatCert)} />
              <FileBox label="Commercial Business License (CR)" file={bizLicense} inputRef={bizRef} accept=".jpg,.jpeg,.png,.pdf" onChange={e => handleFileSelect(e, setBizLicense)} />
            </div>
            {uploadError && <div style={{ background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.danger, fontWeight: 600, marginBottom: 12 }}>⚠️ {uploadError}</div>}
            <button onClick={handleSubmitDocs} disabled={uploadLoading || !vatCert || !bizLicense}
              style={{ width: "100%", padding: 14, background: uploadLoading || !vatCert || !bizLicense ? "#ccc" : "linear-gradient(135deg,#1A6B4A,#134D36)", color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 800, cursor: uploadLoading || !vatCert || !bizLicense ? "not-allowed" : "pointer", fontFamily: "inherit", marginBottom: 10 }}>
              {uploadLoading ? "⏳ Submitting…" : "📤 Submit for Approval"}
            </button>
            <button onClick={() => setSubStep("key")} style={{ width: "100%", padding: 12, background: "transparent", color: C.textMid, border: `1px solid ${C.border}`, borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>← Back</button>
            <div style={{ marginTop: 14, padding: "10px 14px", background: C.bg, borderRadius: 10, fontSize: 11, color: C.textMid, lineHeight: 1.6 }}>
              🔒 Your documents are stored securely and used only for business verification. After manual review by our team, your account will be activated automatically.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── LICENSE KEY ENTRY SCREEN ──────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <Logo />
        <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 32, boxShadow: "0 32px 80px rgba(0,0,0,0.4)" }}>
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 19, fontWeight: 800, color: C.text, marginBottom: 4 }}>🔐 License Activation</div>
            <div style={{ fontSize: 13, color: C.textMid }}>Step 2 of 3 — Enter your 12-digit license key</div>
          </div>
          <div style={{ background: C.primaryLight, border: `1px solid ${C.primary}30`, borderRadius: 10, padding: "10px 14px", marginBottom: 18, fontSize: 13 }}>
            <div style={{ fontWeight: 700, color: C.primary, marginBottom: 2 }}>✓ {businessData.businessName}</div>
            <div style={{ color: C.textMid, fontSize: 12 }}>CR: {businessData.crNumber} · VAT: {businessData.vatNumber}</div>
          </div>
          <Inp label="License Key (12 digits — provided after payment)" value={licenseKey} onChange={setLicenseKey} placeholder="123456789012" />
          {error && <div style={{ background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: C.danger, fontWeight: 600, marginTop: 12 }}>⚠️ {error}</div>}
          <button onClick={handleVerifyKey} disabled={loading} style={{ width: "100%", marginTop: 16, background: loading ? "#ccc" : "linear-gradient(135deg,#6366f1,#4f46e5)", color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 15, fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {loading ? "⏳ Checking…" : "Next — Upload Documents →"}
          </button>
          <button onClick={onBack} style={{ width: "100%", marginTop: 10, background: "transparent", color: C.textMid, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>← Back</button>
          <div style={{ marginTop: 16, padding: "12px 14px", background: C.bg, borderRadius: 10, fontSize: 12, color: C.textMid }}>
            🔒 Your license is verified against our secure database. After key validation, you'll upload your CR and VAT documents for manual approval.
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STEP 3 — ROLE LOGIN
// ═══════════════════════════════════════════════════════════════════
function RoleLogin({ license, onLogin }) {
  const [selectedRole, setSelectedRole] = useState(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const savedPins = LS.get("restopos_pins") || DEFAULT_PINS;

  function handleLogin() {
    if (pin === savedPins[selectedRole]) {
      onLogin({ role: selectedRole, loginTime: new Date().toISOString() });
    } else {
      setError("Incorrect PIN. Try again.");
      setPin("");
    }
  }

  // ✅ FIX: Keyboard PIN input support
  useEffect(() => {
    if (!selectedRole) return;
    function onKey(e) {
      if (e.key >= "0" && e.key <= "9") {
        setPin(p => p.length < 4 ? p + e.key : p);
      } else if (e.key === "Backspace") {
        setPin(p => p.slice(0, -1));
      } else if (e.key === "Enter") {
        setPin(p => { if (p.length === 4) { handleLoginWithPin(p); } return p; });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRole, pin]);

  function handleLoginWithPin(p) {
    const sp = LS.get("restopos_pins") || DEFAULT_PINS;
    if (p === sp[selectedRole]) {
      onLogin({ role: selectedRole, loginTime: new Date().toISOString() });
    } else {
      setError("Incorrect PIN. Try again.");
      setPin("");
    }
  }

  const roles = [
    { id: "Admin", icon: "👑", color: C.danger, desc: "Full access" },
    { id: "Manager", icon: "🧑‍💼", color: C.warning, desc: "Reports & menu" },
    { id: "Cashier", icon: "🧑‍💻", color: C.info, desc: "POS billing only" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#0a1628,#1A3A5C 50%,#0a2818)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 44, height: 44, background: "linear-gradient(135deg,#1A6B4A,#F0A500)", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 900, color: "#fff" }}>R</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#fff" }}>RestoPOS</div>
          </div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", marginTop: 6 }}>{license.businessName}</div>
        </div>
        <div style={{ background: "rgba(255,255,255,0.97)", borderRadius: 20, padding: 28, boxShadow: "0 32px 80px rgba(0,0,0,0.4)" }}>
          {!selectedRole ? (
            <>
              <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 18, textAlign: "center" }}>👤 Select Your Role</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {roles.map(r => (
                  <button key={r.id} onClick={() => { setSelectedRole(r.id); setPin(""); setError(""); }} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", background: "#fff", border: `2px solid ${C.border}`, borderRadius: 12, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s", textAlign: "left" }}
                    onMouseOver={e => e.currentTarget.style.borderColor = r.color}
                    onMouseOut={e => e.currentTarget.style.borderColor = C.border}>
                    <span style={{ fontSize: 26 }}>{r.icon}</span>
                    <div><div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{r.id}</div><div style={{ fontSize: 12, color: C.textMid }}>{r.desc}</div></div>
                    <span style={{ marginLeft: "auto", color: C.textLight }}>→</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <button onClick={() => { setSelectedRole(null); setPin(""); setError(""); }} style={{ background: "none", border: "none", color: C.textMid, cursor: "pointer", fontSize: 13, marginBottom: 16, fontFamily: "inherit" }}>← Back</button>
              <div style={{ textAlign: "center", marginBottom: 20 }}>
                <div style={{ fontSize: 32, marginBottom: 6 }}>{roles.find(r => r.id === selectedRole)?.icon}</div>
                <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>{selectedRole}</div>
                <div style={{ fontSize: 12, color: C.textMid }}>Enter your PIN</div>
              </div>
              {/* PIN pad */}
              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 16 }}>
                {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 14, height: 14, borderRadius: "50%", background: pin.length > i ? C.primary : C.border }} />)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k, i) => (
                  <button key={i} onClick={() => { if (k === "⌫") setPin(p => p.slice(0,-1)); else if (k !== "") setPin(p => p.length < 4 ? p + k : p); }} style={{ padding: "16px", background: k === "" ? "transparent" : C.bg, border: k === "" ? "none" : `1px solid ${C.border}`, borderRadius: 10, fontSize: 18, fontWeight: 700, cursor: k === "" ? "default" : "pointer", fontFamily: "inherit", color: C.text }}>{k}</button>
                ))}
              </div>
              {error && <div style={{ background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: C.danger, marginBottom: 10, textAlign: "center" }}>{error}</div>}
              <button onClick={() => handleLoginWithPin(pin)} disabled={pin.length !== 4} style={{ width: "100%", background: pin.length === 4 ? "linear-gradient(135deg,#1A6B4A,#134D36)" : "#ccc", color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 15, fontWeight: 800, cursor: pin.length === 4 ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
                Login as {selectedRole}
              </button>
            </>
          )}
        </div>
      </div>
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
        <div style={{ background: "linear-gradient(135deg,#1A3A5C,#0F2340)", padding: "20px 24px", borderRadius: "20px 20px 0 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><div style={{ color: "#fff", fontSize: 18, fontWeight: 800 }}>💳 Payment</div><div style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, marginTop: 2 }}>Complete the transaction</div></div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", width: 32, height: 32, borderRadius: "50%", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        <div style={{ padding: 24 }}>
          <div style={{ background: "#F0F7FF", border: "1.5px solid #C5DCF5", borderRadius: 14, padding: "16px 20px", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div><div style={{ fontSize: 12, color: "#5A7A9A", fontWeight: 600 }}>AMOUNT DUE</div><div style={{ fontSize: 32, fontWeight: 900, color: "#1A3A5C" }}>SAR {finalTotal.toFixed(2)}</div></div>
            <div style={{ textAlign: "right", fontSize: 12, color: "#5A7A9A" }}><div>Subtotal: SAR {subtotal.toFixed(2)}</div>{promoDiscount > 0 && <div style={{ color: "#D94040" }}>Promo: -SAR {promoDiscount.toFixed(2)}</div>}<div>VAT 15%: SAR {vat.toFixed(2)}</div></div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#5A7A9A", marginBottom: 8 }}>PROMO CODE</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={promoCode} onChange={e => setPromoCode(e.target.value.toUpperCase())} placeholder="e.g. SAVE10" style={{ flex: 1, padding: "9px 12px", border: "1.5px solid #E0E8F0", borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
              <button onClick={() => { const p = promos.find(p => p.code.toLowerCase() === promoCode.toLowerCase() && p.active); if (p) setAppliedPromo(p); else alert("Invalid promo code"); }} style={{ padding: "9px 16px", background: "#1A3A5C", color: "#fff", border: "none", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>Apply</button>
            </div>
            {appliedPromo && <div style={{ fontSize: 12, color: "#1A8A4A", marginTop: 6, fontWeight: 600 }}>✓ {appliedPromo.code} — {appliedPromo.type === "%" ? appliedPromo.value + "% off" : "SAR " + appliedPromo.value + " off"}</div>}
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#5A7A9A", marginBottom: 8 }}>PAYMENT METHOD</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
              {METHODS.map(m => <button key={m.id} onClick={() => setMethod(m.id)} style={{ padding: "12px 8px", border: `2px solid ${method === m.id ? "#1A3A5C" : "#E0E8F0"}`, background: method === m.id ? "#1A3A5C" : "#fff", color: method === m.id ? "#fff" : "#5A7A9A", borderRadius: 10, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}><span style={{ fontSize: 18 }}>{m.icon}</span>{m.label}</button>)}
            </div>
          </div>
          {method === "Cash" && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#5A7A9A", marginBottom: 8 }}>AMOUNT GIVEN</div>
              <input value={given} onChange={e => setGiven(e.target.value)} type="number" placeholder="0.00" style={{ width: "100%", padding: "12px 16px", border: `2px solid ${shortfall ? "#D94040" : "#E0E8F0"}`, borderRadius: 10, fontSize: 22, fontWeight: 800, fontFamily: "inherit", color: "#1A3A5C", textAlign: "center" }} />
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {QUICK.map(q => <button key={q} onClick={() => setGiven(String(q))} style={{ flex: 1, minWidth: 55, padding: "7px 4px", background: parseFloat(given) === q ? "#1A3A5C" : "#F0F7FF", color: parseFloat(given) === q ? "#fff" : "#1A3A5C", border: "1.5px solid #C5DCF5", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700 }}>SAR {q}</button>)}
                <button onClick={() => setGiven(finalTotal.toFixed(2))} style={{ flex: 1, minWidth: 60, padding: "7px 4px", background: "#E8F5EE", color: "#1A6B4A", border: "1.5px solid #A8D5B8", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 11, fontWeight: 700 }}>Exact</button>
              </div>
              {parseFloat(given) > 0 && <div style={{ marginTop: 12, background: shortfall ? "#FDE8E8" : "#E8F5EE", border: `1.5px solid ${shortfall ? "#D94040" : "#1A8A4A"}`, borderRadius: 12, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: shortfall ? "#D94040" : "#1A6B4A" }}>{shortfall ? "⚠️ Shortfall" : "✓ Change"}</span>
                <span style={{ fontSize: 22, fontWeight: 900, color: shortfall ? "#D94040" : "#1A6B4A" }}>SAR {shortfall ? (finalTotal - parseFloat(given)).toFixed(2) : change.toFixed(2)}</span>
              </div>}
            </div>
          )}
          <button onClick={() => onConfirm(method, parseFloat(given || finalTotal), change, appliedPromo, promoDiscount)} disabled={method === "Cash" && parseFloat(given || 0) < finalTotal}
            style={{ width: "100%", padding: 15, background: method === "Cash" && parseFloat(given || 0) < finalTotal ? "#ccc" : "linear-gradient(135deg,#1A6B4A,#0F4A30)", color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 800, cursor: method === "Cash" && parseFloat(given || 0) < finalTotal ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {method === "Cash" ? (parseFloat(given || 0) < finalTotal ? "Enter amount received" : "✓ Confirm & Print Receipt") : `✓ Confirm ${method} Payment`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// RECEIPT MODAL with REAL ZATCA QR — Thermal Printer Optimized
// ═══════════════════════════════════════════════════════════════════
function ReceiptModal({ order, license, onClose }) {
  const qrData = generateZATCABase64({ sellerName: license.businessName, vatNumber: license.vatNumber, timestamp: new Date().toISOString(), total: order.total, vatAmount: order.vat });
  const printFrameRef = useRef();

  // ✅ FIX: Generate QR as base64 PNG first, then inject into hidden iframe for printing
  // This avoids canvas→print issues AND removes the popup window confirmation dialog
  function handleThermalPrint() {
    // Step 1: Generate QR to a temporary off-screen canvas and convert to PNG base64
    let qrImgSrc = "";
    try {
      const tempDiv = document.createElement("div");
      tempDiv.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:120px;height:120px;";
      document.body.appendChild(tempDiv);
      new window.QRCode(tempDiv, {
        text: qrData, width: 110, height: 110,
        colorDark: "#000000", colorLight: "#ffffff",
        correctLevel: window.QRCode?.CorrectLevel?.M
      });
      const canvas = tempDiv.querySelector("canvas");
      if (canvas) qrImgSrc = canvas.toDataURL("image/png");
      document.body.removeChild(tempDiv);
    } catch (e) { console.warn("QR gen error:", e); }

    // Step 2: Build receipt HTML with QR as <img> (prints perfectly every time)
    const receiptHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Receipt ${order.id}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; font-size: 12px; color: #000; background: #fff; width: 80mm; padding: 4mm; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .big { font-size: 16px; font-weight: bold; }
  .hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; margin: 2px 0; }
  .row-total { display: flex; justify-content: space-between; margin: 4px 0; font-size: 15px; font-weight: 900; border-top: 2px solid #000; padding-top: 4px; }
  .item-name { flex: 1; }
  .item-amt { white-space: nowrap; margin-left: 4px; }
  .qr-wrap { text-align: center; margin: 8px 0; }
  .qr-wrap img { width: 110px; height: 110px; display: block; margin: 0 auto; }
  .zatca-label { font-size: 9px; color: #000; font-weight: bold; letter-spacing: 0.1em; }
  .footer { font-size: 11px; text-align: center; margin-top: 8px; font-weight: bold; }
  @media print { body { width: 80mm; } }
</style>
</head>
<body>
<div class="center">
  <div class="big">${license.businessName}</div>
  <div>${license.address || ""}</div>
  <div>TRN: ${license.vatNumber}</div>
  <div>${order.id} &nbsp;|&nbsp; ${order.date} ${order.time}</div>
  ${order.customer ? `<div>Customer: ${order.customer}</div>` : ""}
  ${order.customerPhone ? `<div>Phone: ${order.customerPhone}</div>` : ""}
  <div>${order.type}${order.table ? ` · Table ${order.table}` : ""}</div>
  <div>Cashier: ${order.cashier || "Admin"}</div>
</div>
<hr class="hr"/>
${order.items.map(it => `<div class="row"><span class="item-name">${it.name}${it.nameAr ? `<br/><span style="direction:rtl;display:block;text-align:right;font-family:Arial,sans-serif;font-size:10px;">${it.nameAr}</span>` : ""}<br/><small>${it.qty} x ${it.price.toFixed(2)}</small></span><span class="item-amt">${(it.qty * it.price).toFixed(2)}</span></div>`).join("")}
<hr class="hr"/>
<div class="row"><span>Subtotal</span><span>SAR ${order.subtotal.toFixed(2)}</span></div>
${order.discount > 0 ? `<div class="row"><span>Discount</span><span>-SAR ${order.discount.toFixed(2)}</span></div>` : ""}
<div class="row"><span>VAT 15%</span><span>SAR ${order.vat.toFixed(2)}</span></div>
<div class="row-total"><span>TOTAL</span><span>SAR ${order.total.toFixed(2)}</span></div>
${order.payMethod === "Cash" ? `<div class="row"><span>Cash Given</span><span>SAR ${Number(order.given).toFixed(2)}</span></div><div class="row bold"><span>Change</span><span>SAR ${Number(order.change).toFixed(2)}</span></div>` : `<div class="row bold"><span>Payment</span><span>${order.payMethod}</span></div>`}
<hr class="hr"/>
<div class="qr-wrap">
  ${qrImgSrc ? `<img src="${qrImgSrc}" alt="ZATCA QR"/>` : `<div style="width:110px;height:110px;border:1px solid #ccc;margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:9px;">QR unavailable</div>`}
  <div class="zatca-label" style="margin-top:4px;">ZATCA PHASE 2 · QR CODE</div>
  <div style="font-size:8px;">TLV Base64 · Scan to verify</div>
</div>
<div class="footer">Thank you for your visit!</div>
<div style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;text-align:center;direction:rtl;margin-top:4px;">شكراً لزيارتكم</div>
<br/><br/>
</body>
</html>`;

    // Step 3: Write into hidden iframe and print — no popup, no extra confirmation window
    const iframe = printFrameRef.current;
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(receiptHtml);
    doc.close();
    setTimeout(() => { iframe.contentWindow.focus(); iframe.contentWindow.print(); }, 400);
  }

  return (
    <Modal title="🧾 Receipt" onClose={onClose} width={400}>
      <div style={{ fontFamily: "monospace", fontSize: 12 }}>
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{license.businessName}</div>
          <div style={{ color: "#888", fontSize: 11 }}>{license.address}</div>
          <div style={{ color: "#888" }}>TRN: {license.vatNumber}</div>
          <div style={{ marginTop: 4 }}>{order.id} · {order.time}</div>
          {order.customer && <div>Customer: {order.customer}</div>}
          {order.customerPhone && <div>Phone: {order.customerPhone}</div>}
          {order.customerAddress && <div>Address: {order.customerAddress}</div>}
          <div>{order.type}{order.table ? ` · Table ${order.table}` : ""}</div>
        </div>
        <hr style={{ border: "none", borderTop: "1px dashed #ccc", margin: "8px 0" }} />
        {order.items.map(it => <div key={it.id} style={{ display: "flex", justifyContent: "space-between", margin: "4px 0" }}><span style={{ flex: 1 }}>{it.name}</span><span style={{ whiteSpace: "nowrap" }}>{it.qty} × {it.price.toFixed(2)} = {(it.qty * it.price).toFixed(2)}</span></div>)}
        <hr style={{ border: "none", borderTop: "1px dashed #ccc", margin: "8px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>Subtotal</span><span>{fmtSAR(order.subtotal)}</span></div>
        {order.discount > 0 && <div style={{ display: "flex", justifyContent: "space-between", color: "#D94040" }}><span>Discount</span><span>-{fmtSAR(order.discount)}</span></div>}
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>VAT 15%</span><span>{fmtSAR(order.vat)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, fontSize: 15, marginTop: 6, borderTop: "2px solid #333", paddingTop: 6 }}><span>TOTAL</span><span>{fmtSAR(order.total)}</span></div>
        {order.payMethod === "Cash" && <><div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}><span>Cash Given</span><span>{fmtSAR(order.given)}</span></div><div style={{ display: "flex", justifyContent: "space-between", color: "#1A6B4A", fontWeight: 700 }}><span>Change</span><span>{fmtSAR(order.change)}</span></div></>}
        <hr style={{ border: "none", borderTop: "1px dashed #ccc", margin: "8px 0" }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "#6366f1", fontWeight: 700, letterSpacing: "0.1em", marginBottom: 6 }}>⬛ ZATCA PHASE 2 · QR CODE</div>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 6 }}>
            <div style={{ padding: 6, background: "#fff", border: "1.5px solid #e0e0e0", borderRadius: 8, display: "inline-block" }}>
              <QRCodeDisplay data={qrData} size={110} />
            </div>
          </div>
          <div style={{ fontSize: 9, color: "#aaa" }}>TLV Base64 encoded · Scan to verify</div>
          <div style={{ marginTop: 8, fontWeight: 700, fontSize: 13 }}>Thank you! شكراً لزيارتكم</div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Btn variant="ghost" onClick={onClose} style={{ flex: 1 }}>Close</Btn>
          <Btn variant="primary" onClick={handleThermalPrint} style={{ flex: 1 }}>🖨️ Print Receipt</Btn>
        </div>
        {/* Hidden iframe used for printing — avoids popup window & prints QR correctly */}
        <iframe ref={printFrameRef} style={{ display: "none", width: 0, height: 0, border: "none" }} title="print-frame" />
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// POS SCREEN — Takeaway default + customer details
// ═══════════════════════════════════════════════════════════════════
function POS({ items, sales, setSales, tables, setTables, promos, license }) {
  const POS_CATS = ["BROAST", "DRINKS", "COMBOS"];
  const allCats = [...new Set(items.map(i => i.category))];
  const catMap = { "BROAST": "Broasted", "DRINKS": "Drinks", "COMBOS": "Combos" };
  const displayCats = [...POS_CATS, ...allCats.filter(c => !Object.values(catMap).includes(c))];
  const [activeCat, setActiveCat] = useState("BROAST");
  const [cart, setCart] = useState([]);
  const [orderType, setOrderType] = useState("takeaway"); // DEFAULT = takeaway
  const [selectedTable, setSelectedTable] = useState(null);
  const [showPayment, setShowPayment] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const [notif, setNotif] = useState(null);
  const [vno, setVno] = useState(() => LS.get("restopos_vno") || 1);
  const [kotNo, setKotNo] = useState(() => LS.get("restopos_kot") || 1);
  const [selectedRow, setSelectedRow] = useState(null);
  // Customer details (optional)
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  // Barcode scanner input
  const barcodeRef = useRef();
  const [barcodeInput, setBarcodeInput] = useState("");

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const vat = subtotal * 0.15;
  const total = subtotal + vat;

  function addToCart(item) { setCart(prev => { const ex = prev.find(c => c.id === item.id); if (ex) return prev.map(c => c.id === item.id ? { ...c, qty: c.qty + 1 } : c); return [...prev, { ...item, qty: 1 }]; }); showN("+ " + item.name); }
  function updateQty(delta) { if (selectedRow === null) return; setCart(prev => prev.map((c, i) => i === selectedRow ? { ...c, qty: Math.max(0, c.qty + delta) } : c).filter(c => c.qty > 0)); }
  function showN(msg) { setNotif(msg); setTimeout(() => setNotif(null), 1500); }

  function handleBarcodeSearch(code) {
    const item = items.find(i => i.barcode === code.trim());
    if (item) { addToCart(item); setBarcodeInput(""); }
    else { showN("❌ Barcode not found"); setBarcodeInput(""); }
  }

  function confirmPayment(method, given, change, promo, promoDiscount) {
    const inv = { id: "INV-" + vno, date: TODAY, time: new Date().toLocaleTimeString("en-SA", { hour: "2-digit", minute: "2-digit" }), type: orderType === "dine-in" ? "Dine-in" : orderType === "takeaway" ? "Takeaway" : "Delivery", table: selectedTable, customer: customerName, customerPhone, customerAddress, items: [...cart], subtotal, discount: promoDiscount || 0, vat, total: total - (promoDiscount || 0), status: "completed", cashier: "Admin", payMethod: method, given, change };
    setSales(prev => [...prev, inv]);
    setLastOrder(inv);
    if (selectedTable) setTables(prev => prev.map(t => t.id === selectedTable ? { ...t, status: "occupied" } : t));
    setCart([]); setCustomerName(""); setCustomerPhone(""); setCustomerAddress(""); setSelectedTable(null); setSelectedRow(null);
    setVno(v => { const n = v + 1; LS.set("restopos_vno", n); return n; });
    setKotNo(k => { const n = k + 1; LS.set("restopos_kot", n); return n; });
    setShowPayment(false); setShowReceipt(true);
  }

  const CARD_THEMES = {
    "BROAST": { bg: "linear-gradient(145deg,#1A3A5C,#0F2340)", border: "#2A5A8C", price: "#F0C040", name: "#FFFFFF", nameAr: "rgba(255,255,255,0.65)" },
    "DRINKS": { bg: "linear-gradient(145deg,#1A5C3A,#0F3A22)", border: "#2A8C5A", price: "#6EFFC0", name: "#FFFFFF", nameAr: "rgba(255,255,255,0.65)" },
    "COMBOS": { bg: "linear-gradient(145deg,#5C3A1A,#3A220F)", border: "#8C5A2A", price: "#FFD580", name: "#FFFFFF", nameAr: "rgba(255,255,255,0.65)" },
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
        <div style={{ width: "clamp(300px, 28vw, 420px)", background: "#fff", borderRight: "1px solid #D0D8E4", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          {/* Header info */}
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #E8EDF2", background: "#F8FAFC" }}>
            <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#5A7A9A", marginBottom: 6 }}>
              <span><strong style={{ color: "#1A3A5C" }}>VNO:</strong> {vno}</span>
              <span><strong style={{ color: "#1A3A5C" }}>KOT:</strong> {kotNo}</span>
              <span><strong style={{ color: "#1A3A5C" }}>Daily:</strong> {sales.filter(s => s.date === TODAY).length + 1}</span>
              <span style={{ marginLeft: "auto", color: "#1A3A5C", fontWeight: 700 }}>{now.toLocaleTimeString("en-SA", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            {/* Customer details — optional */}
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Customer name (optional)" style={{ padding: "5px 9px", border: "1px solid #D0D8E4", borderRadius: 6, fontSize: 11, fontFamily: "inherit" }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                <input value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="Phone (optional)" style={{ padding: "5px 9px", border: "1px solid #D0D8E4", borderRadius: 6, fontSize: 11, fontFamily: "inherit" }} />
                <input value={customerAddress} onChange={e => setCustomerAddress(e.target.value)} placeholder="Address (optional)" style={{ padding: "5px 9px", border: "1px solid #D0D8E4", borderRadius: 6, fontSize: 11, fontFamily: "inherit" }} />
              </div>
            </div>
            {/* Barcode scanner input */}
            <input ref={barcodeRef} value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleBarcodeSearch(barcodeInput); }} placeholder="🔲 Scan barcode or type & press Enter" style={{ marginTop: 5, width: "100%", padding: "5px 9px", border: "1px solid #6366f130", borderRadius: 6, fontSize: 11, fontFamily: "inherit", background: "#eef2ff" }} />
          </div>

          {/* Order type */}
          <div style={{ display: "flex", borderBottom: "1px solid #E8EDF2" }}>
            {[["takeaway", "🥡", "Takeaway"], ["dine-in", "🍽", "Dine-in"], ["delivery", "🛵", "Delivery"]].map(([t, icon, label]) => (
              <button key={t} onClick={() => setOrderType(t)} style={{ flex: 1, padding: "8px 4px", border: "none", background: orderType === t ? "#1A3A5C" : "#fff", color: orderType === t ? "#fff" : "#5A7A9A", fontFamily: "inherit", fontSize: 11, fontWeight: 700, cursor: "pointer", borderRight: "1px solid #E8EDF2" }}>{icon} {label}</button>
            ))}
          </div>

          {/* Table selector — only for dine-in */}
          {orderType === "dine-in" && (
            <div style={{ padding: "7px 12px", borderBottom: "1px solid #E8EDF2", background: "#F8FAFC" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#5A7A9A", marginBottom: 5 }}>TABLE</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {tables.map(t => <div key={t.id} onClick={() => setSelectedTable(t.id)} style={{ width: 28, height: 28, borderRadius: 6, border: `1.5px solid ${selectedTable === t.id ? "#1A3A5C" : t.status === "occupied" ? "#D94040" : "#D0D8E4"}`, background: selectedTable === t.id ? "#1A3A5C" : t.status === "occupied" ? "#FDE8E8" : "#fff", color: selectedTable === t.id ? "#fff" : t.status === "occupied" ? "#D94040" : "#5A7A9A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>{t.id}</div>)}
              </div>
            </div>
          )}

          {/* Cart header */}
          <div style={{ display: "grid", gridTemplateColumns: "24px 1fr 46px 56px 66px 18px", gap: 4, padding: "5px 12px", background: "#1A3A5C", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.8)", letterSpacing: "0.05em" }}>
            <span>#</span><span>ITEM</span><span>QTY</span><span>RATE</span><span>AMT</span><span>×</span>
          </div>

          {/* Cart items */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {cart.length === 0 ? <div style={{ textAlign: "center", color: "#B0B8C4", paddingTop: 30, fontSize: 13 }}>No items added</div>
              : cart.map((item, i) => (
                <div key={item.id} onClick={() => setSelectedRow(i)} style={{ display: "grid", gridTemplateColumns: "24px 1fr 46px 56px 66px 18px", gap: 4, padding: "6px 12px", background: selectedRow === i ? "#EEF4FF" : i % 2 === 0 ? "#fff" : "#F8FAFC", borderBottom: "1px solid #EEF2F8", cursor: "pointer", alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: "#5A7A9A" }}>{i + 1}</span>
                  <div><div style={{ fontSize: 12, fontWeight: 600, color: "#1A2A3A" }}>{item.name}</div><div style={{ fontSize: 9, color: "#9AA8B8" }}>{item.nameAr}</div></div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#1A3A5C", textAlign: "center" }}>{item.qty}</span>
                  <span style={{ fontSize: 11, color: "#5A7A9A", textAlign: "right" }}>{item.price.toFixed(2)}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#1A6B4A", textAlign: "right" }}>{(item.price * item.qty).toFixed(2)}</span>
                  <button onClick={e => { e.stopPropagation(); setCart(prev => prev.filter((_, j) => j !== i)); }} style={{ background: "none", border: "none", color: "#D94040", cursor: "pointer", fontSize: 13, fontWeight: 800, padding: 0 }}>×</button>
                </div>
              ))}
          </div>

          {/* +/- */}
          <div style={{ padding: "7px 12px", borderTop: "1px solid #E8EDF2", display: "flex", gap: 8, background: "#F8FAFC" }}>
            <button onClick={() => updateQty(1)} style={{ width: 40, height: 40, background: "#1A6B4A", color: "#fff", border: "none", borderRadius: 10, fontSize: 20, fontWeight: 800, cursor: "pointer" }}>+</button>
            <button onClick={() => updateQty(-1)} style={{ width: 40, height: 40, background: "#D94040", color: "#fff", border: "none", borderRadius: 10, fontSize: 20, fontWeight: 800, cursor: "pointer" }}>−</button>
          </div>

          {/* Totals */}
          <div style={{ padding: "8px 12px", borderTop: "1px solid #E8EDF2", background: "#F8FAFC" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5A7A9A", marginBottom: 2 }}><span>Gross</span><span>{subtotal.toFixed(2)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#5A7A9A", marginBottom: 4 }}><span>VAT 15%</span><span>{vat.toFixed(2)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, fontWeight: 900, color: "#D94040" }}><span></span><span>{total.toFixed(2)}</span></div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderTop: "1px solid #D0D8E4" }}>
            {[{ label: "Print", bg: "#1A6B4A", action: () => { if (cart.length) setShowPayment(true); else showN("Add items first"); } }, { label: "Clear", bg: "#E07B00", action: () => { setCart([]); setSelectedRow(null); setCustomerName(""); setCustomerPhone(""); setCustomerAddress(""); } }, { label: "Close", bg: "#5A6070", action: () => { setCart([]); setSelectedRow(null); } }].map(({ label, bg, action }) => (
              <button key={label} onClick={action} style={{ padding: "13px 0", background: bg, color: "#fff", border: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>{label}</button>
            ))}
          </div>
        </div>

        {/* RIGHT PANEL — Item Grid */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "8px 10px", background: "#1A2A3C", display: "flex", flexWrap: "wrap", gap: 5 }}>
            {displayCats.map(cat => <button key={cat} onClick={() => setActiveCat(cat)} style={{ padding: "8px 16px", background: activeCat === cat ? "#F0C040" : "rgba(255,255,255,0.1)", color: activeCat === cat ? "#1A2A3C" : "#fff", border: `1.5px solid ${activeCat === cat ? "#F0C040" : "rgba(255,255,255,0.2)"}`, borderRadius: 8, fontFamily: "inherit", fontSize: 12, fontWeight: 800, cursor: "pointer", textTransform: "uppercase" }}>{cat}</button>)}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 7, alignContent: "start" }}>
            {catItems.map(item => (
              <div key={item.id} onClick={() => addToCart(item)} style={{ background: theme.bg, border: `1.5px solid ${theme.border}`, borderRadius: 10, padding: "10px 11px", cursor: "pointer", minHeight: 82, display: "flex", flexDirection: "column", justifyContent: "space-between", transition: "transform 0.1s", position: "relative" }}
                onMouseOver={e => e.currentTarget.style.transform = "translateY(-2px)"}
                onMouseOut={e => e.currentTarget.style.transform = "none"}>
                <div style={{ fontSize: 11, fontWeight: 800, color: theme.price }}>SR{item.price.toFixed(2)}</div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: theme.name, lineHeight: 1.2, textTransform: "uppercase" }}>{item.name}</div>
                  <div style={{ fontSize: 9, color: theme.nameAr, direction: "rtl", marginTop: 2 }}>{item.nameAr}</div>
                </div>
                {cart.find(c => c.id === item.id) && <div style={{ position: "absolute", top: 5, right: 5, background: "#F0C040", color: "#1A2A3C", width: 17, height: 17, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 900 }}>{cart.find(c => c.id === item.id)?.qty}</div>}
              </div>
            ))}
          </div>
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
  const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); const ds = d.toISOString().split("T")[0]; return { label: d.toLocaleDateString("en", { weekday: "short" }), rev: sales.filter(s => s.date === ds).reduce((s, o) => s + o.total, 0) }; });
  const maxRev = Math.max(...last7.map(d => d.rev), 1);
  const topItems = items.map(it => ({ ...it, sold: todaySales.reduce((s, o) => s + (o.items.find(i => i.id === it.id)?.qty || 0), 0) })).sort((a, b) => b.sold - a.sold).slice(0, 5);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ background: "linear-gradient(135deg,#1A3A5C,#1A6B4A)", borderRadius: 12, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div><div style={{ color: "#fff", fontSize: 16, fontWeight: 800 }}>{license.businessName}</div><div style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>TRN: {license.vatNumber} · CR: {license.crNumber} · {license.city}</div></div>
        <div style={{ display: "flex", gap: 8 }}><span style={{ background: "rgba(255,255,255,0.15)", color: "#fff", padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>⬛ ZATCA Phase 2</span><span style={{ background: "rgba(26,138,74,0.4)", color: "#6EFFC0", padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>● Licensed</span></div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>Good morning 👋</div><div style={{ fontSize: 13, color: C.textMid }}>{new Date().toLocaleDateString("en-SA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div></div>
        <Badge color={C.success} bg={C.successLight}>● LIVE</Badge>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 16 }}>
        <StatCard icon="💰" label="Today's Revenue" value={fmtSAR(todayRev)} sub={`${growth > 0 ? "+" : ""}${growth}% vs yesterday`} color={C.primary} bg={C.primaryLight} />
        <StatCard icon="🧾" label="Orders Today" value={todaySales.length} color={C.info} bg={C.infoLight} />
        <StatCard icon="📊" label="VAT Collected" value={fmtSAR(todayVAT)} sub="15% ZATCA" color={C.accent} bg={C.accentLight} />
        <StatCard icon="🪑" label="Active Tables" value={TABLES_INIT.filter(t => t.status === "occupied").length + " / " + TABLES_INIT.length} color={C.warning} bg={C.warningLight} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Revenue — Last 7 Days</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 110 }}>
            {last7.map((d, i) => <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}><div style={{ width: "100%", background: i === 6 ? C.primary : C.primaryLight, borderRadius: "4px 4px 0 0", height: Math.max(4, (d.rev / maxRev) * 90) + "px" }} /><span style={{ fontSize: 10, color: C.textLight }}>{d.label}</span></div>)}
          </div>
        </Card>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Top Items Today</div>
          {topItems.map((it, i) => <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}><span style={{ fontSize: 11, fontWeight: 700, color: C.textLight, width: 16 }}>#{i + 1}</span><div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{it.name}</div><div style={{ height: 4, background: C.border, borderRadius: 2, marginTop: 3 }}><div style={{ height: "100%", background: C.primary, borderRadius: 2, width: (it.sold / (topItems[0]?.sold || 1) * 100) + "%" }} /></div></div><span style={{ fontSize: 12, fontWeight: 700, color: C.primary }}>{it.sold} sold</span></div>)}
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SECURITY TAB — Admin can change PIN for all roles
// ═══════════════════════════════════════════════════════════════════
function SecurityTab({ pins, setPins }) {
  const ROLE_META = [
    { id: "Admin", icon: "👑", color: C.danger, desc: "Full access to all screens" },
    { id: "Manager", icon: "🧑‍💼", color: C.warning, desc: "Reports, menu & settings" },
    { id: "Cashier", icon: "🧑‍💻", color: C.info, desc: "POS billing only" },
  ];
  const [drafts, setDrafts] = useState({ Admin: "", Manager: "", Cashier: "" });
  const [confirms, setConfirms] = useState({ Admin: "", Manager: "", Cashier: "" });
  const [saved, setSaved] = useState({ Admin: false, Manager: false, Cashier: false });
  const [errors, setErrors] = useState({ Admin: "", Manager: "", Cashier: "" });

  function savePin(role) {
    const d = drafts[role]; const c = confirms[role];
    if (!/^\d{4}$/.test(d)) return setErrors(e => ({ ...e, [role]: "PIN must be exactly 4 digits." }));
    if (d !== c) return setErrors(e => ({ ...e, [role]: "PINs do not match." }));
    const newPins = { ...pins, [role]: d };
    setPins(newPins);
    LS.set("restopos_pins", newPins);
    setSaved(s => ({ ...s, [role]: true }));
    setDrafts(v => ({ ...v, [role]: "" }));
    setConfirms(v => ({ ...v, [role]: "" }));
    setErrors(e => ({ ...e, [role]: "" }));
    setTimeout(() => setSaved(s => ({ ...s, [role]: false })), 3000);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 520 }}>
      <Card>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>🔐 Change Role PINs</div>
        <div style={{ fontSize: 12, color: C.textMid, marginBottom: 20 }}>As Admin, you can change the 4-digit PIN for any role. Current PINs are shown masked.</div>
        {ROLE_META.map(r => (
          <div key={r.id} style={{ marginBottom: 24, padding: "16px", background: C.bg, borderRadius: 12, border: `1.5px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 22 }}>{r.icon}</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{r.id}</div>
                <div style={{ fontSize: 11, color: C.textMid }}>{r.desc}</div>
              </div>
              <div style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 18, color: C.textLight, letterSpacing: "0.3em" }}>{"●".repeat(4)}</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <Inp label="New PIN (4 digits)" value={drafts[r.id]} onChange={v => { if (/^\d{0,4}$/.test(v)) { setDrafts(d => ({ ...d, [r.id]: v })); setSaved(s => ({ ...s, [r.id]: false })); setErrors(e => ({ ...e, [r.id]: "" })); } }} placeholder="••••" type="password" />
              <Inp label="Confirm New PIN" value={confirms[r.id]} onChange={v => { if (/^\d{0,4}$/.test(v)) { setConfirms(c => ({ ...c, [r.id]: v })); setErrors(e => ({ ...e, [r.id]: "" })); } }} placeholder="••••" type="password" />
            </div>
            {errors[r.id] && <div style={{ fontSize: 12, color: C.danger, marginBottom: 8, fontWeight: 600 }}>⚠️ {errors[r.id]}</div>}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Btn size="sm" onClick={() => savePin(r.id)} disabled={!drafts[r.id] || !confirms[r.id]}>💾 Save {r.id} PIN</Btn>
              {saved[r.id] && <span style={{ fontSize: 12, color: C.success, fontWeight: 700 }}>✓ PIN updated!</span>}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SETTINGS — company locked, printer connection
// ═══════════════════════════════════════════════════════════════════
function Settings({ company, setCompany, tables, setTables, license, onClearLicense, pins, setPins }) {
  const [tab, setTab] = useState("company");
  const [newTableCount, setNewTableCount] = useState(tables.length);
  const [companySaved, setCompanySaved] = useState(false);
  const tabs = [["company", "🏢 Company"], ["tables", "🪑 Tables"], ["printers", "🖨️ Printers"], ["security", "🔐 Security"], ["license", "📋 License"]];


  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>

      {tab === "company" && <Card style={{ maxWidth: 640 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>Company Settings</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Inp label="Business Name (locked)" value={license.businessName} onChange={() => {}} readOnly />
          <Inp label="CR Number (locked)" value={license.crNumber} onChange={() => {}} readOnly />
          <Inp label="VAT / TRN (locked)" value={license.vatNumber} onChange={() => {}} readOnly />
          <Inp label="License Key (locked)" value={license.licenseKey} onChange={() => {}} readOnly />
          <Inp label="Phone" value={company.phone || ""} onChange={v => { setCompany(c => ({ ...c, phone: v })); setCompanySaved(false); }} placeholder="+966 50 000 0000" />
          <Inp label="Email" value={company.email || ""} onChange={v => { setCompany(c => ({ ...c, email: v })); setCompanySaved(false); }} placeholder="info@restaurant.com" />
          <Inp label="City" value={company.city || ""} onChange={v => { setCompany(c => ({ ...c, city: v })); setCompanySaved(false); }} />
        </div>
        <Inp label="Address" value={company.address || ""} onChange={v => { setCompany(c => ({ ...c, address: v })); setCompanySaved(false); }} style={{ marginTop: 14 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <Btn onClick={() => { LS.set("restopos_company", company); setCompanySaved(true); }}>💾 Save Settings</Btn>
          {companySaved && <span style={{ fontSize: 12, color: C.success, fontWeight: 700 }}>✓ Saved successfully</span>}
        </div>
      </Card>}

      {tab === "tables" && <Card style={{ maxWidth: 500 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Table Configuration</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 20, alignItems: "flex-end" }}>
          <Inp label="Number of Tables" value={newTableCount} onChange={v => setNewTableCount(parseInt(v) || 1)} type="number" />
          <Btn onClick={() => setTables(Array.from({ length: newTableCount }, (_, i) => ({ id: i + 1, status: "free", capacity: 4 })))}>Update</Btn>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {tables.map(t => <div key={t.id} onClick={() => setTables(prev => prev.map(x => x.id === t.id ? { ...x, status: x.status === "occupied" ? "free" : "occupied" } : x))} style={{ width: 44, height: 44, borderRadius: 8, border: `2px solid ${t.status === "occupied" ? C.danger : C.success}`, background: t.status === "occupied" ? C.dangerLight : C.successLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: t.status === "occupied" ? C.danger : C.success, cursor: "pointer" }}>{t.id}</div>)}
        </div>
      </Card>}

      {tab === "printers" && <Card style={{ maxWidth: 560 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>🖨️ Thermal Printer Setup</div>
        <div style={{ background: C.successLight, border: `1px solid ${C.success}`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: C.success, fontWeight: 600 }}>
          ✅ RestoPOS uses a dedicated thermal print window — no browser print dialog, no confirmations.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[
            ["Paper Width", "80mm (standard thermal roll)"],
            ["Print Method", "Opens a separate window → auto-prints → closes"],
            ["Ink Color", "Black on white — full contrast, readable on thermal paper"],
            ["Required Setting", "Allow pop-ups from this site in your browser"],
            ["USB / Network", "Set your thermal printer as the default printer in Windows/macOS"],
            ["Bluetooth", "Pair printer first via OS settings, then set as default"],
          ].map(([k, v]) => <div key={k} style={{ display: "flex", gap: 12, padding: "10px 14px", background: C.bg, borderRadius: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.textMid, width: 130, flexShrink: 0 }}>{k}</span>
            <span style={{ fontSize: 13 }}>{v}</span>
          </div>)}
        </div>
        <div style={{ marginTop: 16, padding: "12px 14px", background: C.warningLight, border: `1px solid ${C.warning}30`, borderRadius: 10, fontSize: 12, color: C.warning, fontWeight: 600 }}>
          ⚠️ If print window doesn't open: Click the address bar area — look for a "Pop-up blocked" icon and click "Allow".
        </div>
      </Card>}

      {tab === "security" && <SecurityTab pins={pins} setPins={setPins} />}

      {tab === "license" && <Card style={{ maxWidth: 520 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>License Information</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[["Business Name", license.businessName], ["CR Number", license.crNumber], ["VAT / TRN", license.vatNumber], ["License Key", license.licenseKey], ["City", license.city], ["Activated", fmtDateTime(license.activatedAt)]].map(([k, v]) => <div key={k} style={{ display: "flex", gap: 16, padding: "10px 14px", background: C.bg, borderRadius: 8 }}><span style={{ fontSize: 12, fontWeight: 700, color: C.textMid, width: 120, flexShrink: 0 }}>{k}</span><span style={{ fontSize: 13, color: C.text, fontWeight: 600, fontFamily: ["CR Number", "VAT / TRN", "License Key"].includes(k) ? "monospace" : "inherit" }}>{v}</span></div>)}
        </div>
        <div style={{ marginTop: 20, padding: 14, background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.danger, marginBottom: 8 }}>⚠️ Reset License</div>
          <div style={{ fontSize: 12, color: C.danger, marginBottom: 12 }}>This will clear all saved license data and log you out.</div>
          <Btn variant="danger" size="sm" onClick={() => { if (confirm("Are you sure? This will clear the license and log you out.")) onClearLicense(); }}>Clear License & Re-Activate</Btn>
        </div>
      </Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CREATE — Menu Management with Barcode
// ═══════════════════════════════════════════════════════════════════
function Create({ items, setItems, promos, setPromos }) {
  const [tab, setTab] = useState("items");
  const [showItemModal, setShowItemModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [showBarcodeModal, setShowBarcodeModal] = useState(false);
  const [barcodeItem, setBarcodeItem] = useState(null);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [editPromo, setEditPromo] = useState(null);
  const [categories, setCategories] = useState(SEED_CATEGORIES);
  const [newCat, setNewCat] = useState("");
  const blankItem = { name: "", nameAr: "", category: categories[0], price: "", cost: "", stock: "", active: true, barcode: "" };
  const [itemForm, setItemForm] = useState(blankItem);
  const blankPromo = { code: "", type: "%", value: "", minOrder: 0, active: true };
  const [promoForm, setPromoForm] = useState(blankPromo);
  const barcodeRef = useRef();

  function openItemModal(it = null) { setEditItem(it); setItemForm(it ? { ...it } : { ...blankItem, category: categories[0] }); setShowItemModal(true); }
  function saveItem() {
    if (!itemForm.name || !itemForm.price) return alert("Name and price required");
    const item = { ...itemForm, price: parseFloat(itemForm.price), cost: parseFloat(itemForm.cost || 0), stock: parseInt(itemForm.stock || 0), id: editItem ? editItem.id : Date.now() };
    setItems(prev => editItem ? prev.map(i => i.id === editItem.id ? item : i) : [...prev, item]);
    setShowItemModal(false);
  }
  function openBarcodeModal(it) { setBarcodeItem(it); setBarcodeInput(it.barcode || ""); setShowBarcodeModal(true); setTimeout(() => barcodeRef.current?.focus(), 100); }
  function saveBarcode() { setItems(prev => prev.map(i => i.id === barcodeItem.id ? { ...i, barcode: barcodeInput.trim() } : i)); setShowBarcodeModal(false); alert("Barcode saved! You can now scan this item at POS."); }
  function openPromoModal(p = null) { setEditPromo(p); setPromoForm(p ? { ...p } : { ...blankPromo }); setShowPromoModal(true); }
  function savePromo() { if (!promoForm.code || !promoForm.value) return alert("Code and value required"); const promo = { ...promoForm, value: parseFloat(promoForm.value), minOrder: parseFloat(promoForm.minOrder || 0), id: editPromo ? editPromo.id : Date.now() }; setPromos(prev => editPromo ? prev.map(p => p.id === editPromo.id ? promo : p) : [...prev, promo]); setShowPromoModal(false); }

  const tabs = [["items", "🍔 Items"], ["categories", "📂 Categories"], ["promos", "🏷️ Promos"]];
  return (
    <div>
      {showItemModal && <Modal title={editItem ? "Edit Item" : "New Menu Item"} onClose={() => setShowItemModal(false)}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Inp label="Item Name *" value={itemForm.name} onChange={v => setItemForm(f => ({ ...f, name: v }))} placeholder="Chicken Burger" />
          <Inp label="Arabic Name" value={itemForm.nameAr} onChange={v => setItemForm(f => ({ ...f, nameAr: v }))} placeholder="برجر دجاج" />
          <Sel label="Category" value={itemForm.category} onChange={v => setItemForm(f => ({ ...f, category: v }))} options={categories} />
          <Inp label="Barcode" value={itemForm.barcode} onChange={v => setItemForm(f => ({ ...f, barcode: v }))} placeholder="Scan or type barcode" />
          <Inp label="Price (SAR) *" value={itemForm.price} onChange={v => setItemForm(f => ({ ...f, price: v }))} type="number" />
          <Inp label="Cost (SAR)" value={itemForm.cost} onChange={v => setItemForm(f => ({ ...f, cost: v }))} type="number" />
          <Inp label="Stock" value={itemForm.stock} onChange={v => setItemForm(f => ({ ...f, stock: v }))} type="number" />
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 20 }}><input type="checkbox" checked={itemForm.active} onChange={e => setItemForm(f => ({ ...f, active: e.target.checked }))} id="activeItem" /><label htmlFor="activeItem" style={{ fontSize: 13 }}>Active</label></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <Btn variant="ghost" onClick={() => setShowItemModal(false)} style={{ flex: 1 }}>Cancel</Btn>
          <Btn onClick={saveItem} style={{ flex: 1 }}>Save Item</Btn>
        </div>
      </Modal>}

      {showBarcodeModal && barcodeItem && <Modal title={`🔲 Add Barcode — ${barcodeItem.name}`} onClose={() => setShowBarcodeModal(false)} width={420}>
        <div style={{ fontSize: 13, color: C.textMid, marginBottom: 16 }}>Scan the barcode with your scanner or type it manually. Press Enter or click Save.</div>
        <input ref={barcodeRef} value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveBarcode(); }} placeholder="Scan barcode here…" style={{ width: "100%", padding: "14px 16px", border: `2px solid ${C.zatca}`, borderRadius: 10, fontSize: 18, fontFamily: "monospace", fontWeight: 700, textAlign: "center", color: C.text, background: C.zatcaLight }} autoFocus />
        <div style={{ fontSize: 11, color: C.textLight, marginTop: 8, textAlign: "center" }}>USB and Bluetooth scanners work automatically — just scan!</div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <Btn variant="ghost" onClick={() => setShowBarcodeModal(false)} style={{ flex: 1 }}>Cancel</Btn>
          <Btn variant="zatca" onClick={saveBarcode} style={{ flex: 1 }}>Save Barcode</Btn>
        </div>
      </Modal>}

      {showPromoModal && <Modal title={editPromo ? "Edit Promo" : "New Promo"} onClose={() => setShowPromoModal(false)} width={420}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Inp label="Code" value={promoForm.code} onChange={v => setPromoForm(f => ({ ...f, code: v.toUpperCase() }))} placeholder="SAVE20" />
          <Sel label="Type" value={promoForm.type} onChange={v => setPromoForm(f => ({ ...f, type: v }))} options={[{ value: "%", label: "Percentage (%)" }, { value: "flat", label: "Flat (SAR)" }]} />
          <Inp label="Value" value={promoForm.value} onChange={v => setPromoForm(f => ({ ...f, value: v }))} type="number" />
          <Inp label="Min Order (SAR)" value={promoForm.minOrder} onChange={v => setPromoForm(f => ({ ...f, minOrder: v }))} type="number" />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={promoForm.active} onChange={e => setPromoForm(f => ({ ...f, active: e.target.checked }))} id="pa" /><label htmlFor="pa" style={{ fontSize: 13 }}>Active</label></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <Btn variant="ghost" onClick={() => setShowPromoModal(false)} style={{ flex: 1 }}>Cancel</Btn>
          <Btn onClick={savePromo} style={{ flex: 1 }}>Save</Btn>
        </div>
      </Modal>}

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>

      {tab === "items" && <Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Menu Items ({items.length})</div>
          <Btn size="sm" onClick={() => openItemModal()}>+ New Item</Btn>
        </div>
        <DataTable headers={["Name", "Category", "Price", "Stock", "Barcode", "Status", "Actions"]}
          rows={items.map(it => [
            it.name,
            <Badge color={C.info} bg={C.infoLight}>{it.category}</Badge>,
            <strong style={{ color: C.primary }}>{fmtSAR(it.price)}</strong>,
            it.stock,
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {it.barcode ? <span style={{ fontFamily: "monospace", fontSize: 11, color: C.zatca }}>{it.barcode}</span> : <span style={{ color: C.textLight, fontSize: 11 }}>None</span>}
              <button onClick={() => openBarcodeModal(it)} style={{ background: C.zatcaLight, border: `1px solid ${C.zatca}30`, color: C.zatca, padding: "2px 7px", borderRadius: 5, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>🔲 {it.barcode ? "Edit" : "Add"}</button>
            </div>,
            <Badge color={it.active ? C.success : C.danger} bg={it.active ? C.successLight : C.dangerLight}>{it.active ? "Active" : "Off"}</Badge>,
            <div style={{ display: "flex", gap: 5 }}>
              <Btn size="sm" variant="ghost" onClick={() => openItemModal(it)}>Edit</Btn>
              <Btn size="sm" variant="danger" onClick={() => { if (confirm("Delete?")) setItems(prev => prev.filter(i => i.id !== it.id)); }}>Del</Btn>
            </div>
          ])} />
      </Card>}
      {tab === "categories" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Categories</div><div style={{ display: "flex", gap: 10, marginBottom: 20 }}><input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category" style={{ flex: 1, padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} /><Btn onClick={() => { if (newCat.trim()) { setCategories(prev => [...prev, newCat.trim()]); setNewCat(""); } }}>Add</Btn></div><div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>{categories.map(cat => <div key={cat} style={{ padding: "8px 16px", background: C.primaryLight, borderRadius: 8, fontSize: 13, fontWeight: 600, color: C.primary, display: "flex", alignItems: "center", gap: 8 }}>{cat}<button onClick={() => setCategories(prev => prev.filter(c => c !== cat))} style={{ background: "none", border: "none", color: C.danger, cursor: "pointer", fontSize: 14 }}>×</button></div>)}</div></Card>}
      {tab === "promos" && <Card><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}><div style={{ fontSize: 15, fontWeight: 700 }}>Promo Codes</div><Btn size="sm" onClick={() => openPromoModal()}>+ New</Btn></div><DataTable headers={["Code", "Type", "Value", "Min Order", "Status", "Actions"]} rows={promos.map(p => [<strong style={{ fontFamily: "monospace", color: C.primary }}>{p.code}</strong>, p.type === "%" ? "%" : "Flat", p.type === "%" ? p.value + "%" : fmtSAR(p.value), p.minOrder > 0 ? fmtSAR(p.minOrder) : "None", <Badge color={p.active ? C.success : C.danger} bg={p.active ? C.successLight : C.dangerLight}>{p.active ? "Active" : "Off"}</Badge>, <div style={{ display: "flex", gap: 5 }}><Btn size="sm" variant="ghost" onClick={() => openPromoModal(p)}>Edit</Btn><Btn size="sm" variant="danger" onClick={() => setPromos(prev => prev.filter(x => x.id !== p.id))}>Del</Btn></div>])} emptyMsg="No promos yet" /></Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TRANSACTIONS — with search + print per bill
// ═══════════════════════════════════════════════════════════════════
function reprintReceipt(sale, license) {
  const qrData = generateZATCABase64({ sellerName: license.businessName, vatNumber: license.vatNumber, timestamp: new Date().toISOString(), total: sale.total, vatAmount: sale.vat });
  const win = window.open("", "_blank", "width=340,height=700,scrollbars=yes");
  if (!win) { alert("Pop-up blocked. Please allow pop-ups."); return; }
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${sale.id}</title>
<style>
  @page{size:80mm auto;margin:0}*{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Courier New',monospace;font-size:12px;color:#000;background:#fff;width:80mm;padding:4mm}
  .center{text-align:center}.bold{font-weight:bold}.big{font-size:16px;font-weight:bold}
  .hr{border:none;border-top:1px dashed #000;margin:6px 0}
  .row{display:flex;justify-content:space-between;margin:2px 0}
  .row-total{display:flex;justify-content:space-between;margin:4px 0;font-size:15px;font-weight:900;border-top:2px solid #000;padding-top:4px}
  .item-name{flex:1}.item-amt{white-space:nowrap;margin-left:4px}
  .qr-wrap{text-align:center;margin:8px 0}.zatca-label{font-size:9px;font-weight:bold;letter-spacing:0.1em}
  .ar{font-family:Arial,sans-serif;direction:rtl;text-align:right;font-size:10px}
  @media print{body{width:80mm}}
</style></head><body>
<div class="center">
  <div class="big">${sale.businessName || license.businessName}</div>
  <div>${license.address || ""}</div>
  <div>TRN: ${license.vatNumber}</div>
  <div>${sale.id} | ${sale.date} ${sale.time}</div>
  ${sale.customer ? `<div>Customer: ${sale.customer}</div>` : ""}
  ${sale.customerPhone ? `<div>Phone: ${sale.customerPhone}</div>` : ""}
  <div>${sale.type}${sale.table ? ` · Table ${sale.table}` : ""}</div>
  <div>Cashier: ${sale.cashier || "Admin"}</div>
</div>
<hr class="hr"/>
${(sale.items||[]).map(it => `<div class="row"><span class="item-name">${it.name}${it.nameAr ? `<span class="ar">${it.nameAr}</span>` : ""}<br/><small>${it.qty} x ${it.price.toFixed(2)}</small></span><span class="item-amt">${(it.qty*it.price).toFixed(2)}</span></div>`).join("")}
<hr class="hr"/>
<div class="row"><span>Subtotal</span><span>SAR ${(sale.subtotal||0).toFixed(2)}</span></div>
${(sale.discount||0)>0?`<div class="row"><span>Discount</span><span>-SAR ${sale.discount.toFixed(2)}</span></div>`:""}
<div class="row"><span>VAT 15%</span><span>SAR ${(sale.vat||0).toFixed(2)}</span></div>
<div class="row-total"><span>TOTAL</span><span>SAR ${(sale.total||0).toFixed(2)}</span></div>
${sale.payMethod==="Cash"?`<div class="row"><span>Cash Given</span><span>SAR ${Number(sale.given||0).toFixed(2)}</span></div><div class="row bold"><span>Change</span><span>SAR ${Number(sale.change||0).toFixed(2)}</span></div>`:`<div class="row bold"><span>Payment</span><span>${sale.payMethod}</span></div>`}
<hr class="hr"/>
<div id="qr-placeholder" style="text-align:center;margin:8px 0">
  <canvas id="qr-canvas"></canvas>
  <div class="zatca-label">ZATCA PHASE 2 · QR CODE</div>
  <div style="font-size:8px">TLV Base64 · Scan to verify</div>
</div>
<div class="bold center" style="margin-top:6px">Thank you for your visit!</div>
<div class="ar center bold" style="font-family:Arial,sans-serif;direction:rtl;text-align:center;margin-top:3px">شكراً لزيارتكم</div>
<br/><br/>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  var qrData=${JSON.stringify(qrData)};
  function doQR(){if(window.QRCode){try{new QRCode(document.getElementById("qr-canvas"),{text:qrData,width:100,height:100,colorDark:"#000000",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.M});}catch(e){}setTimeout(function(){window.print();window.close();},800);}else{setTimeout(doQR,200);}}
  window.onload=doQR;
</script></body></html>`;
  win.document.write(html);
  win.document.close();
}

function Transactions({ sales, setSales, license }) {
  const [tab, setTab] = useState("sales");
  const [dateFrom, setDateFrom] = useState(TODAY);
  const [dateTo, setDateTo] = useState(TODAY);
  const [search, setSearch] = useState("");
  const [refundTarget, setRefundTarget] = useState(null);

  const dateFiltered = sales.filter(s => s.date >= dateFrom && s.date <= dateTo);
  const filtered = search.trim()
    ? sales.filter(s =>
        s.id?.toLowerCase().includes(search.toLowerCase()) ||
        s.date?.includes(search) ||
        s.type?.toLowerCase().includes(search.toLowerCase()) ||
        s.cashier?.toLowerCase().includes(search.toLowerCase()) ||
        s.payMethod?.toLowerCase().includes(search.toLowerCase())
      )
    : dateFiltered;
  const total = filtered.reduce((s, o) => s + o.total, 0);
  const vat = filtered.reduce((s, o) => s + o.vat, 0);

  return (
    <div>
      {refundTarget && <Modal title="Process Refund" onClose={() => setRefundTarget(null)} width={420}>
        <div style={{ fontSize: 13, color: C.textMid, marginBottom: 16 }}>Refunding <strong style={{ color: C.primary }}>{refundTarget.id}</strong> — {fmtSAR(refundTarget.total)}</div>
        <div style={{ background: C.dangerLight, border: `1px solid ${C.danger}`, borderRadius: 8, padding: 12, fontSize: 13, color: C.danger, marginBottom: 20 }}>⚠️ This will mark the invoice as refunded.</div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="ghost" onClick={() => setRefundTarget(null)} style={{ flex: 1 }}>Cancel</Btn>
          <Btn variant="danger" onClick={() => { setSales(prev => prev.map(s => s.id === refundTarget.id ? { ...s, status: "refunded" } : s)); setRefundTarget(null); }} style={{ flex: 1 }}>Confirm</Btn>
        </div>
      </Modal>}

      {/* Search bar — always visible at top */}
      <Card style={{ marginBottom: 16, padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>🔍</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by invoice number, date, type, cashier, payment method…"
            style={{ flex: 1, padding: "9px 14px", border: `1.5px solid ${search ? C.primary : C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", outline: "none", background: search ? C.primaryLight : "#fff" }}
          />
          {search && <button onClick={() => setSearch("")} style={{ background: C.dangerLight, color: C.danger, border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✕ Clear</button>}
        </div>
        {search && <div style={{ fontSize: 12, color: C.textMid, marginTop: 8, paddingLeft: 28 }}>Found {filtered.length} result{filtered.length !== 1 ? "s" : ""} for "<strong>{search}</strong>"</div>}
      </Card>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {[["sales", "💳 Sales"], ["payments", "💰 Payments"], ["kot", "🍽 KOT"]].map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>

      {tab === "sales" && <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!search && <Card style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Inp label="From" value={dateFrom} onChange={setDateFrom} type="date" />
          <Inp label="To" value={dateTo} onChange={setDateTo} type="date" />
          <div style={{ marginLeft: "auto" }}><div style={{ fontSize: 12, color: C.textMid }}>{filtered.length} orders · VAT: {fmtSAR(vat)}</div><div style={{ fontSize: 20, fontWeight: 800, color: C.primary }}>{fmtSAR(total)}</div></div>
        </Card>}
        {filtered.length === 0
          ? <Card><div style={{ textAlign: "center", padding: "40px 0", color: C.textMid }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🧾</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{search ? "No invoices found" : "No orders yet"}</div>
              <div style={{ fontSize: 13, marginTop: 6, color: C.textLight }}>{search ? `Try a different search term` : "Orders you process at the POS will appear here"}</div>
            </div></Card>
          : <Card><DataTable headers={["Invoice", "Date", "Time", "Type", "Method", "Total", "Status", "Actions"]}
              rows={filtered.slice().reverse().slice(0, 100).map(s => [
                <span style={{ fontFamily: "monospace", fontSize: 12, color: C.primary, fontWeight: 700 }}>{s.id}</span>,
                s.date, s.time, s.type, s.payMethod,
                <strong>{fmtSAR(s.total)}</strong>,
                <Badge color={s.status === "completed" ? C.success : s.status === "voided" ? C.danger : s.status === "refunded" ? C.warning : C.warning} bg={s.status === "completed" ? C.successLight : s.status === "voided" ? C.dangerLight : C.warningLight}>{s.status}</Badge>,
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  <Btn size="sm" variant="outline" onClick={() => reprintReceipt(s, license)}>🖨️ Print</Btn>
                  {s.status === "completed" && <>
                    <Btn size="sm" variant="ghost" onClick={() => setRefundTarget(s)}>Refund</Btn>
                    <Btn size="sm" variant="danger" onClick={() => { if (confirm("Void this invoice?")) setSales(prev => prev.map(x => x.id === s.id ? { ...x, status: "voided" } : x)); }}>Void</Btn>
                  </>}
                </div>
              ])} emptyMsg="No orders found" /></Card>
        }
      </div>}
      {tab === "payments" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Payment Summary (Today)</div>{["Cash", "Mada", "Apple Pay", "STC Pay"].map(method => { const ms = sales.filter(s => s.date === TODAY && s.payMethod === method); return <div key={method} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ fontSize: 14, fontWeight: 600 }}>{method}</span><div style={{ textAlign: "right" }}><div style={{ fontSize: 16, fontWeight: 700, color: C.primary }}>{fmtSAR(ms.reduce((s, o) => s + o.total, 0))}</div><div style={{ fontSize: 11, color: C.textLight }}>{ms.length} transactions</div></div></div>; })}</Card>}
      {tab === "kot" && <Card>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>KOT Log (Today)</div>
        {sales.filter(s => s.date === TODAY).length === 0
          ? <div style={{ textAlign: "center", padding: "30px 0", color: C.textMid }}><div style={{ fontSize: 32, marginBottom: 8 }}>🍽</div><div>No KOTs today</div></div>
          : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 12 }}>
              {sales.filter(s => s.date === TODAY).slice().reverse().map(s => (
                <div key={s.id} style={{ border: "2px dashed #ccc", borderRadius: 8, padding: 14, fontFamily: "monospace", fontSize: 12 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{s.type}{s.table ? ` · T${s.table}` : ""} · {s.time}</div>
                  {(s.items||[]).slice(0, 4).map((it, idx) => <div key={idx}>{it.qty}× {it.name}</div>)}
                  <div style={{ marginTop: 6, fontSize: 10, color: C.textLight }}>{s.id}</div>
                </div>
              ))}
            </div>
        }
      </Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ACCOUNTS — 3 boxes: Total Sale, VAT Collected, Avg Sale %
// ═══════════════════════════════════════════════════════════════════
function Accounts({ sales }) {
  const [period, setPeriod] = useState("today");
  const now = new Date();

  const periodSales = sales.filter(s => {
    const d = new Date(s.date);
    if (period === "today") return s.date === TODAY;
    if (period === "week") { const w = new Date(); w.setDate(w.getDate() - 7); return d >= w; }
    if (period === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    return true;
  });

  const totalSale = periodSales.reduce((s, o) => s + o.total, 0);
  const vatCollected = periodSales.reduce((s, o) => s + o.vat, 0);

  // Average sale % = today's total vs average of previous 7 days
  const todayTotal = sales.filter(s => s.date === TODAY).reduce((s, o) => s + o.total, 0);
  const prev7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (i + 1));
    const ds = d.toISOString().split("T")[0];
    return sales.filter(s => s.date === ds).reduce((s, o) => s + o.total, 0);
  });
  const prev7avg = prev7.reduce((a, b) => a + b, 0) / 7;
  const avgPct = prev7avg > 0 ? (((todayTotal - prev7avg) / prev7avg) * 100).toFixed(1) : todayTotal > 0 ? "100.0" : "0.0";
  const avgUp = parseFloat(avgPct) >= 0;
  const periodLabel = { today: "Today", week: "Last 7 Days", month: "This Month", all: "All Time" }[period];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 10 }}>
        <div><div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>📈 Accounts</div><div style={{ fontSize: 13, color: C.textMid, marginTop: 2 }}>Period: {periodLabel} · {periodSales.length} orders</div></div>
        <div style={{ display: "flex", gap: 6 }}>
          {[["today", "Today"], ["week", "Week"], ["month", "Month"], ["all", "All"]].map(([id, label]) => (
            <button key={id} onClick={() => setPeriod(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${period === id ? C.primary : C.border}`, background: period === id ? C.primary : "#fff", color: period === id ? "#fff" : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 20 }}>
        {/* Box 1 — Total Sale */}
        <Card style={{ padding: 28, borderLeft: `5px solid ${C.primary}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.textMid, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>💰 Total Sale</div>
          <div style={{ fontSize: 34, fontWeight: 900, color: C.primary, lineHeight: 1 }}>{fmtSAR(totalSale)}</div>
          <div style={{ fontSize: 12, color: C.textLight, marginTop: 8 }}>Including VAT · {periodSales.length} orders</div>
        </Card>

        {/* Box 2 — VAT Collected */}
        <Card style={{ padding: 28, borderLeft: `5px solid ${C.zatca}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.textMid, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>⬛ VAT Collected</div>
          <div style={{ fontSize: 34, fontWeight: 900, color: C.zatca, lineHeight: 1 }}>{fmtSAR(vatCollected)}</div>
          <div style={{ fontSize: 12, color: C.textLight, marginTop: 8 }}>15% VAT · {periodLabel}</div>
        </Card>

        {/* Box 3 — Average Sale % */}
        <Card style={{ padding: 28, borderLeft: `5px solid ${avgUp ? C.success : C.danger}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.textMid, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>📊 Avg Sale vs Prev 7 Days</div>
          <div style={{ fontSize: 34, fontWeight: 900, color: avgUp ? C.success : C.danger, lineHeight: 1 }}>{avgUp ? "+" : ""}{avgPct}%</div>
          <div style={{ fontSize: 12, color: C.textLight, marginTop: 8 }}>Today: {fmtSAR(todayTotal)} · 7-day avg: {fmtSAR(prev7avg)}</div>
        </Card>
      </div>

      {periodSales.length === 0 && (
        <Card style={{ marginTop: 24, textAlign: "center", padding: "48px 0" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.textMid }}>No sales data for this period</div>
          <div style={{ fontSize: 13, color: C.textLight, marginTop: 6 }}>Process orders at the POS to see your figures here</div>
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// REPORTS — with Close Day + EOD start/end times
// ═══════════════════════════════════════════════════════════════════
function Reports({ sales, items, setSales }) {
  const [tab, setTab] = useState("summary");
  const [dateFrom, setDateFrom] = useState(TODAY);
  const [dateTo, setDateTo] = useState(TODAY);
  const [showCloseDay, setShowCloseDay] = useState(false);
  const dayLog = LS.get("restopos_daylog") || {};

  const filtered = sales.filter(s => s.date >= dateFrom && s.date <= dateTo);
  const todaySales = sales.filter(s => s.date === TODAY);

  function handleCloseDay() {
    const closeTime = new Date().toISOString();
    const firstSale = todaySales.length > 0 ? todaySales[0] : null;
    const startTime = firstSale ? `${firstSale.date}T${firstSale.time}:00` : closeTime;
    const log = { ...dayLog, [TODAY]: { startTime, closeTime, orderCount: todaySales.length, revenue: todaySales.reduce((s, o) => s + o.total, 0), vat: todaySales.reduce((s, o) => s + o.vat, 0) } };
    LS.set("restopos_daylog", log);
    setShowCloseDay(false);
    alert(`✅ Day closed at ${fmtDateTime(closeTime)}\nTotal orders: ${todaySales.length}`);
  }

  const todayLog = dayLog[TODAY];
  const catSales = [...new Set(items.map(i => i.category))].map(cat => { const catItems = items.filter(i => i.category === cat); return { cat, revenue: catItems.reduce((s, it) => s + filtered.reduce((ss, o) => ss + (o.items.find(i => i.id === it.id)?.qty || 0) * it.price, 0), 0) }; }).filter(c => c.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const itemSales = items.map(it => ({ ...it, sold: filtered.reduce((s, o) => s + (o.items.find(i => i.id === it.id)?.qty || 0), 0), revenue: filtered.reduce((s, o) => s + (o.items.find(i => i.id === it.id)?.qty || 0) * it.price, 0) })).filter(it => it.sold > 0).sort((a, b) => b.revenue - a.revenue);

  const DateFilter = () => <Card style={{ display: "flex", gap: 12, alignItems: "flex-end", marginBottom: 16, flexWrap: "wrap" }}><Inp label="From" value={dateFrom} onChange={setDateFrom} type="date" /><Inp label="To" value={dateTo} onChange={setDateTo} type="date" /><div style={{ marginLeft: "auto" }}><div style={{ fontSize: 12, color: C.textMid }}>{filtered.length} orders</div><div style={{ fontSize: 18, fontWeight: 800, color: C.primary }}>{fmtSAR(filtered.reduce((s, o) => s + o.total, 0))}</div></div></Card>;

  const tabs = [["summary", "📋 Summary"], ["category", "📂 Category"], ["items", "🍔 Items"], ["stock", "📦 Stock"], ["eod", "🌙 End of Day"]];

  return (
    <div>
      {/* Close Day confirmation */}
      {showCloseDay && <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ background: "#fff", borderRadius: 20, padding: 32, maxWidth: 400, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
          <div style={{ fontSize: 32, textAlign: "center", marginBottom: 12 }}>🌙</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text, textAlign: "center", marginBottom: 8 }}>Close the Day?</div>
          <div style={{ fontSize: 13, color: C.textMid, textAlign: "center", marginBottom: 20, lineHeight: 1.5 }}>
            This will record the end of day at <strong>{new Date().toLocaleTimeString()}</strong>.<br />
            Today's orders: <strong>{todaySales.length}</strong> · Revenue: <strong>{fmtSAR(todaySales.reduce((s, o) => s + o.total, 0))}</strong>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={() => setShowCloseDay(false)} style={{ flex: 1, padding: 14, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", color: C.text }}>No, Cancel</button>
            <button onClick={handleCloseDay} style={{ flex: 1, padding: 14, background: "linear-gradient(135deg,#1A6B4A,#134D36)", color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Yes, Close Day</button>
          </div>
        </div>
      </div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
        </div>
        <button onClick={() => setShowCloseDay(true)} style={{ padding: "10px 20px", background: "linear-gradient(135deg,#1A3A5C,#0F2340)", color: "#fff", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>🌙 Close Day</button>
      </div>

      {tab === "summary" && <><DateFilter /><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 16 }}><StatCard icon="💰" label="Revenue" value={fmtSAR(filtered.reduce((s, o) => s + o.total, 0))} color={C.primary} bg={C.primaryLight} /><StatCard icon="🧾" label="Orders" value={filtered.length} color={C.info} bg={C.infoLight} /><StatCard icon="📊" label="VAT" value={fmtSAR(filtered.reduce((s, o) => s + o.vat, 0))} color={C.accent} bg={C.accentLight} /><StatCard icon="💵" label="Avg Order" value={fmtSAR(filtered.length ? filtered.reduce((s, o) => s + o.total, 0) / filtered.length : 0)} color={C.success} bg={C.successLight} /></div></>}
      {tab === "category" && <><DateFilter /><Card><DataTable headers={["Category", "Revenue"]} rows={catSales.map(c => [c.cat, <strong style={{ color: C.primary }}>{fmtSAR(c.revenue)}</strong>])} /></Card></>}
      {tab === "items" && <>
        <DateFilter />
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Items Sold</div>
            <Btn size="sm" variant="outline" onClick={() => {
              const win = window.open("", "_blank", "width=400,height=600");
              if (!win) { alert("Allow pop-ups to print"); return; }
              const rows = itemSales.map(it => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:Arial">${it.name}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-family:Arial">${it.nameAr||""}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;font-family:Arial">${it.sold}</td></tr>`).join("");
              win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Items Report</title><style>@page{size:A4;margin:15mm}body{font-family:Arial;font-size:13px}table{width:100%;border-collapse:collapse}th{background:#1A6B4A;color:#fff;padding:8px 10px}h2{color:#1A6B4A}</style></head><body><h2>📋 Items Sold — ${dateFrom} to ${dateTo}</h2><table><thead><tr><th style="text-align:left">Item</th><th style="text-align:right">Arabic</th><th style="text-align:center">Qty Sold</th></tr></thead><tbody>${rows}</tbody></table><p style="margin-top:16px;font-size:12px;color:#888">Total items: ${itemSales.length} · Printed: ${new Date().toLocaleString()}</p><script>window.onload=function(){window.print();window.close()}<\/script></body></html>`);
              win.document.close();
            }}>🖨️ Print Items Report</Btn>
          </div>
          {itemSales.length === 0
            ? <div style={{ textAlign: "center", padding: "30px 0", color: C.textMid }}>No items sold in this period</div>
            : <DataTable headers={["Item", "Category", "Price", "Qty Sold", "Revenue"]} rows={itemSales.map(it => [it.name, <Badge color={C.info} bg={C.infoLight}>{it.category}</Badge>, fmtSAR(it.price), <strong style={{ color: C.primary, fontSize: 15 }}>{it.sold}</strong>, fmtSAR(it.revenue)])} />
          }
        </Card>
      </>}
      {tab === "stock" && <Card><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Stock Levels</div><DataTable headers={["Item", "Category", "Stock", "Alert"]} rows={items.map(it => [it.name, it.category, it.stock, it.stock < 10 ? <Badge color={C.danger} bg={C.dangerLight}>Low</Badge> : <Badge color={C.success} bg={C.successLight}>OK</Badge>])} /></Card>}
      {tab === "eod" && <Card>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>🌙 End of Day Report — {fmtDate(TODAY)}</div>
        {todayLog ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {[
              ["🟢 Day Started", fmtDateTime(todayLog.startTime)],
              ["🔴 Day Closed", fmtDateTime(todayLog.closeTime)],
              ["Total Orders", todayLog.orderCount],
              ["Total Revenue", fmtSAR(todayLog.revenue)],
              ["VAT Collected", fmtSAR(todayLog.vat)],
              ["Cash Sales", fmtSAR(todaySales.filter(s => s.payMethod === "Cash").reduce((s, o) => s + o.total, 0))],
              ["Card / Digital", fmtSAR(todaySales.filter(s => s.payMethod !== "Cash").reduce((s, o) => s + o.total, 0))],
            ].map(([l, v]) => <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}><span style={{ color: C.textMid }}>{l}</span><strong style={{ color: C.text, fontFamily: l.includes("Started") || l.includes("Closed") ? "monospace" : "inherit", fontSize: l.includes("Started") || l.includes("Closed") ? 12 : 14 }}>{v}</strong></div>)}
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "40px 0", color: C.textMid }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🌙</div>
            <div style={{ fontSize: 14, marginBottom: 16 }}>Day not closed yet. Click "Close Day" button above to record end of day.</div>
            <div style={{ fontSize: 13, color: C.textLight }}>Orders today: {todaySales.length} · Revenue: {fmtSAR(todaySales.reduce((s, o) => s + o.total, 0))}</div>
          </div>
        )}
      </Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════════════════════════
function Tools({ sales, items, setItems }) {
  const [tab, setTab] = useState("export");
  const [bulkPct, setBulkPct] = useState("");
  const [bulkCat, setBulkCat] = useState("All");
  const cats = ["All", ...new Set(items.map(i => i.category))];
  function exportCSV(data, filename) { const h = Object.keys(data[0] || {}).join(","); const rows = data.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n"); const blob = new Blob([h + "\n" + rows], { type: "text/csv" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); }
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {[["export", "📤 Export"], ["prices", "💲 Bulk Prices"], ["backup", "💾 Backup"]].map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", borderRadius: 8, border: `1.5px solid ${tab === id ? C.primary : C.border}`, background: tab === id ? C.primaryLight : "#fff", color: tab === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{label}</button>)}
      </div>
      {tab === "export" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {[{ icon: "📅", title: "Today's Sales", action: () => exportCSV(sales.filter(s => s.date === TODAY).map(s => ({ id: s.id, date: s.date, time: s.time, type: s.type, total: s.total, vat: s.vat })), "sales-today.csv") }, { icon: "📆", title: "This Month", action: () => { const m = new Date(); m.setDate(1); exportCSV(sales.filter(s => s.date >= m.toISOString().split("T")[0]).map(s => ({ id: s.id, date: s.date, total: s.total, vat: s.vat })), "sales-month.csv"); } }, { icon: "📦", title: "Menu & Stock", action: () => exportCSV(items.map(it => ({ name: it.name, category: it.category, price: it.price, cost: it.cost, stock: it.stock })), "menu-stock.csv") }, { icon: "📊", title: "Tax Summary", action: () => exportCSV([{ period: "All", subtotal: sales.reduce((s, o) => s + o.subtotal, 0).toFixed(2), vat: sales.reduce((s, o) => s + o.vat, 0).toFixed(2), total: sales.reduce((s, o) => s + o.total, 0).toFixed(2) }], "tax-summary.csv") }].map(({ icon, title, action }) => <Card key={title} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", gap: 12, alignItems: "center" }}><span style={{ fontSize: 26 }}>{icon}</span><div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div></div><Btn size="sm" variant="outline" onClick={action}>Export</Btn></Card>)}
      </div>}
      {tab === "prices" && <Card style={{ maxWidth: 480 }}><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Bulk Price Update</div><div style={{ display: "flex", flexDirection: "column", gap: 14 }}><Sel label="Category" value={bulkCat} onChange={setBulkCat} options={cats} /><Inp label="Change %" value={bulkPct} onChange={setBulkPct} type="number" placeholder="+10 or -5" /><Btn variant="accent" disabled={!bulkPct} onClick={() => { const pct = parseFloat(bulkPct); setItems(prev => prev.map(it => (bulkCat === "All" || it.category === bulkCat) ? { ...it, price: parseFloat((it.price * (1 + pct / 100)).toFixed(2)) } : it)); alert("Prices updated!"); setBulkPct(""); }}>Apply</Btn></div></Card>}
      {tab === "backup" && <Card style={{ maxWidth: 480 }}><div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Backup Data</div><Btn onClick={() => { const backup = { timestamp: new Date().toISOString(), items, sales: sales.slice(-200) }; const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `restopos-backup-${TODAY}.json`; a.click(); }}>💾 Download Backup</Btn></Card>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// USER ADMIN
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
      {showModal && <Modal title={editUser ? "Edit User" : "New User"} onClose={() => setShowModal(false)} width={420}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Inp label="Full Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} />
          <Inp label="Username" value={form.username} onChange={v => setForm(f => ({ ...f, username: v }))} />
          <Sel label="Role" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} options={["Admin", "Manager", "Cashier"]} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} id="ua" /><label htmlFor="ua" style={{ fontSize: 13 }}>Active</label></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}><Btn variant="ghost" onClick={() => setShowModal(false)} style={{ flex: 1 }}>Cancel</Btn><Btn onClick={save} style={{ flex: 1 }}>Save</Btn></div>
      </Modal>}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}><div style={{ fontSize: 15, fontWeight: 700 }}>User Management</div><Btn size="sm" onClick={() => openModal()}>+ New User</Btn></div>
        <DataTable headers={["Name", "Username", "Role", "Status", "Actions"]} rows={users.map(u => [u.name, <span style={{ fontFamily: "monospace" }}>{u.username}</span>, <Badge color={u.role === "Admin" ? C.danger : u.role === "Manager" ? C.warning : C.info} bg={u.role === "Admin" ? C.dangerLight : u.role === "Manager" ? C.warningLight : C.infoLight}>{u.role}</Badge>, <Badge color={u.active ? C.success : C.danger} bg={u.active ? C.successLight : C.dangerLight}>{u.active ? "Active" : "Off"}</Badge>, <div style={{ display: "flex", gap: 5 }}><Btn size="sm" variant="ghost" onClick={() => openModal(u)}>Edit</Btn><Btn size="sm" variant="danger" onClick={() => { if (confirm("Delete?")) setUsers(prev => prev.filter(x => x.id !== u.id)); }}>Del</Btn></div>])} />
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HELP — with AI Assistant
// ═══════════════════════════════════════════════════════════════════
function Help() {
  const [tab, setTab] = useState("guide");
  const [aiMessages, setAiMessages] = useState([{ role: "assistant", content: "Hi! I'm the RestoPOS Assistant 🤖 Ask me anything about using this system — billing, reports, ZATCA QR, settings, or anything else!" }]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const chatRef = useRef();

  async function sendMessage() {
    if (!aiInput.trim() || aiLoading) return;
    const userMsg = aiInput.trim();
    setAiInput("");
    setAiMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setAiLoading(true);
    try {
      // Fetch API key from Firestore config doc (set this once in your Firebase console)
      // Collection: config / Document ID: ai / Field: apiKey
      let apiKey = "";
      try {
        const cfgSnap = await getDoc(doc(db, "config", "ai"));
        if (cfgSnap.exists()) apiKey = cfgSnap.data().apiKey || "";
      } catch (e) { /* ignore, will fail below */ }

      if (!apiKey) throw new Error("AI not configured. Ask support to enable the AI assistant.");

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `You are RestoPOS Assistant — a helpful support bot for the RestoPOS restaurant management system used in Saudi Arabia. You help restaurant staff with questions about: POS billing, ZATCA QR codes, reports, menu management, settings, user roles, barcode scanning, payment methods (Cash, Mada, Apple Pay, STC Pay), VAT calculations (15%), and general app usage. Keep answers short, clear and practical. If asked about something unrelated to the POS system, politely redirect to RestoPOS topics.`,
          messages: [...aiMessages, { role: "user", content: userMsg }].map(m => ({ role: m.role, content: m.content }))
        })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${response.status}`);
      }
      const data = await response.json();
      const reply = data.content?.[0]?.text || "Sorry, I couldn't process that. Please try again.";
      setAiMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setAiMessages(prev => [...prev, { role: "assistant", content: `⚠️ ${e.message || "Unknown error. Check your connection."}` }]);
    }
    setAiLoading(false);
    setTimeout(() => chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" }), 100);
  }

  const sections = [["guide", "🚀", "Guide"], ["zatca", "⬛", "ZATCA"], ["ai", "🤖", "AI Help"], ["support", "📞", "Support"]];
  return (
    <div style={{ display: "flex", gap: 20 }}>
      <div style={{ width: 160, flexShrink: 0 }}>
        <Card style={{ padding: 8 }}>
          {sections.map(([id, icon, label]) => <button key={id} onClick={() => setTab(id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: tab === id ? C.primaryLight : "transparent", color: tab === id ? C.primary : C.textMid, border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: tab === id ? 700 : 500, textAlign: "left", marginBottom: 2 }}><span>{icon}</span><span>{label}</span></button>)}
        </Card>
      </div>
      <div style={{ flex: 1 }}>
        {tab === "guide" && <Card><div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>Getting Started</div>{[{ n: "1", t: "Activate License", d: "Enter your CR number, VAT number, and 12-digit license key. Saved permanently." }, { n: "2", t: "Login by Role", d: "Select Admin, Manager, or Cashier and enter your 4-digit PIN." }, { n: "3", t: "Setup Menu", d: "Go to Create → Items to add your menu with Arabic names, prices, and barcodes." }, { n: "4", t: "Start Billing", d: "POS opens in Takeaway mode. Add items, fill customer details, process payment." }, { n: "5", t: "ZATCA QR", d: "Every receipt auto-generates a real scannable ZATCA-compliant QR code." }, { n: "6", t: "Close Day", d: "Go to Reports → click Close Day to record end of day with exact timestamps." }].map((s, i) => <div key={i} style={{ display: "flex", gap: 14, marginBottom: 14, padding: 14, background: C.bg, borderRadius: 10 }}><div style={{ width: 34, height: 34, background: C.primary, color: "#fff", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 800, flexShrink: 0 }}>{s.n}</div><div><div style={{ fontSize: 14, fontWeight: 700, marginBottom: 3 }}>{s.t}</div><div style={{ fontSize: 13, color: C.textMid }}>{s.d}</div></div></div>)}</Card>}
        {tab === "zatca" && <Card><div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>⬛ ZATCA QR Code</div>{[["Standard", "ZATCA Phase 1 & 2 Ready"], ["Encoding", "TLV (Tag-Length-Value) → Base64"], ["QR Content", "Seller Name, VAT No., Timestamp, Total, VAT Amount"], ["Verification", "Real scannable QR — works with any ZATCA scanner"], ["Auto-fill", "VAT number pulled from your license automatically"]].map(([k, v]) => <div key={k} style={{ display: "flex", gap: 12, padding: "10px 14px", background: C.zatcaLight, borderRadius: 8, marginBottom: 8 }}><span style={{ fontSize: 12, fontWeight: 700, color: C.zatca, width: 110, flexShrink: 0 }}>{k}</span><span style={{ fontSize: 13 }}>{v}</span></div>)}</Card>}
        {tab === "ai" && <Card style={{ display: "flex", flexDirection: "column", height: 560 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style={{ width: 38, height: 38, background: "linear-gradient(135deg,#6366f1,#4f46e5)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🤖</div>
            <div><div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>RestoPOS AI Assistant</div><div style={{ fontSize: 11, color: C.success, fontWeight: 600 }}>● Powered by Claude · Ask anything about RestoPOS</div></div>
          </div>
          <div ref={chatRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, marginBottom: 12, paddingRight: 4 }}>
            {aiMessages.map((msg, i) => (
              <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start", gap: 8, alignItems: "flex-end" }}>
                {msg.role === "assistant" && <div style={{ width: 26, height: 26, background: "linear-gradient(135deg,#6366f1,#4f46e5)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0, marginBottom: 2 }}>🤖</div>}
                <div style={{ maxWidth: "78%", padding: "10px 14px", borderRadius: msg.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px", background: msg.role === "user" ? C.primary : C.bg, color: msg.role === "user" ? "#fff" : C.text, fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                  {msg.content}
                </div>
              </div>
            ))}
            {aiLoading && <div style={{ display: "flex", justifyContent: "flex-start", gap: 8, alignItems: "flex-end" }}>
              <div style={{ width: 26, height: 26, background: "linear-gradient(135deg,#6366f1,#4f46e5)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>🤖</div>
              <div style={{ padding: "10px 16px", borderRadius: "18px 18px 18px 4px", background: C.bg, fontSize: 18, color: C.zatca, letterSpacing: 3 }}>&#x2022;&#x2022;&#x2022;</div>
            </div>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={aiInput} onChange={e => setAiInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }} placeholder="Ask anything about RestoPOS — billing, ZATCA, settings…" style={{ flex: 1, padding: "11px 14px", border: `1.5px solid ${C.border}`, borderRadius: 12, fontSize: 13, fontFamily: "inherit", outline: "none" }} />
            <button onClick={sendMessage} disabled={aiLoading || !aiInput.trim()} style={{ padding: "11px 22px", background: aiLoading || !aiInput.trim() ? "#ccc" : "linear-gradient(135deg,#6366f1,#4f46e5)", color: "#fff", border: "none", borderRadius: 12, cursor: aiLoading || !aiInput.trim() ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", transition: "all 0.15s" }}>
              {aiLoading ? "..." : "Send ↑"}
            </button>
          </div>
        </Card>}
        {tab === "support" && <Card><div style={{ fontSize: 18, fontWeight: 800, marginBottom: 20 }}>Support & Contact</div>{[{ icon: "📦", label: "Product", value: "RestoPOS v5.0 · ZATCA Phase 2" }, { icon: "🌍", label: "Region", value: "Kingdom of Saudi Arabia" }, { icon: "📧", label: "Email", value: "support@restopos.sa" }, { icon: "📞", label: "Phone", value: "+966 50 000 0000 (9AM–6PM)" }, { icon: "💬", label: "WhatsApp", value: "+966 50 000 0000" }].map((item, i) => <div key={i} style={{ display: "flex", gap: 14, padding: "12px 0", borderBottom: `1px solid ${C.border}`, alignItems: "center" }}><span style={{ fontSize: 20, width: 28 }}>{item.icon}</span><div style={{ fontSize: 12, fontWeight: 700, color: C.textMid, width: 90 }}>{item.label}</div><div style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{item.value}</div></div>)}</Card>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OWNER DASHBOARD — Full client management for you (the product owner)
// ═══════════════════════════════════════════════════════════════════
const OWNER_PASSWORD = "RestoOwner2026"; // ← Change this to your real password

function OwnerLogin({ onLogin }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#0a0a1a,#1a0a2e,#0a1a0a)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 64, height: 64, background: "linear-gradient(135deg,#F0A500,#e09000)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, margin: "0 auto 16px" }}>👑</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#fff" }}>Owner Dashboard</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>RestoPOS · Internal Access</div>
        </div>
        <div style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 20, padding: 32, backdropFilter: "blur(12px)" }}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.5)", display: "block", marginBottom: 6 }}>Owner Password</label>
            <input type="password" value={pw} onChange={e => { setPw(e.target.value); setErr(""); }}
              onKeyDown={e => e.key === "Enter" && (pw === OWNER_PASSWORD ? onLogin() : setErr("Incorrect password."))}
              placeholder="Enter owner password"
              style={{ width: "100%", padding: "12px 16px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, fontSize: 14, color: "#fff", fontFamily: "inherit" }} />
          </div>
          {err && <div style={{ color: "#ff6b6b", fontSize: 13, marginBottom: 12 }}>⚠️ {err}</div>}
          <button onClick={() => pw === OWNER_PASSWORD ? onLogin() : setErr("Incorrect password.")}
            style={{ width: "100%", padding: 14, background: "linear-gradient(135deg,#F0A500,#e09000)", color: "#fff", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
            Enter Dashboard →
          </button>
          <button onClick={() => { window._ownerMode = false; window.dispatchEvent(new Event("ownerLogout")); }}
            style={{ width: "100%", marginTop: 10, padding: 12, background: "transparent", color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            ← Back to Client Login
          </button>
        </div>
      </div>
    </div>
  );
}

function OwnerDashboard({ onLogout }) {
  const [tab, setTab] = useState("overview");
  const [licenses, setLicenses] = useState([]);
  const [activations, setActivations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectBox, setShowRejectBox] = useState(null);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [licSnap, actSnap] = await Promise.all([
        getDocs(collection(db, "licenses")),
        getDocs(collection(db, "pending_activations")),
      ]);
      setLicenses(licSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      const acts = actSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      acts.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
      setActivations(acts);
    } catch (e) { alert("Load failed: " + e.message); }
    setLoading(false);
  }

  async function updateStatus(id, status, reason = "") {
    setUpdating(true);
    try {
      await updateDoc(doc(db, "pending_activations", id), {
        status,
        reviewedAt: new Date().toISOString(),
        ...(reason ? { rejectReason: reason } : {}),
      });
      setActivations(prev => prev.map(a => a.id === id ? { ...a, status, rejectReason: reason } : a));
      if (selected?.id === id) setSelected(s => ({ ...s, status }));
    } catch (e) { alert("Update failed: " + e.message); }
    setUpdating(false);
    setShowRejectBox(null);
    setRejectReason("");
  }

  async function toggleLicense(id, currentActive) {
    try {
      await updateDoc(doc(db, "licenses", id), { active: !currentActive });
      setLicenses(prev => prev.map(l => l.id === id ? { ...l, active: !currentActive } : l));
    } catch (e) { alert("Failed: " + e.message); }
  }

  const pending = activations.filter(a => a.status === "pending");
  const approved = activations.filter(a => a.status === "approved");
  const rejected = activations.filter(a => a.status === "rejected");
  const activeL = licenses.filter(l => l.active);

  const statusColor = { pending: C.warning, approved: C.success, rejected: C.danger };
  const statusBg = { pending: C.warningLight, approved: C.successLight, rejected: C.dangerLight };

  function DocViewer({ label, data, name, type }) {
    if (!data) return <div style={{ padding: 12, background: C.bg, borderRadius: 8, fontSize: 12, color: C.textLight }}>No file</div>;
    const isPdf = (type || "").includes("pdf") || (data || "").includes("application/pdf");
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMid, marginBottom: 6 }}>{label} · <span style={{ fontWeight: 400 }}>{name}</span></div>
        {isPdf
          ? <><iframe src={data} style={{ width: "100%", height: 280, border: `1px solid ${C.border}`, borderRadius: 8 }} title={label} /><a href={data} download={name} style={{ fontSize: 11, color: C.primary, fontWeight: 700, display: "inline-block", marginTop: 4 }}>⬇ Download PDF</a></>
          : <><img src={data} alt={label} style={{ width: "100%", maxHeight: 280, objectFit: "contain", border: `1px solid ${C.border}`, borderRadius: 8, background: "#f8f8f8" }} /><a href={data} download={name} style={{ fontSize: 11, color: C.primary, fontWeight: 700, display: "inline-block", marginTop: 4 }}>⬇ Download</a></>
        }
      </div>
    );
  }

  const TABS = [["overview", "📊", "Overview"], ["pending", "⏳", `Pending (${pending.length})`], ["clients", "👥", "All Clients"], ["licenses", "🔑", "Licenses"]];

  return (
    <div style={{ minHeight: "100vh", background: "#0f0f1a", fontFamily: "'Plus Jakarta Sans',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>

      {/* Owner Header */}
      <div style={{ background: "linear-gradient(135deg,#1a0a2e,#0a1628)", borderBottom: "1px solid rgba(255,255,255,0.08)", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, background: "linear-gradient(135deg,#F0A500,#e09000)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>👑</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>RestoPOS Owner</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>Internal Dashboard · {new Date().toLocaleDateString("en-SA", { day: "2-digit", month: "short", year: "numeric" })}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {TABS.map(([id, icon, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: tab === id ? "rgba(240,165,0,0.2)" : "transparent", color: tab === id ? "#F0A500" : "rgba(255,255,255,0.5)", fontFamily: "inherit", fontSize: 12, fontWeight: tab === id ? 700 : 500, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
              <span>{icon}</span><span>{label}</span>
            </button>
          ))}
          <button onClick={loadAll} style={{ padding: "6px 12px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "none", color: "rgba(255,255,255,0.5)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>↻ Refresh</button>
          <button onClick={onLogout} style={{ padding: "6px 14px", borderRadius: 8, background: "rgba(217,64,64,0.15)", border: "none", color: "#ff6b6b", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Logout</button>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 80, color: "rgba(255,255,255,0.3)", fontSize: 16 }}>⏳ Loading data…</div>
        ) : (
          <>
            {/* ── OVERVIEW ── */}
            {tab === "overview" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 14 }}>
                  {[
                    ["🔑", "Total Licenses", licenses.length, "#F0A500"],
                    ["✅", "Active Licenses", activeL.length, "#1A8A4A"],
                    ["⏳", "Pending Review", pending.length, "#E07B00"],
                    ["👥", "Total Clients", approved.length, "#2176AE"],
                    ["✗", "Rejected", rejected.length, "#D94040"],
                    ["📅", "Today's Signups", activations.filter(a => a.submittedAt?.startsWith(TODAY)).length, "#6366f1"],
                  ].map(([icon, label, val, color]) => (
                    <div key={label} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "18px 20px", display: "flex", alignItems: "center", gap: 14 }}>
                      <div style={{ width: 44, height: 44, background: color + "20", borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{icon}</div>
                      <div><div style={{ fontSize: 26, fontWeight: 900, color }}>{val}</div><div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: 600 }}>{label}</div></div>
                    </div>
                  ))}
                </div>

                <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 14 }}>⏳ Recent Pending Submissions</div>
                  {pending.length === 0
                    ? <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>No pending submissions.</div>
                    : pending.slice(0, 5).map(a => (
                      <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{a.businessName}</div>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>CR: {a.crNumber} · {a.city} · {a.submittedAt ? fmtDateTime(a.submittedAt) : "—"}</div>
                        </div>
                        <button onClick={() => { setSelected(a); setTab("pending"); }} style={{ padding: "6px 14px", background: "#F0A50020", border: "1px solid #F0A50040", color: "#F0A500", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Review →</button>
                      </div>
                    ))
                  }
                </div>
              </div>
            )}

            {/* ── PENDING ── */}
            {tab === "pending" && (
              <div style={{ display: "flex", gap: 20 }}>
                {/* List */}
                <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                  {pending.length === 0
                    ? <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 13, padding: 20 }}>No pending submissions 🎉</div>
                    : pending.map(a => (
                      <div key={a.id} onClick={() => setSelected(a)}
                        style={{ background: selected?.id === a.id ? "rgba(240,165,0,0.12)" : "rgba(255,255,255,0.04)", border: `1px solid ${selected?.id === a.id ? "#F0A500" : "rgba(255,255,255,0.08)"}`, borderRadius: 12, padding: "14px 16px", cursor: "pointer", transition: "all 0.15s" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 4 }}>{a.businessName}</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>CR: {a.crNumber}</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{a.submittedAt ? fmtDateTime(a.submittedAt) : "—"}</div>
                      </div>
                    ))
                  }
                </div>
                {/* Detail */}
                <div style={{ flex: 1 }}>
                  {!selected ? (
                    <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 14, padding: "60px 0", textAlign: "center" }}>← Select a submission to review</div>
                  ) : (
                    <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: 24 }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", marginBottom: 16 }}>{selected.businessName}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
                        {[["CR Number", selected.crNumber], ["VAT Number", selected.vatNumber], ["License Key", selected.licenseKey], ["Phone", selected.phone || "—"], ["City", selected.city || "—"], ["Submitted", selected.submittedAt ? fmtDateTime(selected.submittedAt) : "—"], ["Device ID", selected.deviceId || "—"], ["Status", selected.status]].map(([k, v]) => (
                          <div key={k} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 12px" }}>
                            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 2 }}>{k}</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: k === "Status" ? (statusColor[selected.status] || "#fff") : "#fff" }}>{v}</div>
                          </div>
                        ))}
                      </div>
                      <DocViewer label="VAT Certificate" data={selected.vatCertBase64} name={selected.vatCertName} type={selected.vatCertType} />
                      <DocViewer label="Business License (CR)" data={selected.bizLicenseBase64} name={selected.bizLicenseName} type={selected.bizLicenseType} />

                      {selected.status === "pending" && (
                        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                          {showRejectBox === selected.id ? (
                            <div style={{ flex: 1 }}>
                              <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Reason for rejection (optional)"
                                style={{ width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(217,64,64,0.4)", borderRadius: 10, fontSize: 13, color: "#fff", fontFamily: "inherit", marginBottom: 8 }} />
                              <div style={{ display: "flex", gap: 8 }}>
                                <button onClick={() => setShowRejectBox(null)} style={{ flex: 1, padding: 10, background: "rgba(255,255,255,0.06)", border: "none", borderRadius: 8, color: "rgba(255,255,255,0.5)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                                <button onClick={() => updateStatus(selected.id, "rejected", rejectReason)} disabled={updating}
                                  style={{ flex: 1, padding: 10, background: "#D94040", border: "none", borderRadius: 8, color: "#fff", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Confirm Reject</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button onClick={() => setShowRejectBox(selected.id)} style={{ flex: 1, padding: 12, background: "rgba(217,64,64,0.15)", border: "1px solid rgba(217,64,64,0.3)", borderRadius: 10, color: "#ff6b6b", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>✗ Reject</button>
                              <button onClick={() => updateStatus(selected.id, "approved")} disabled={updating}
                                style={{ flex: 2, padding: 12, background: "linear-gradient(135deg,#1A6B4A,#134D36)", border: "none", borderRadius: 10, color: "#fff", fontWeight: 800, cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>✓ Approve Client</button>
                            </>
                          )}
                        </div>
                      )}
                      {selected.status !== "pending" && (
                        <div style={{ marginTop: 12, padding: "12px 16px", background: statusBg[selected.status], borderRadius: 10, fontSize: 13, fontWeight: 700, color: statusColor[selected.status], textAlign: "center" }}>
                          {selected.status === "approved" ? "✅ Approved" : `✗ Rejected${selected.rejectReason ? ": " + selected.rejectReason : ""}`}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── ALL CLIENTS ── */}
            {tab === "clients" && (
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>All Submissions ({activations.length})</div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                        {["Business", "CR", "VAT", "License Key", "City", "Phone", "Submitted", "Duration", "Status", "Docs"].map(h => (
                          <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: "rgba(255,255,255,0.4)", fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activations.map((a, i) => {
                        const subDate = a.submittedAt ? new Date(a.submittedAt) : null;
                        const daysSince = subDate ? Math.floor((Date.now() - subDate) / 86400000) : null;
                        return (
                          <tr key={a.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                            <td style={{ padding: "10px 14px", color: "#fff", fontWeight: 600 }}>{a.businessName}</td>
                            <td style={{ padding: "10px 14px", color: "rgba(255,255,255,0.6)", fontFamily: "monospace", fontSize: 11 }}>{a.crNumber}</td>
                            <td style={{ padding: "10px 14px", color: "rgba(255,255,255,0.6)", fontFamily: "monospace", fontSize: 11 }}>{a.vatNumber}</td>
                            <td style={{ padding: "10px 14px", color: "#F0A500", fontFamily: "monospace", fontSize: 11 }}>{a.licenseKey}</td>
                            <td style={{ padding: "10px 14px", color: "rgba(255,255,255,0.6)" }}>{a.city || "—"}</td>
                            <td style={{ padding: "10px 14px", color: "rgba(255,255,255,0.6)" }}>{a.phone || "—"}</td>
                            <td style={{ padding: "10px 14px", color: "rgba(255,255,255,0.5)", fontSize: 11, whiteSpace: "nowrap" }}>{subDate ? fmtDate(a.submittedAt) : "—"}</td>
                            <td style={{ padding: "10px 14px", color: "#6366f1", fontWeight: 700 }}>{daysSince !== null ? `${daysSince}d` : "—"}</td>
                            <td style={{ padding: "10px 14px" }}>
                              <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700, color: statusColor[a.status] || "rgba(255,255,255,0.5)", background: (statusBg[a.status] || "rgba(255,255,255,0.05)") + "33", border: `1px solid ${statusColor[a.status] || "rgba(255,255,255,0.1)"}40` }}>{a.status}</span>
                            </td>
                            <td style={{ padding: "10px 14px" }}>
                              <button onClick={() => { setSelected(a); setTab("pending"); }} style={{ padding: "5px 12px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "rgba(255,255,255,0.7)", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>View</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── LICENSES ── */}
            {tab === "licenses" && (
              <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>License Keys ({licenses.length})</div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                        {["Key", "Status", "Activated By", "Activated At", "Device ID", "Toggle"].map(h => (
                          <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: "rgba(255,255,255,0.4)", fontWeight: 700, fontSize: 10, textTransform: "uppercase", borderBottom: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {licenses.map((l, i) => (
                        <tr key={l.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                          <td style={{ padding: "10px 14px", fontFamily: "monospace", color: "#F0A500", fontWeight: 700 }}>{l.key}</td>
                          <td style={{ padding: "10px 14px" }}>
                            <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700, color: l.active ? "#1A8A4A" : "#D94040", background: l.active ? "#E6F7ED" : "#FDE8E8" }}>{l.active ? "Active" : "Inactive"}</span>
                          </td>
                          <td style={{ padding: "10px 14px", color: "rgba(255,255,255,0.7)" }}>{l.activatedBy || "—"}</td>
                          <td style={{ padding: "10px 14px", color: "rgba(255,255,255,0.5)", fontSize: 11 }}>{l.activatedAt ? fmtDateTime(l.activatedAt) : "—"}</td>
                          <td style={{ padding: "10px 14px", color: "rgba(255,255,255,0.4)", fontFamily: "monospace", fontSize: 10 }}>{l.deviceId ? l.deviceId.slice(0, 20) + "…" : "—"}</td>
                          <td style={{ padding: "10px 14px" }}>
                            <button onClick={() => toggleLicense(l.id, l.active)}
                              style={{ padding: "5px 12px", background: l.active ? "rgba(217,64,64,0.15)" : "rgba(26,138,74,0.15)", border: `1px solid ${l.active ? "rgba(217,64,64,0.3)" : "rgba(26,138,74,0.3)"}`, borderRadius: 6, color: l.active ? "#ff6b6b" : "#4ade80", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
                              {l.active ? "Deactivate" : "Activate"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [step, setStep] = useState("checking");
  const [businessData, setBusinessData] = useState(null);
  const [license, setLicense] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [screen, setScreen] = useState("pos");
  const [ownerMode, setOwnerMode] = useState(false);
  const [ownerAuthed, setOwnerAuthed] = useState(false);

  // Listen for owner login/logout events from the registration page button
  useEffect(() => {
    const onOwner = () => setOwnerMode(true);
    const onOwnerOut = () => { setOwnerMode(false); setOwnerAuthed(false); };
    window.addEventListener("ownerLogin", onOwner);
    window.addEventListener("ownerLogout", onOwnerOut);
    return () => { window.removeEventListener("ownerLogin", onOwner); window.removeEventListener("ownerLogout", onOwnerOut); };
  }, []);

  // ✅ All state loads from localStorage on boot so data survives refresh/logout
  const [sales, _setSales] = useState(() => LS.get("restopos_sales") || []);
  const [items, _setItems] = useState(() => LS.get("restopos_items") || SEED_ITEMS);
  const [tables, _setTables] = useState(() => LS.get("restopos_tables") || TABLES_INIT);
  const [users, _setUsers] = useState(() => LS.get("restopos_users") || [
    { id: 1, name: "Admin User", username: "admin", role: "Admin", active: true, lastLogin: "Today" },
    { id: 2, name: "Manager", username: "manager", role: "Manager", active: true, lastLogin: "Today" },
    { id: 3, name: "Cashier", username: "cashier", role: "Cashier", active: true, lastLogin: "Today" },
  ]);
  const [promos, _setPromos] = useState(() => LS.get("restopos_promos") || [
    { id: 1, code: "SAVE10", type: "%", value: 10, active: true, minOrder: 30 },
    { id: 2, code: "FLAT20", type: "flat", value: 20, active: true, minOrder: 100 },
  ]);
  const [company, _setCompany] = useState(() => LS.get("restopos_company") || { phone: "", email: "", address: "", city: "Riyadh" });
  const [pins, _setPins] = useState(() => LS.get("restopos_pins") || DEFAULT_PINS);

  // ✅ Persisting wrappers — every change saves to localStorage automatically
  function setSales(v) { _setSales(p => { const n = typeof v === "function" ? v(p) : v; LS.set("restopos_sales", n.slice(-500)); return n; }); }
  function setItems(v) { _setItems(p => { const n = typeof v === "function" ? v(p) : v; LS.set("restopos_items", n); return n; }); }
  function setTables(v) { _setTables(p => { const n = typeof v === "function" ? v(p) : v; LS.set("restopos_tables", n); return n; }); }
  function setUsers(v) { _setUsers(p => { const n = typeof v === "function" ? v(p) : v; LS.set("restopos_users", n); return n; }); }
  function setPromos(v) { _setPromos(p => { const n = typeof v === "function" ? v(p) : v; LS.set("restopos_promos", n); return n; }); }
  function setCompany(v) { _setCompany(p => { const n = typeof v === "function" ? v(p) : v; LS.set("restopos_company", n); return n; }); }
  function setPins(v) { _setPins(p => { const n = typeof v === "function" ? v(p) : v; LS.set("restopos_pins", n); return n; }); }

  useEffect(() => {
    const saved = LS.get("restopos_license_v2");
    const pendingId = localStorage.getItem("restopos_pending_id");
    // ✅ currentUser is never saved → every page load/refresh requires PIN login
    if (saved) { setLicense(saved); setStep("login"); }
    else if (pendingId) { setStep("license"); } // resume pending approval screen
    else setStep("register");
  }, []);

  function handleClearLicense() {
    LS.del("restopos_license_v2"); LS.del("restopos_pins");
    setLicense(null); setCurrentUser(null); setStep("register");
  }

  // Role-based navigation
  const ALL_NAV = [
    ["dashboard", "📊", "Dashboard", ["Admin", "Manager"]],
    ["pos", "🖥️", "POS", ["Admin", "Manager", "Cashier"]],
    ["settings", "⚙️", "Settings", ["Admin"]],
    ["create", "➕", "Create", ["Admin", "Manager"]],
    ["transactions", "💳", "Transactions", ["Admin", "Manager"]],
    ["accounts", "📈", "Accounts", ["Admin", "Manager"]],
    ["reports", "📋", "Reports", ["Admin", "Manager"]],
    ["tools", "🔧", "Tools", ["Admin"]],
    ["useradmin", "👤", "Users", ["Admin"]],
    ["help", "❓", "Help", ["Admin", "Manager", "Cashier"]],
  ];
  const NAV = ALL_NAV.filter(([, , , roles]) => currentUser && roles.includes(currentUser.role));

  if (ownerMode && !ownerAuthed) return <OwnerLogin onLogin={() => setOwnerAuthed(true)} />;
  if (ownerMode && ownerAuthed) return <OwnerDashboard onLogout={() => { setOwnerMode(false); setOwnerAuthed(false); }} />;

  if (step === "checking") return <div style={{ minHeight: "100vh", background: "#0a1628", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ color: "#fff", fontSize: 16 }}>Loading…</div></div>;
  if (step === "register") return <BusinessRegistration onNext={(data) => { setBusinessData(data); setStep("license"); }} />;
  if (step === "license") return <LicenseVerification businessData={businessData || { businessName: "", crNumber: "", vatNumber: "", address: "", city: "", phone: "" }} onSuccess={(lic) => { setLicense(lic); setStep("login"); }} onBack={() => setStep("register")} />;
  if (step === "login" || !currentUser) return <RoleLogin license={license} onLogin={(user) => { setCurrentUser(user); setStep("app"); if (user.role === "Cashier") setScreen("pos"); }} />;

  return (
    <div style={{ fontFamily: "'Plus Jakarta Sans','Tajawal',sans-serif", background: C.bg, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Tajawal:wght@400;500;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:${C.bg}}::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}input,select{outline:none}input:focus,select:focus{border-color:${C.primary}!important}@media print{header,nav{display:none!important}}`}</style>

      {/* Header */}
      <div style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, height: 52, display: "flex", alignItems: "center", padding: "0 16px", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 30, height: 30, background: "linear-gradient(135deg,#1A6B4A,#F0A500)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 15, fontWeight: 900 }}>R</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.text, lineHeight: 1 }}>RestoPOS</div>
            <div style={{ fontSize: 9, color: C.textLight, letterSpacing: "0.08em" }}>ZATCA PHASE 2</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 1, overflowX: "auto" }}>
          {NAV.map(([id, icon, label]) => <button key={id} onClick={() => setScreen(id)} style={{ padding: "5px 9px", borderRadius: 8, border: "none", background: screen === id ? C.primaryLight : "transparent", color: screen === id ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 11, fontWeight: screen === id ? 700 : 500, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}><span>{icon}</span><span>{label}</span></button>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, background: C.zatcaLight, color: C.zatca, padding: "3px 8px", borderRadius: 6, fontWeight: 700 }}>⬛ ZATCA</span>
          <div style={{ fontSize: 11, color: C.textMid, fontWeight: 700 }}>{currentUser?.role}</div>
          <button onClick={() => setCurrentUser(null)} style={{ fontSize: 11, background: C.dangerLight, color: C.danger, border: "none", padding: "4px 8px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>Logout</button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, padding: screen === "pos" ? 0 : 20, overflowY: screen === "pos" ? "hidden" : "auto", width: "100%" }}>
        {screen === "dashboard" && <Dashboard sales={sales} items={items} license={license} />}
        {screen === "pos" && <POS items={items} sales={sales} setSales={setSales} tables={tables} setTables={setTables} promos={promos} license={license} />}
        {screen === "settings" && <Settings company={company} setCompany={setCompany} tables={tables} setTables={setTables} license={license} onClearLicense={handleClearLicense} pins={pins} setPins={setPins} />}
        {screen === "create" && <Create items={items} setItems={setItems} promos={promos} setPromos={setPromos} />}
        {screen === "transactions" && <Transactions sales={sales} setSales={setSales} license={license} />}
        {screen === "accounts" && <Accounts sales={sales} items={items} />}
        {screen === "reports" && <Reports sales={sales} items={items} setSales={setSales} />}
        {screen === "tools" && <Tools sales={sales} items={items} setItems={setItems} />}
        {screen === "useradmin" && <UserAdmin users={users} setUsers={setUsers} />}
        {screen === "help" && <Help />}
      </div>
    </div>
  );
}
