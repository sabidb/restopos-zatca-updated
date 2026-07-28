// ═══════════════════════════════════════════════════════════════════
// KILL-SWITCH / ADMIN-PROPAGATION TEST
//
// Everything the admin panel does to an account has to reach the till while
// it is running, without a reload. This drives the real app in a real browser
// against the local emulators and measures how long each change takes to
// land, because "immediately" is the requirement and it should be checked
// rather than assumed.
//
// It exists because the wiring silently didn't work: revoking a key from the
// Licenses tab wrote licenses/{key}.active and the client only ever watched
// pending_activations/{key}, so the key went red in the admin panel while the
// shop carried on selling. A build catches none of that.
//
// Run it:
//   1. npx firebase emulators:start --only firestore,auth \
//        --project restopos-db --config firebase.emulator.json
//   2. VITE_USE_EMULATORS=1 npx vite --port 5300 --host 127.0.0.1
//   3. node e2e/killswitch.mjs
//
// Needs playwright available (npx playwright, or a preinstalled browser at
// PLAYWRIGHT_BROWSERS_PATH). Deliberately not wired into CI: it needs two
// long-running processes and a browser, which is a heavier contract than the
// rules suite. Run it whenever you touch the watchdog.
// ═══════════════════════════════════════════════════════════════════
import { chromium } from 'playwright';
const SP=process.env.SCREENSHOT_DIR||'/tmp';
const BASE='http://127.0.0.1:8080/v1/projects/restopos-db/databases/(default)/documents';
const KEY='RESTOTEST1';

// The emulator honours "Bearer owner" as an Admin-SDK-equivalent caller, so the
// seed and the admin actions below bypass rules exactly like the real admin
// panel's privileged writes do.
const H={'Authorization':'Bearer owner','Content-Type':'application/json'};
const v=(x)=> typeof x==='boolean'?{booleanValue:x}: typeof x==='number'?{integerValue:String(x)}
  : Array.isArray(x)?{arrayValue:{values:x.map(v)}} : {stringValue:String(x)};
const fields=(o)=>Object.fromEntries(Object.entries(o).map(([k,x])=>[k,v(x)]));

async function put(path,obj){
  const r=await fetch(`${BASE}/${path}`,{method:'PATCH',headers:H,body:JSON.stringify({fields:fields(obj)})});
  if(!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
}
async function patch(path,obj){
  const mask=Object.keys(obj).map(k=>`updateMask.fieldPaths=${k}`).join('&');
  const r=await fetch(`${BASE}/${path}?${mask}`,{method:'PATCH',headers:H,body:JSON.stringify({fields:fields(obj)})});
  if(!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
}

// ── Seed one healthy, approved client ──────────────────────────────
await put(`licenses/${KEY}`,{key:KEY,active:true,activatedBy:'1010101010',plan:'premium'});
await put(`pending_activations/${KEY}`,{
  licenseKey:KEY, businessName:'Al Bahr Supermarket', status:'approved',
  credentialsApproved:true, isActive:true, forceLogout:false,
  subscriptionPlan:'premium', customExpiryDate:'2030-12-31',
  activatedAt:'2026-01-01T00:00:00.000Z',
});
console.log('seeded licence + approved account\n');

const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const ctx=await b.newContext({viewport:{width:1280,height:900}});
const p=await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text();
  if(m.type()==='error'&&!/favicon|manifest|net::ERR|Failed to load resource|preload|installations|Could not reach/i.test(t)) errs.push('CONSOLE: '+t.slice(0,140));});

// Put a licence on the device, the way a logged-in till has one.
await p.goto('http://127.0.0.1:5300/',{waitUntil:'domcontentloaded'});
await p.evaluate((k)=>{
  localStorage.setItem('restopos_license_v2',JSON.stringify({
    licenseKey:k,businessName:'Al Bahr Supermarket',businessType:'supermarket',
    subscriptionPlan:'premium',vatNumber:'300123456700003',crNumber:'1010101010'}));
  localStorage.setItem('restopos_client_creds',JSON.stringify({
    salt:'x',hash:'y',username:'albahr',active:true,approved:true}));
},KEY);
await p.goto('http://127.0.0.1:5300/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(4000);

const txt=async()=>(await p.locator('body').innerText()).replace(/\s+/g,' ');
const locked=async()=>/Account Deactivated/.test(await txt());
const sessionEnded=async()=>/Session Ended/.test(await txt());

console.log('1. healthy client is NOT locked out:', await locked()?'❌ wrongly locked':'✅');
await p.screenshot({path:SP+'/80-healthy.png'});

// Wait for a condition with a deadline, so "immediately" is measured not assumed.
async function waitFor(fn,label,ms=12000){
  const t0=Date.now();
  while(Date.now()-t0<ms){ if(await fn()) return Date.now()-t0; await p.waitForTimeout(250); }
  return -1;
}

// ══ THE BUG: revoking from the Licenses tab (licenses/{key}.active=false) ══
await patch(`licenses/${KEY}`,{active:false});
let el=await waitFor(locked,'revoke');
console.log('2. Licenses-tab REVOKE locks the till: ', el>=0?`✅ in ${el}ms`:'❌ never locked');
await p.screenshot({path:SP+'/81-revoked.png'});

// Restoring must let them back in without a reload.
await patch(`licenses/${KEY}`,{active:true});
el=await waitFor(async()=>!(await locked()),'restore');
console.log('3. restoring the licence unlocks it:  ', el>=0?`✅ in ${el}ms`:'❌ stayed locked');

// ══ Clients-tab Deactivate (status + isActive) ══
await patch(`pending_activations/${KEY}`,{status:'deactivated',isActive:false});
el=await waitFor(locked,'deactivate');
console.log('4. Clients-tab DEACTIVATE locks it:   ', el>=0?`✅ in ${el}ms`:'❌ never locked');
await patch(`pending_activations/${KEY}`,{status:'approved',isActive:true});
await waitFor(async()=>!(await locked()));

// ══ isActive alone, with status left untouched ══
await patch(`pending_activations/${KEY}`,{isActive:false});
el=await waitFor(locked,'isActive only');
console.log('5. isActive:false ALONE locks it:     ', el>=0?`✅ in ${el}ms`:'❌ never locked');
await patch(`pending_activations/${KEY}`,{isActive:true});
await waitFor(async()=>!(await locked()));

// ══ Force logout ══
await patch(`pending_activations/${KEY}`,{forceLogout:true});
el=await waitFor(sessionEnded,'forceLogout');
console.log('6. FORCE LOGOUT ends the session:     ', el>=0?`✅ in ${el}ms`:'❌ never ended');
await p.screenshot({path:SP+'/82-forcelogout.png'});
await patch(`pending_activations/${KEY}`,{forceLogout:false});
await waitFor(async()=>!(await sessionEnded()));

// ══ Admin password reset must end the session too ══
await patch(`pending_activations/${KEY}`,{passwordResetByAdmin:true,credentialsApproved:false});
el=await waitFor(sessionEnded,'password reset');
console.log('7. ADMIN PASSWORD RESET ends session: ', el>=0?`✅ in ${el}ms`:'❌ never ended');

await patch(`pending_activations/${KEY}`,{passwordResetByAdmin:false,credentialsApproved:true});
await waitFor(async()=>!(await sessionEnded()));

// ══ Both verdicts at once: clearing one must not unlock the other ══
await patch(`licenses/${KEY}`,{active:false});
await patch(`pending_activations/${KEY}`,{status:'deactivated',isActive:false});
await waitFor(locked);
await patch(`pending_activations/${KEY}`,{status:'approved',isActive:true});
await p.waitForTimeout(1500);
console.log('8. still locked while licence revoked:', await locked()?'✅':'❌ unlocked too early');
await patch(`licenses/${KEY}`,{active:true});
el=await waitFor(async()=>!(await locked()));
console.log('9. unlocks once BOTH are restored:    ', el>=0?`✅ in ${el}ms`:'❌ stayed locked');

// ══ Plan change must reach the client ══
await patch(`pending_activations/${KEY}`,{subscriptionPlan:'basic'});
el=await waitFor(async()=>await p.evaluate(()=>
  (JSON.parse(localStorage.getItem('restopos_license_v2')||'{}').subscriptionPlan)==='basic'));
console.log('10. PLAN CHANGE reaches the client:   ', el>=0?`✅ in ${el}ms`:'❌ never arrived');
await patch(`pending_activations/${KEY}`,{subscriptionPlan:'premium'});

// ══ Expiry must lock the till ══
await patch(`pending_activations/${KEY}`,{customExpiryDate:'2026-01-01'});
el=await waitFor(async()=>/Subscription Expired/.test(await txt()));
console.log('11. EXPIRY DATE locks the till:       ', el>=0?`✅ in ${el}ms`:'❌ never locked');
await p.screenshot({path:SP+'/83-expired.png'});
await patch(`pending_activations/${KEY}`,{customExpiryDate:'2030-12-31'});
el=await waitFor(async()=>!/Subscription Expired/.test(await txt()));
console.log('12. EXTENDING expiry unlocks it:      ', el>=0?`✅ in ${el}ms`:'❌ stayed locked');

// ══ NOT COVERED HERE: the admin notification popup ══
// It renders inside the logged-in app shell, and reaching that needs the
// verifyLogin Cloud Function, which does not run in this emulator setup. The
// device above stops at the Sign In screen — which is itself worth noting,
// because every lockout above was asserted from there: a revoked client is
// stopped before it can even reach the login prompt. If you extend this to
// cover the notification, log in for real first rather than faking a session.

console.log('\nPAGE ERRORS:', errs.length?errs.slice(0,5):'none ✅');
await b.close();
