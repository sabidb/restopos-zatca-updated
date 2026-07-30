// ═══════════════════════════════════════════════════════════════════
// LOCAL STORAGE HELPER — thin, safe JSON wrapper around localStorage.
// Extracted verbatim from App.jsx; behaviour unchanged. `get` swallows
// parse errors and returns null so a corrupt key never crashes the app.
// ═══════════════════════════════════════════════════════════════════
export const LS={get:(k)=>{try{return JSON.parse(localStorage.getItem(k));}catch{return null;}},set:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),del:(k)=>localStorage.removeItem(k)};
