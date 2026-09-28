import { useState, useEffect, useCallback } from "react";
import { C } from "../lib/theme.js";

// ─────────────────────────────────────────────────────────────────────────────
// ZATCA verification / connection status.
//
// Answers one question at a glance: is this device actually connected and
// verified with ZATCA, and if not, WHY. Everything shown here comes from the
// backend's /zatca/preflight, which reports — without contacting ZATCA and
// without spending an OTP — service reachability, registration completeness,
// admin approval, key-encryption (KMS) and crypto support, whether the device
// is onboarded with a live production certificate, that certificate's remaining
// life, and the unreported-invoice backlog.
//
// Read-only: it never writes anything. Props keep it decoupled from the
// App.jsx monolith — the parent passes the service URL, an async auth-header
// getter, the license key, and the local reporting queue snapshot.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_ICON = { ok: "✅", warning: "⚠️", blocked: "❌" };

function Row({ icon, title, detail, tone }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderTop: `1px solid ${C.border || "#e5e7eb"}` }}>
      <span style={{ fontSize: 16, lineHeight: "20px" }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: tone || C.text || "#111" }}>{title}</div>
        {detail ? <div style={{ fontSize: 12, color: C.textMid || "#666", marginTop: 2, whiteSpace: "pre-wrap" }}>{detail}</div> : null}
      </div>
    </div>
  );
}

export default function ZatcaVerificationPanel({ licenseKey, serviceUrl, getAuthHeaders, localReporting }) {
  const [state, setState] = useState({ phase: "loading" }); // loading | error | ready
  const [checkedAt, setCheckedAt] = useState(null);

  const runCheck = useCallback(async () => {
    if (!licenseKey) { setState({ phase: "error", reason: "No license key on this device yet — activate RestoPOS first." }); return; }
    setState((s) => ({ ...s, phase: s.data ? s.phase : "loading", refreshing: true }));
    try {
      const res = await fetch(`${serviceUrl}/zatca/preflight`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify({ licenseKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.checks) {
        setState({ phase: "error", reason: data.error || `ZATCA service returned ${res.status}.` });
      } else {
        setState({ phase: "ready", data, refreshing: false });
      }
    } catch (e) {
      setState({ phase: "error", reason: `Cannot reach the ZATCA service — ${e.message}. Check your internet connection.` });
    }
    setCheckedAt(new Date());
  }, [licenseKey, serviceUrl, getAuthHeaders]);

  useEffect(() => { runCheck(); }, [runCheck]);

  // ── Overall verdict ────────────────────────────────────────────────────────
  const data = state.data;
  const egs = data?.egs || {};
  const certLevel = egs.certificateLevel; // ok | warning | critical | expired | unknown
  const certBad = certLevel === "expired" || certLevel === "critical";
  const verified = state.phase === "ready" && data?.ready === true && egs.productionReady === true && !certBad;

  let banner;
  if (state.phase === "loading") {
    banner = { bg: "#f1f5f9", color: C.textMid || "#666", title: "Checking connection…", sub: "" };
  } else if (state.phase === "error") {
    banner = { bg: "#fef2f2", color: C.danger || "#dc2626", title: "❌ Not verified", sub: state.reason };
  } else if (verified) {
    banner = { bg: "#f0fdf4", color: C.success || "#16a34a", title: "✅ Verified & connected", sub: `Reporting live to ZATCA (${data.environment}).` };
  } else {
    // Pick the most useful reason to headline.
    const firstBlocked = (data.checks || []).find((c) => c.status === "blocked");
    let sub;
    if (!egs.onboarded) sub = "This device is not onboarded with ZATCA yet — complete activation below.";
    else if (!egs.productionReady) sub = "Onboarding started but no production certificate yet — finish activation below.";
    else if (certBad) sub = certLevel === "expired" ? "The ZATCA certificate has EXPIRED — renew it with a new FATOORA OTP." : `The ZATCA certificate expires in ${egs.certificateDaysLeft} day(s) — renew it soon.`;
    else if (firstBlocked) sub = firstBlocked.detail;
    else sub = data.note || "Not ready — see the details below.";
    banner = { bg: "#fffbeb", color: C.warning || "#d97706", title: "⚠️ Not verified", sub };
  }

  // ── Reporting health (server backlog + local urgent count) ──────────────────
  const rep = data?.reporting || {};
  const localUrgent = localReporting?.urgent || 0;
  const anyBacklog = (rep.pending || 0) + (rep.failed || 0) + localUrgent > 0;

  return (
    <div style={{ border: `1px solid ${C.border || "#e5e7eb"}`, borderRadius: 12, overflow: "hidden", marginBottom: 16, background: C.card || "#fff" }}>
      {/* Banner */}
      <div style={{ background: banner.bg, padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: banner.color }}>{banner.title}</div>
          <button
            onClick={runCheck}
            disabled={state.refreshing || state.phase === "loading"}
            style={{ background: "transparent", border: `1px solid ${banner.color}`, color: banner.color, borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: state.refreshing ? 0.6 : 1 }}
          >
            {state.refreshing || state.phase === "loading" ? "Checking…" : "↻ Re-check"}
          </button>
        </div>
        {banner.sub ? <div style={{ fontSize: 12.5, color: banner.color, marginTop: 4, opacity: 0.95, whiteSpace: "pre-wrap" }}>{banner.sub}</div> : null}
      </div>

      {/* Detail rows (only when we have a preflight result) */}
      {state.phase === "ready" && (
        <div style={{ padding: "4px 16px 12px" }}>
          {(data.checks || []).map((c, i) => (
            <Row
              key={c.name + i}
              icon={STATUS_ICON[c.status] || "•"}
              title={labelFor(c.name)}
              detail={c.detail}
              tone={c.status === "blocked" ? (C.danger || "#dc2626") : c.status === "warning" ? (C.warning || "#d97706") : undefined}
            />
          ))}

          {/* Device / certificate */}
          <Row
            icon={egs.productionReady ? "✅" : "❌"}
            title="Device activated (production certificate)"
            detail={egs.productionReady
              ? certLevel === "ok"
                ? `Certificate valid — ${egs.certificateDaysLeft} day(s) left.`
                : certLevel === "unknown"
                  ? "Certificate present (expiry unknown)."
                  : certLevel === "expired"
                    ? "Certificate EXPIRED — renew with a new FATOORA OTP."
                    : `Certificate expires in ${egs.certificateDaysLeft} day(s) — renew soon.`
              : egs.onboarded ? "Onboarding started, not finished." : "Not onboarded yet."}
            tone={egs.productionReady ? (certBad ? (C.danger || "#dc2626") : undefined) : (C.danger || "#dc2626")}
          />

          {/* Reporting health */}
          <Row
            icon={anyBacklog ? "⚠️" : "✅"}
            title="Invoice reporting to FATOORA"
            detail={anyBacklog
              ? `${rep.pending || 0} awaiting retry, ${rep.failed || 0} failed on the server${localUrgent ? `, ${localUrgent} nearing the 24h deadline on this device` : ""}. These retry automatically; use “Report to FATOORA” to send now.`
              : "All invoices reported — nothing queued."}
            tone={anyBacklog ? (C.warning || "#d97706") : undefined}
          />

          {data.nextStep ? (
            <div style={{ marginTop: 10, fontSize: 12, color: C.textMid || "#666" }}>
              <strong>Next step:</strong> {data.nextStep}
            </div>
          ) : null}
          {checkedAt ? (
            <div style={{ marginTop: 6, fontSize: 11, color: C.textMid || "#999" }}>
              Last checked {checkedAt.toLocaleTimeString()}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// Friendly labels for the backend's check names.
function labelFor(name) {
  return {
    environment: "ZATCA environment",
    key_encryption: "Key encryption (Cloud KMS)",
    openssl: "Cryptography support",
    temp_folder: "Signing workspace",
    seller_registration: "Business registration & admin approval",
  }[name] || name;
}
