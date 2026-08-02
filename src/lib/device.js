// ═══════════════════════════════════════════════════════════════════
// DEVICE HELPERS — identify the current device for the "approve new
// device" flow and the admin device list. Browser-only (navigator /
// localStorage / crypto); no app dependencies. Extracted verbatim.
// ═══════════════════════════════════════════════════════════════════

export function getDeviceInfo(){
  const ua=navigator.userAgent;
  const brand=ua.includes("iPhone")||ua.includes("iPad")?"Apple":ua.includes("Samsung")?"Samsung":ua.includes("Huawei")?"Huawei":"Unknown";
  const os=ua.includes("iPhone")||ua.includes("iPad")?"iOS":ua.includes("Android")?"Android":ua.includes("Windows")?"Windows":ua.includes("Mac")?"macOS":"Other";
  const browser=ua.includes("Chrome")?"Chrome":ua.includes("Firefox")?"Firefox":ua.includes("Safari")?"Safari":ua.includes("Edge")?"Edge":"Other";
  return{brand,os,browser,userAgent:ua.slice(0,120),screenW:screen.width,screenH:screen.height};
}

// ── Stable per-device ID (persists in localStorage) ──────────────────
// Used for the "approve new device" flow: each physical device gets one
// random ID the first time it's seen, and stays the same across logins.
export function getDeviceId(){
  let id=null;
  try{id=localStorage.getItem("restopos_device_id");}catch(e){}
  if(!id){
    id=(crypto.randomUUID?crypto.randomUUID():`dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try{localStorage.setItem("restopos_device_id",id);}catch(e){}
  }
  return id;
}

// Short human-readable label for a device, shown in the admin approve list.
export function getDeviceLabel(){
  const ua=navigator.userAgent||"";
  let os="Unknown";
  if(/Windows/i.test(ua))os="Windows";else if(/Android/i.test(ua))os="Android";
  else if(/iPhone|iPad|iPod/i.test(ua))os="iOS";else if(/Mac/i.test(ua))os="Mac";else if(/Linux/i.test(ua))os="Linux";
  let br="Browser";
  if(/Edg\//i.test(ua))br="Edge";else if(/Chrome\//i.test(ua))br="Chrome";
  else if(/Firefox\//i.test(ua))br="Firefox";else if(/Safari\//i.test(ua))br="Safari";
  return `${os} · ${br}`;
}
