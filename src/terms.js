// ═══════════════════════════════════════════════════════════════════
// TERMS ACCEPTANCE
//
// public/RestoPOS_Terms_and_Conditions.pdf, page 9, specifies this feature
// in full: the "I Agree and Continue" button, the seven acknowledgments a
// client confirms by clicking it, and eight fields the document says are
// "automatically populated from the Client's registration details" and
// "securely saved to the RestoPOS database", with "a copy made available to
// the RestoPOS administrator in the Admin Panel".
//
// None of that existed — the app simply asserted on the Help screen that a
// signed record had been stored. This module is that record.
//
// Every string below is quoted verbatim from the PDF. Do not paraphrase them:
// they are the wording the client is agreeing to, and the app's copy has to
// match the document it points at. If the PDF is revised, bump TERMS_VERSION
// so existing acceptances stay attributable to the version actually agreed.
// ═══════════════════════════════════════════════════════════════════

export const TERMS_VERSION = "1.0";
export const TERMS_DATE = "June 2026";
export const TERMS_TITLE = "RestoPOS Terms and Conditions of Service";
export const TERMS_PDF_PATH = "/RestoPOS_Terms_and_Conditions.pdf";

/** Page 9, "CLIENT ACKNOWLEDGMENT AND ACCEPTANCE" — verbatim. */
export const TERMS_ACKNOWLEDGMENTS = [
  "I have read, understood, and agree to all Terms and Conditions set forth in this document in their entirety.",
  "I accept full and sole legal responsibility for all VAT obligations, tax filings, and ZATCA compliance requirements of my business.",
  "I will NOT engage in tax evasion or any form of financial fraud. If I do so, I alone shall bear all legal, financial, and criminal consequences thereof.",
  "RestoPOS shall bear NO responsibility for my tax compliance failures, regulatory penalties, or any financial misconduct on my part.",
  "I consent to my e-invoice data being transmitted to ZATCA's FATOORA system as required by Saudi law.",
  "I consent to my signed acceptance record being stored by RestoPOS and accessible to the RestoPOS administrator for compliance and legal purposes.",
  "This electronic acceptance constitutes a legally binding agreement under Saudi Arabian law equivalent to a physical signature.",
];

/** The lead-in above the list, page 9 — verbatim. */
export const TERMS_PREAMBLE =
  "By clicking 'I Agree and Continue' within the RestoPOS registration portal, the Client irrevocably confirms and declares that:";

/**
 * Public IP, for the "IP Address (for legal record)" field the document
 * requires. A browser cannot see its own public address, so this asks an
 * external resolver — best-effort, short timeout, and never blocking: an
 * acceptance with no IP is still a valid acceptance, and recording "not
 * captured" is honest where inventing a value would not be.
 */
export async function captureClientIp() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("https://api.ipify.org?format=json", { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    return String(data && data.ip ? data.ip : "").slice(0, 45) || "not captured";
  } catch (e) {
    return "not captured";
  }
}

/**
 * Assemble the record. `details` comes straight from the registration form,
 * so the eight fields are populated from what the client actually typed —
 * "auto-filled from registration", as the document puts it.
 *
 * The electronic signature is the client's own full name, which is what page 9
 * specifies: "[Auto-filled: Client Full Name as electronic signature]".
 */
export function buildAcceptanceRecord(details, ipAddress) {
  const now = new Date();
  const signature = String(details.ownerName || details.businessName || "").trim();
  return {
    accepted: true,
    version: TERMS_VERSION,
    document: `${TERMS_TITLE} v${TERMS_VERSION} — ${TERMS_DATE}`,
    acceptedAt: now.toISOString(),
    fullName: signature,
    businessName: String(details.businessName || "").trim(),
    email: String(details.email || "").trim().toLowerCase(),
    phone: String(details.phone || "").trim(),
    vatNumber: String(details.vatNumber || "").trim(),
    crNumber: String(details.crNumber || "").trim(),
    ipAddress: ipAddress || "not captured",
    electronicSignature: signature,
    userAgent: (typeof navigator !== "undefined" ? navigator.userAgent : "").slice(0, 180),
    acknowledgments: TERMS_ACKNOWLEDGMENTS,
    accountType: details.accountType || "registered",
  };
}

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmtStamp = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-SA", {
      day: "2-digit", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch (e) { return iso; }
};

/**
 * The client's filled copy: an A4 certificate carrying their details, the
 * acknowledgments they confirmed, and the acceptance timestamp.
 *
 * It deliberately does NOT restate the twelve sections of the agreement. The
 * signed PDF remains the authoritative legal text and travels alongside this;
 * retyping it into HTML would risk a transcription drifting from the document
 * the client actually agreed to.
 */
export function buildAcceptanceCertificateHTML(record, license) {
  const r = record || {};
  const lic = license || {};
  const rows = [
    ["Full Name / Business Name", r.fullName || r.businessName],
    ["Business Name", r.businessName],
    ["Email Address", r.email],
    ["Phone Number", r.phone],
    ["VAT Registration Number", r.vatNumber || "— not provided —"],
    ["Commercial Register (CR) No.", r.crNumber || "— not provided —"],
    ["Date and Time of Acceptance", fmtStamp(r.acceptedAt)],
    ["IP Address (for legal record)", r.ipAddress],
    ["Electronic Signature", r.electronicSignature],
  ];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<title>RestoPOS — Acceptance Record — ${esc(r.businessName || "")}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  *{box-sizing:border-box}
  body{margin:0;font-family:Helvetica,Arial,sans-serif;color:#12181f;font-size:11.5px;line-height:1.6}
  .head{border-bottom:2px solid #1A2E4A;padding-bottom:14px;margin-bottom:20px}
  .brand{font-size:20px;font-weight:bold;color:#1A2E4A;letter-spacing:-0.3px}
  .sub{font-size:11px;color:#5D6D7E;margin-top:3px}
  h1{font-size:14px;margin:0 0 4px;letter-spacing:0.06em;text-transform:uppercase;color:#1A2E4A}
  .meta{font-size:10px;color:#5D6D7E}
  .panel{border:1px solid #D6DDE8;border-radius:6px;padding:14px 16px;margin:16px 0;background:#F7F9FC}
  .ack{display:flex;gap:9px;margin-bottom:9px;font-size:11px;page-break-inside:avoid}
  .tick{font-weight:bold;color:#1A6B4A;flex:none}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  td{padding:8px 10px;border-bottom:1px solid #E4E9F0;vertical-align:top}
  td.k{width:44%;color:#5D6D7E;font-size:10.5px}
  td.v{font-weight:bold;font-family:"Courier New",monospace;font-size:11.5px;word-break:break-word}
  .sign{margin-top:22px;padding-top:14px;border-top:1px dashed #9AA7B8;page-break-inside:avoid}
  .sigline{font-family:"Courier New",monospace;font-size:16px;font-weight:bold;letter-spacing:0.5px;margin-top:6px}
  .foot{margin-top:26px;padding-top:10px;border-top:1px solid #D6DDE8;font-size:9px;color:#7A8798;text-align:center;line-height:1.7}
  .note{font-size:10px;color:#5D6D7E;margin-top:10px;font-style:italic}
</style></head><body>
  <div class="head">
    <div class="brand">RestoPOS</div>
    <div class="sub">Terms &amp; Conditions of Service — Kingdom of Saudi Arabia</div>
  </div>

  <h1>Client Acknowledgment and Acceptance</h1>
  <div class="meta">
    Document: ${esc(r.document || `${TERMS_TITLE} v${TERMS_VERSION}`)}
    ${lic.licenseKey ? ` &nbsp;·&nbsp; Account: ${esc(lic.licenseKey)}` : ""}
  </div>

  <div class="panel">
    <div style="font-size:11px;margin-bottom:11px">${esc(TERMS_PREAMBLE)}</div>
    ${(r.acknowledgments || TERMS_ACKNOWLEDGMENTS)
      .map((a) => `<div class="ack"><span class="tick">[X]</span><span>${esc(a)}</span></div>`)
      .join("")}
  </div>

  <table>
    ${rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v || "—")}</td></tr>`).join("")}
  </table>

  <div class="sign">
    <div style="font-size:10px;color:#5D6D7E">Accepted electronically by</div>
    <div class="sigline">${esc(r.electronicSignature || r.fullName || "—")}</div>
    <div style="font-size:10px;color:#5D6D7E;margin-top:5px">${esc(fmtStamp(r.acceptedAt))}</div>
    <div class="note">
      This electronic acceptance constitutes a legally binding agreement under Saudi Arabian
      law equivalent to a physical signature. This record accompanies, and does not replace,
      the full Terms and Conditions of Service document.
    </div>
  </div>

  <div class="foot">
    RestoPOS &nbsp;|&nbsp; Terms &amp; Conditions of Service &nbsp;|&nbsp; Confidential Legal Document<br/>
    &copy; 2026 RestoPOS. All rights reserved. &nbsp;|&nbsp; restopos.store &nbsp;|&nbsp; restopos.noreply@gmail.com<br/>
    Generated ${esc(fmtStamp(new Date().toISOString()))}
  </div>
</body></html>`;
}

/** Open the certificate in a print window so the client can save it as a PDF. */
export function printAcceptanceCertificate(record, license) {
  const html = buildAcceptanceCertificateHTML(record, license);
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(frame);
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) {}
    setTimeout(() => { try { document.body.removeChild(frame); } catch (e) {} }, 60000);
  }, 350);
}
