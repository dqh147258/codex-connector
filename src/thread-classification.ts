/** Native v0.171.0-alpha.13 Thread.source and lineage, pinned at 581161ab.
 * SessionSource uses externally tagged {custom:...} / {subAgent:...};
 * threadSource is an independent lower-snake-case analytics classification.
 * A fork is history provenance, not child ownership. A known child always
 * wins over contradictory root hints. Neither titles nor paths are evidence. */
export type NativeThreadKind='root'|'child'|'unknown';
type Dict=Record<string,unknown>;
const record=(x:unknown):x is Dict=>!!x&&typeof x==='object'&&!Array.isArray(x);
const opaque=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(x);
const uuid7=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i.test(x);

export function classifyNativeThread(raw:unknown,creation?:{acknowledgedThreadId:string}):NativeThreadKind{
  if(!record(raw)||!opaque(raw.id))return 'unknown';
  const src=raw.source;
  if(opaque(raw.parentThreadId)||raw.threadSource==='subagent'||record(src)&&Object.hasOwn(src,'subAgent'))return 'child';
  // Null parent is explicitly serialized on the official wire. Missing,
  // malformed or attached work is intentionally not unqualified root evidence.
  if(raw.parentThreadId!==null||raw.attachedToThreadId!=null||
    (raw.threadSource!=null&&raw.threadSource!=='user'))return 'unknown';
  if(src==='cli'||src==='vscode')return 'root';
  if(record(src)&&Object.keys(src).length===1&&(src.custom==='atlas'||src.custom==='chatgpt'))return 'root';
  const exactRoot=raw.sessionId===raw.id;
  if(src==='appServer'&&exactRoot)return 'root';
  // Only a caller verifying the positive, exact, same-epoch fresh RPC
  // receipt may supply this. Never derive it from stored bindings/cursors.
  if(creation?.acknowledgedThreadId===raw.id&&uuid7(raw.id)&&exactRoot&&raw.forkedFromId===null&&raw.ephemeral===false)return 'root';
  return 'unknown';
}

export function nativeRootError(kind:Exclude<NativeThreadKind,'root'>){
  return kind==='child'?'SUBAGENT_THREAD_NOT_SUPPORTED':'NATIVE_THREAD_ROOT_UNVERIFIED';
}
