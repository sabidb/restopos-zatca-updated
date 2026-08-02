// ── PHARMACY-ONLY screen: Expiry & Batch tracking ───────────────────────────
// A placeholder that demonstrates the folder pattern: a screen unique to one
// business type lives inside that type's folder and imports the shared theme,
// so it automatically wears the type's colours. Flesh this out (wire to real
// product/batch data) in a later pass; nothing else in the app depends on it
// until it is added to the nav.
import { C } from "../../../lib/theme.js";

// Demo rows only — replace with real batches read from your product store.
const DEMO = [
  { name: "Paracetamol 500mg", batch: "PC-2401", qty: 120, expiry: "2026-09-30" },
  { name: "Amoxicillin 250mg", batch: "AX-2312", qty: 40, expiry: "2026-08-15" },
  { name: "Vitamin C 1000mg", batch: "VC-2405", qty: 8, expiry: "2026-08-05" },
];

const daysLeft = (d) => Math.ceil((new Date(d) - new Date()) / 86400000);

export function ExpiryBatch() {
  return (
    <div style={{ padding: 20, fontFamily: "inherit" }}>
      <h2 style={{ color: C.primary, margin: "0 0 4px" }}>💊 Expiry &amp; Batch Tracking</h2>
      <p style={{ color: C.textMid, margin: "0 0 16px", fontSize: 13 }}>
        Pharmacy-only screen. Lives in <code>businessTypes/pharmacy/</code> — edit it
        without touching the shared till, invoicing, or reports.
      </p>
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        {DEMO.map((r, i) => {
          const dl = daysLeft(r.expiry);
          const urgent = dl <= 30;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", background: urgent ? C.dangerLight : C.card, borderBottom: i < DEMO.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: C.text, fontSize: 14 }}>{r.name}</div>
                <div style={{ fontSize: 11, color: C.textLight }}>Batch {r.batch} · Qty {r.qty}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: urgent ? C.danger : C.primary }}>{r.expiry}</div>
                <div style={{ fontSize: 11, color: urgent ? C.danger : C.textLight }}>{dl} days left</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
