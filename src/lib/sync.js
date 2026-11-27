// ═══════════════════════════════════════════════════════════════════
// CLOUD SYNC ENGINE — debounced per-key backup into the client_data doc.
// Extracted verbatim from App.jsx; logic unchanged. Firestore handles are
// injected via initSync() (same pattern as initCloudArchive/initTrialMirror)
// so this module has no direct Firebase import. App.jsx calls initSync once
// after the Firestore db is created, before any screen can render.
// ═══════════════════════════════════════════════════════════════════
let _db=null,_doc=null,_setDoc=null,_runTransaction=null;
import { mergeRecordsById, isRecordArrayKey } from "./syncMerge.js";
export function initSync({db,doc,setDoc,runTransaction}){_db=db;_doc=doc;_setDoc=setDoc;_runTransaction=runTransaction;}

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
export const SYNC_FIELD_BUDGET_BYTES=MAX_SYNC_FIELD_BYTES;
const _oversizeWarned=new Set();

// Observable per-key sync status, so the app can show a sync-health view instead
// of relying on console warnings nobody reads. In-memory only (resets on reload);
// records the last outcome of each key's sync attempt this session.
const _syncStatus={};
export function getSyncStatus(){
  const out={};
  for(const k in _syncStatus) out[k]={..._syncStatus[k]};
  return out;
}

export async function syncKeyToFirestore(licenseKey,key,data){
  if(!licenseKey)return;
  try{
    const json=JSON.stringify(data);
    const size=new TextEncoder().encode(json).length;
    if(size>MAX_SYNC_FIELD_BYTES){
      _syncStatus[key]={key,ok:false,reason:"oversize",sizeBytes:size,budgetBytes:MAX_SYNC_FIELD_BYTES,at:new Date().toISOString()};
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
    const updatedAt=new Date().toISOString();
    // Merge record arrays transactionally to prevent concurrent tills from
    // replacing one another with stale local snapshots.
    if(_runTransaction && isRecordArrayKey(key)){
      await _runTransaction(_db,async tx=>{
        const snap=await tx.get(docRef);
        const cloudRaw=snap.exists()?snap.data()?.[key]:null;
        let cloudParsed=[];
        try{cloudParsed=cloudRaw?JSON.parse(cloudRaw):[];}catch(_){cloudParsed=[];}
        const merged=mergeRecordsById(Array.isArray(data)?data:[],Array.isArray(cloudParsed)?cloudParsed:[]);
        const mergedJson=JSON.stringify(merged);
        const mergedSize=new TextEncoder().encode(mergedJson).length;
        if(mergedSize>MAX_SYNC_FIELD_BYTES)throw new Error(`Merged ${key} exceeds sync budget (${mergedSize} bytes)`);
        tx.set(docRef,{[key]:mergedJson,[`${key}_updatedAt`]:updatedAt,licenseKey,lastSyncAt:updatedAt},{merge:true});
      });
    }else{
      await _setDoc(docRef,{[key]:json,[`${key}_updatedAt`]:updatedAt,licenseKey,lastSyncAt:updatedAt},{merge:true});
    }
    _syncStatus[key]={key,ok:true,sizeBytes:size,at:new Date().toISOString()};
  }catch(e){
    // Louder than a warning: this is the client's backup failing.
    _syncStatus[key]={key,ok:false,reason:"error",message:e.message,at:new Date().toISOString()};
    console.error("[Sync] Failed to sync",key,":",e.message);
  }
}
