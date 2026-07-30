// ═══════════════════════════════════════════════════════════════════
// FORMAT HELPERS — currency and date/time formatting.
// Extracted verbatim from App.jsx; behaviour unchanged.
// ═══════════════════════════════════════════════════════════════════
export function fmtSAR(n){return"SAR "+Number(n).toFixed(2);}
export function fmtDate(d){return new Date(d).toLocaleDateString("en-SA",{day:"2-digit",month:"short",year:"numeric"});}
export function fmtDateTime(d){return new Date(d).toLocaleString("en-SA",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});}
