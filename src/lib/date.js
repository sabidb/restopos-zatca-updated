// ═══════════════════════════════════════════════════════════════════
// SHARED DATE CONSTANTS.
// Extracted verbatim from App.jsx; value unchanged. TODAY is the local
// calendar date (YYYY-MM-DD) captured once at module load — identical
// timing to before, since this module loads as part of App.jsx's import
// graph before the app renders.
// ═══════════════════════════════════════════════════════════════════
export const TODAY=new Date().toISOString().split("T")[0];
