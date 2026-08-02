// ═══════════════════════════════════════════════════
// EMAILJS — client-side transactional email (device-verification code and
// the OTP generator). Public keys by design; real secrets live server-side.
// Extracted verbatim from App.jsx.
// ═══════════════════════════════════════════════════

// ── EmailJS helper ──────────────────────────────────────────────────
export const EMAILJS_SERVICE="service_mxln2w4";
export const EMAILJS_VERIFY_TEMPLATE="template_v28ss1y";
export const EMAILJS_RESET_TEMPLATE="template_444v50v";
export const EMAILJS_PUBLIC_KEY="jlfUG0WjJ3UVXUgCb";
export async function sendEmailJS(templateId,params){
  const res=await fetch("https://api.emailjs.com/api/v1.0/email/send",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({service_id:EMAILJS_SERVICE,template_id:templateId,user_id:EMAILJS_PUBLIC_KEY,template_params:params})
  });
  if(!res.ok)throw new Error("Email send failed: "+res.status);
}
export function generateCode(){return String(Math.floor(100000+Math.random()*900000));}
