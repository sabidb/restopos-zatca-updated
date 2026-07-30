// ═══════════════════════════════════════════════════════════════════
// HTML ESCAPING — tiny pure helpers shared by every print/HTML builder.
// Extracted verbatim from App.jsx; behaviour unchanged.
// ═══════════════════════════════════════════════════════════════════
export function _escHTML(s){if(s===0)return"0";if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
// Convert multi-line text (with newlines) into safe HTML with <br> between lines
export function _escMultiline(s){if(!s)return"";return String(s).split(/\r?\n/).map(_escHTML).join("<br/>");}
