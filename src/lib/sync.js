// ═══════════════════════════════════════════════════════════════════
// CLOUD SYNC ENGINE — debounced per-key backup into the client_data doc.
// Extracted verbatim from App.jsx; logic unchanged. Firestore handles are
// injected via initSync() (same pattern as initCloudArchive/initTrialMirror)
// so this module has no direct Firebase import. App.jsx calls initSync once
// after the Firestore db is created, before any screen can render.
// ═══════════════════════════════════════════════════════════════════
let _db=null,_doc=null,_setDoc=null;
export function initSync({db,doc,setDoc}){_db=db;_doc=doc;_setDoc=setDoc;}

const _syncTimers={};
export function debouncedSync(licenseKey,key,data){
  if(_syncTimers[key])clearTimeout(_syncTimers[key]);
  _syncTimers[key]=setTimeout(()=>syncKeyToFirestore(licenseKey,key,data),3000);
}

// Everything below lands in ONE Firestore document, which is capped at 1 MiB.
// A single key that grows without limit therefore takes down the backup of
// every OTHER key with it, and the only symptom is a console warning nobody
// reads. Refuse the oversized key instead, loudly, and keep the rest working.
const MAX_SYNC_FIELD_BYTES=350000;
const _oversizeWarned=new Set();
export async function syncKeyToFirestore(licenseKey,key,data){
  if(!licenseKey)return;
  try{
    const json=JSON.stringify(data);
    const size=new TextEncoder().encode(json).length;
    if(size>MAX_SYNC_FIELD_BYTES){
      if(!_oversizeWarned.has(key)){
        _oversizeWarned.add(key);
        console.error(`[Sync] REFUSING to sync "${key}": ${(size/1024).toFixed(0)} KB exceeds the `+
          `${(MAX_SYNC_FIELD_BYTES/1024).toFixed(0)} KB per-key budget. Syncing it would push `+
          `client_data/${licenseKey} past Firestore's 1 MiB document limit and stop ALL backup `+
          `for this client. If this key needs cloud storage it belongs in a subcollection.`);
      }
      return;
    }
    const docRef=_doc(_db,"client_data",licenseKey);
    // Use setDoc with merge so we don't overwrite other keys
    await _setDoc(docRef,{
      [key]:json,
      [`${key}_updatedAt`]:new Date().toISOString(),
      licenseKey,
      lastSyncAt:new Date().toISOString(),
    },{merge:true});
  }catch(e){
    // Louder than a warning: this is the client's backup failing.
    console.error("[Sync] Failed to sync",key,":",e.message);
  }
}
