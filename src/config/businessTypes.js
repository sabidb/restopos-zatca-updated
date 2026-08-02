// ═══════════════════════════════════════════════════════════════════
// COMPAT SHIM. The business-type registry now lives in its own feature
// folder, one sub-folder per type: src/businessTypes/.
//
// This file re-exports it so existing imports (`./config/businessTypes.js`)
// keep working unchanged. Prefer importing from "../businessTypes/index.js"
// in new code. Do not add type definitions here — add them under
// src/businessTypes/<type>/.
// ═══════════════════════════════════════════════════════════════════
export * from "../businessTypes/index.js";
