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
const PENDING_SYNC_KEY="restopos_sync_pending_v1";
const _memoryQueue={};
let _queueInitialized=false;
function queueId(licenseKey,key){return String(licenseKey)+"::"+String(key);}
function readQueue(){
  if(!_queueInitialized){
    let persisted={};try{persisted=JSON.parse(localStorage.getItem(PENDING_SYNC_KEY)||"{}")||{};}catch(_){persisted={};}
    Object.assign(_memoryQueue,persisted);_queueInitialized=true;
  }
  return {..._memoryQueue};
}
function writeQueue(queue){
  Object.keys(_memoryQueue).forEach(k=>delete _memoryQueue[k]);
  Object.assign(_memoryQueue,queue||{});_queueInitialized=true;
  try{localStorage.setItem(PENDING_SYNC_KEY,JSON.stringify(queue||{}));}catch(e){console.warn("[Sync] pending queue could not persist locally:",e?.message);}
  try{if(typeof window!=="undefined")window.dispatchEvent(new Event("restopos-sync-status"));}catch(_){ }
  return true;
}
function updateQueueEntry(licenseKey,key,patch={},reset=false){
  const queue=readQueue(),id=queueId(licenseKey,key),prev=queue[id]||{};
  queue[id]={...prev,...(reset?{queuedAt:new Date().toISOString(),attempts:0,lastError:null,blocked:false}:{}),...patch,licenseKey,key};
  writeQueue(queue);return queue[id];
}
function removeQueueEntry(licenseKey,key){
  const queue=readQueue();delete queue[queueId(licenseKey,key)];writeQueue(queue);
}
export function getPendingSyncQueue(){return Object.values(readQueue()).map(x=>({...x}));}
export function debouncedSync(licenseKey,key,data){
  if(!licenseKey)return;
  updateQueueEntry(licenseKey,key,{lastDataAt:new Date().toISOString(),blocked:false,reason:null,lastError:null},true);
  const timerId=queueId(licenseKey,key);
  if(_syncTimers[timerId])clearTimeout(_syncTimers[timerId]);
  _syncTimers[timerId]=setTimeout(()=>syncKeyToFirestore(licenseKey,key,data),3000);
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
  for(const q of Object.values(readQueue())){
    const id=q.key;
    if(!id)continue;
    // A pending queue entry supersedes any stale last-success status.
    out[id]={key:id,ok:false,reason:q.blocked?"oversize":"pending",message:q.lastError||"Waiting for cloud sync",queuedAt:q.queuedAt,attempts:q.attempts||0,blocked:!!q.blocked};
  }
  return out;
}
export async function retryPendingSync(licenseKey){
  const queue=getPendingSyncQueue();
  let attempted=0,skipped=0;
  for(const q of queue){
    if(licenseKey&&q.licenseKey!==licenseKey)continue;
    if(q.blocked){skipped++;continue;}
    let raw=null;try{raw=localStorage.getItem(q.key);}catch(_){}
    if(raw==null){removeQueueEntry(q.licenseKey,q.key);continue;}
    let value;try{value=JSON.parse(raw);}catch(e){updateQueueEntry(q.licenseKey,q.key,{lastError:"Local JSON is invalid",attempts:(q.attempts||0)+1});skipped++;continue;}
    attempted++;
    await syncKeyToFirestore(q.licenseKey,q.key,value);
  }
  const remaining=getPendingSyncQueue().filter(q=>!licenseKey||q.licenseKey===licenseKey).length;
  return {attempted,skipped,remaining};
}

export async function syncKeyToFirestore(licenseKey,key,data){
  if(!licenseKey)return;
  updateQueueEntry(licenseKey,key,{blocked:false,reason:null,lastError:null});
  try{
    const json=JSON.stringify(data);
    const size=new TextEncoder().encode(json).length;
    if(size>MAX_SYNC_FIELD_BYTES){
      const message=`Payload ${size} bytes exceeds ${MAX_SYNC_FIELD_BYTES}-byte field budget`;
      _syncStatus[key]={key,ok:false,reason:"oversize",message,sizeBytes:size,budgetBytes:MAX_SYNC_FIELD_BYTES,at:new Date().toISOString()};
      updateQueueEntry(licenseKey,key,{blocked:true,reason:"oversize",lastError:message,attempts:(readQueue()[queueId(licenseKey,key)]?.attempts||0)+1,lastAttemptAt:new Date().toISOString()});
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
    removeQueueEntry(licenseKey,key);
  }catch(e){
    // Durable local queue keeps this key retryable across reloads/offline periods.
    const message=e?.message||String(e);
    _syncStatus[key]={key,ok:false,reason:"error",message,at:new Date().toISOString()};
    updateQueueEntry(licenseKey,key,{blocked:false,reason:"error",lastError:message,attempts:(readQueue()[queueId(licenseKey,key)]?.attempts||0)+1,lastAttemptAt:new Date().toISOString()});
    console.error("[Sync] Failed to sync",key,":",message);
  }
}
