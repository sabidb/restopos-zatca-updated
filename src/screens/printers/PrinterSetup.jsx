// ═══════════════════════════════════════════════════════════════════
// PRINTER SETUP — the one screen a new client needs to get thermal
// printing working: connect, pick the bill printer, add kitchen stations,
// test each one. Everything prints silently; there is no dialog anywhere.
//
// The QZ engine functions are passed in as props (`api`) rather than
// imported, because the engine still lives in App.jsx alongside the
// Firebase-backed request signing.
// ═══════════════════════════════════════════════════════════════════
import { useState, useEffect } from "react";
import { C } from "../../lib/theme.js";
import { LS } from "../../lib/storage.js";
import { Card, Btn, Inp } from "../../components/ui.jsx";
import { getStations, saveStations, makeStation } from "../../lib/printerStations.js";

const TEST_BILL = (name) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:80mm auto;margin:0}body{font-family:'Courier New',monospace;font-size:12px;width:80mm;padding:4mm;margin:0}.c{text-align:center}.b{font-weight:bold}hr{border:none;border-top:1px dashed #000;margin:6px 0}</style></head><body><div class="c b" style="font-size:16px">${name||"RestoPOS"}</div><hr/><div class="c b">TEST PRINT</div><div class="c">Bill printer is working</div><div class="c" style="direction:rtl;font-family:Tahoma,Arial">الطابعة تعمل</div><hr/><div class="c" style="font-size:10px">${new Date().toLocaleString("en-SA")}</div><br/><br/></body></html>`;

const TEST_KOT = (station) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:${station.paperWidth||"80mm"} auto;margin:0}body{font-family:'Courier New',monospace;font-size:14px;width:${station.paperWidth||"80mm"};padding:4mm;margin:0;text-align:center}hr{border:none;border-top:2px dashed #000;margin:6px 0}</style></head><body><div style="font-size:19px;font-weight:900">*** KOT TEST ***</div><div>${station.name||"Kitchen"}</div><hr/><div>This station is working</div><div style="direction:rtl;font-family:Tahoma,Arial">هذه المحطة تعمل</div><hr/><div style="font-size:10px">${new Date().toLocaleString("en-SA")}</div><br/><br/></body></html>`;

export function PrinterSetup({ api = {}, categories = [] }) {
  const { connectQZ, isQZConnected, loadQZ, printSilent, listPrinters } = api;
  const [status, setStatus] = useState("checking"); // checking | connected | disconnected
  const [printers, setPrinters] = useState([]);
  const [billPrinter, setBill] = useState(() => { try { return localStorage.getItem("restopos_qz_bill_printer") || ""; } catch (e) { return ""; } });
  const [stations, setStations] = useState(() => getStations());
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const license = LS.get("restopos_license_v2") || {};

  useEffect(() => { detect(); /* eslint-disable-next-line */ }, []);

  async function detect() {
    setStatus("checking"); setNote("");
    try {
      const ok = await loadQZ?.();
      if (!ok) { setStatus("disconnected"); return; }
      if (!isQZConnected?.()) await connectQZ?.();
      if (isQZConnected?.()) {
        const list = (await listPrinters?.()) || [];
        setPrinters(list);
        setStatus("connected");
        // Nothing chosen yet and printers exist → pick the first so a new
        // client is printing immediately instead of hunting through a dropdown.
        if (!billPrinter && list.length) selectBill(list[0]);
      } else setStatus("disconnected");
    } catch (e) { setStatus("disconnected"); setNote(e?.message || "Could not reach QZ Tray"); }
  }

  function selectBill(name) {
    setBill(name);
    try { localStorage.setItem("restopos_qz_bill_printer", name); } catch (e) {}
  }

  function updateStations(next) { setStations(saveStations(next)); }

  function addStation() {
    updateStations([...stations, makeStation({
      name: stations.length ? `Station ${stations.length + 1}` : "Kitchen",
      printer: printers[0] || "",
    })]);
  }
  function patchStation(id, patch) { updateStations(stations.map((s) => (s.id === id ? { ...s, ...patch } : s))); }
  function removeStation(id) { updateStations(stations.filter((s) => s.id !== id)); }

  function toggleCategory(st, cat) {
    const has = (st.categories || []).includes(cat);
    patchStation(st.id, { categories: has ? st.categories.filter((c) => c !== cat) : [...(st.categories || []), cat] });
  }

  async function test(kind, station) {
    const key = kind === "bill" ? "bill" : station.id;
    setBusy(key); setNote("");
    try {
      const html = kind === "bill" ? TEST_BILL(license.businessName) : TEST_KOT(station);
      const via = await printSilent?.(html, {
        printer: kind === "bill" ? billPrinter : station.printer,
        paperWidth: kind === "bill" ? (LS.get("restopos_invoice_format") || {}).paperWidth || "80mm" : station.paperWidth || "80mm",
      });
      setNote(via === "QZ Tray" ? "✅ Sent silently via QZ Tray." : "✅ Sent to the computer's default printer (install QZ Tray to choose the exact printer).");
    } catch (e) { setNote("❌ Print failed: " + (e?.message || "unknown error")); }
    setBusy("");
  }

  const dot = { connected: C.success, disconnected: C.danger, checking: C.warning }[status];
  const label = { connected: "Ready — printing is silent", disconnected: "QZ Tray not detected", checking: "Checking…" }[status];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Status */}
      <Card style={{ border: `2px solid ${dot}44` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: dot, display: "inline-block" }} />
              <span style={{ fontSize: 16, fontWeight: 800, color: dot }}>{label}</span>
            </div>
            <div style={{ fontSize: 12, color: C.textMid, marginTop: 4 }}>
              {status === "connected"
                ? `${printers.length} printer(s) found on this computer`
                : "Without QZ Tray, printing still works — it goes to this computer's default printer instead."}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn onClick={detect} variant="outline" size="sm">🔄 Detect printers</Btn>
            {status === "disconnected" && (
              <a href="https://qz.io/download" target="_blank" rel="noreferrer"
                style={{ padding: "7px 14px", background: C.primary, color: "#fff", borderRadius: 8, fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
                ⬇️ Install QZ Tray
              </a>
            )}
          </div>
        </div>
        {note && <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: note.startsWith("❌") ? C.danger : C.success }}>{note}</div>}
      </Card>

      {/* Bill printer */}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>🧾 Bill printer</div>
        <div style={{ fontSize: 12, color: C.textMid, marginBottom: 10 }}>Receipts and invoices print here — silently, no dialog.</div>
        {printers.length ? (
          <select value={billPrinter} onChange={(e) => selectBill(e.target.value)}
            style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${billPrinter ? C.success : C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: "#fff", marginBottom: 10 }}>
            <option value="">— Select bill printer —</option>
            {printers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: 12, color: C.textMid, marginBottom: 10 }}>No printer list yet — the OS default printer will be used.</div>
        )}
        <Btn onClick={() => test("bill")} disabled={busy === "bill"} color={C.success} size="sm">
          {busy === "bill" ? "Printing…" : "🖨️ Test bill print"}
        </Btn>
      </Card>

      {/* Kitchen stations */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800 }}>🍽️ Kitchen stations</div>
            <div style={{ fontSize: 12, color: C.textMid, marginTop: 2 }}>
              Add one per kitchen (Grill, Juice, Bakery…). Each prints only the categories you tick — tick none and it prints everything.
            </div>
          </div>
          <Btn onClick={addStation} size="sm">+ Add station</Btn>
        </div>

        {!stations.length && (
          <div style={{ fontSize: 12, color: C.textMid, padding: "14px 0" }}>
            No kitchen stations yet. Add one if food tickets should print in the kitchen.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10 }}>
          {stations.map((st) => (
            <div key={st.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, background: C.bg }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                <Inp label="Station name" value={st.name || ""} onChange={(v) => patchStation(st.id, { name: v })} placeholder="Grill" style={{ flex: "1 1 160px" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 200px" }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: C.textMid }}>Printer</label>
                  {printers.length ? (
                    <select value={st.printer || ""} onChange={(e) => patchStation(st.id, { printer: e.target.value })}
                      style={{ padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: "#fff" }}>
                      <option value="">— Select —</option>
                      {printers.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  ) : (
                    <input value={st.printer || ""} onChange={(e) => patchStation(st.id, { printer: e.target.value })} placeholder="Printer name"
                      style={{ padding: "9px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: C.textMid }}>Paper</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    {["58mm", "80mm"].map((w) => (
                      <button key={w} onClick={() => patchStation(st.id, { paperWidth: w })}
                        style={{ padding: "9px 12px", border: `2px solid ${st.paperWidth === w ? C.primary : C.border}`, borderRadius: 8, background: st.paperWidth === w ? C.primaryLight : "#fff", color: st.paperWidth === w ? C.primary : C.textMid, fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{w}</button>
                    ))}
                  </div>
                </div>
              </div>

              {categories.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 6 }}>
                    Prints these categories {(!st.categories || !st.categories.length) && <span style={{ color: C.primary, fontWeight: 700 }}>· everything</span>}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {categories.map((cat) => {
                      const on = (st.categories || []).includes(cat);
                      return (
                        <button key={cat} onClick={() => toggleCategory(st, cat)}
                          style={{ padding: "6px 12px", borderRadius: 20, border: `1.5px solid ${on ? C.primary : C.border}`, background: on ? C.primaryLight : "#fff", color: on ? C.primary : C.textMid, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                          {on ? "✓ " : ""}{cat}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                <Btn onClick={() => test("kot", st)} disabled={busy === st.id} color={C.success} size="sm">
                  {busy === st.id ? "Printing…" : "🖨️ Test this station"}
                </Btn>
                <Btn onClick={() => patchStation(st.id, { enabled: st.enabled === false })} variant="outline" size="sm">
                  {st.enabled === false ? "Enable" : "Disable"}
                </Btn>
                <Btn onClick={() => removeStation(st.id)} color={C.danger} variant="outline" size="sm">Remove</Btn>
                {st.enabled === false && <span style={{ fontSize: 11, color: C.textLight, fontWeight: 700 }}>Disabled — no tickets</span>}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
