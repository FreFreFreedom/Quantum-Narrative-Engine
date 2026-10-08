import { randomUUID } from 'node:crypto';
import { workFingerprint, sameEntry } from './sameWork.js';
import { cachedBookFacts } from './bookFacts.js';
import { cachedScreenFacts } from './screenFacts.js';
let db;
const parse = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const fail = (s, status = 400) => { throw Object.assign(new Error(s), { status }); };
const norm=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function bindReferenceLibrary(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS reference_saves (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, identity TEXT NOT NULL, source_id TEXT NOT NULL,
    snapshot TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner,identity)
  )`);
  // An analogy found on its own and then thrown away must not come back the next
  // time the conversation is read.
  db.exec(`CREATE TABLE IF NOT EXISTS reference_dismissed (
    owner TEXT NOT NULL, identity TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(owner,identity)
  )`);
}
function ownerCheck(owner) { if (owner !== 'antoine') fail('Reference not found.',404); }
export function resolveReference(owner, ref) {
  ownerCheck(owner);
  if (!ref || typeof ref.id !== 'string') fail('Choose a reference.');
  let r;
  if (ref.type === 'media') {
    r = db.prepare('SELECT * FROM interest_works WHERE id=? AND owner=?').get(ref.id,owner);
    if(r) return {type:'media',id:r.id,kind:r.kind,title:r.title,creator:r.creator,year:r.year,state:r.state,origin:'Saved interest',identity:'media:'+r.identity};
  } else if (ref.type === 'passage') {
    r = db.prepare('SELECT * FROM saved_passages WHERE id=? AND created_by=? AND deleted_at IS NULL').get(ref.id,owner);
    if(r) {
      const message = r.message_id && db.prepare('SELECT m.role FROM convo_messages m JOIN convos c ON c.id=m.convo_id WHERE m.id=? AND c.created_by=? AND c.deleted_at IS NULL').get(r.message_id,owner);
      return {type:'passage',id:r.id,kind:'passage',title:r.text.slice(0,100),text:r.text,origin:'Kept passage',speaker:message?.role || 'Original speaker unavailable',sourceTitle:r.source_title,identity:'passage:'+r.id};
    }
  } else if (ref.type === 'saved') {
    r = db.prepare('SELECT * FROM reference_saves WHERE id=? AND owner=?').get(ref.id,owner);
    if(r) return {...parse(r.snapshot),type:'saved',id:r.id};
  } else if (ref.type === 'analogy') {
    // An analogy card lives as a message in the Room thread's analogy side thread;
    // keeping one copies it into the library like any other saved reference.
    r = db.prepare(`SELECT m.id,m.meta FROM convo_messages m JOIN convos c ON c.id=m.convo_id
      WHERE m.id=? AND c.subject_type='analogy' AND c.created_by=? AND c.deleted_at IS NULL`).get(ref.id,owner);
    const c = r && parse(r.meta);
    if(c && c.kind==='arrival') return {type:'analogy',id:r.id,kind:'analogy',title:c.title || [c.left,c.right].filter(Boolean).join(' ↔ '),
      creator:[c.left,c.right].filter(Boolean).join(' ↔ '),sentence:c.reading || '',text:c.reading || '',origin:'Analogy',identity:'analogy:'+r.id};
  } else if (ref.type === 'recommendation') {
    r = db.prepare('SELECT r.*,c.kind,c.scope FROM recommendations r JOIN recommendation_collections c ON c.id=r.collection_id WHERE r.id=? AND r.dismissed=0').get(ref.id);
    if(r) {
      if(r.scope !== 'all' && !db.prepare('SELECT 1 FROM convos WHERE id=? AND created_by=? AND deleted_at IS NULL').get(r.scope,owner)) fail('Reference not found.',404);
      const sources = parse(r.sources);
      if(!Array.isArray(sources) || sources.some(id=>!db.prepare('SELECT 1 FROM convo_messages m JOIN convos c ON c.id=m.convo_id WHERE m.id=? AND c.created_by=? AND c.deleted_at IS NULL').get(id,owner))) fail('This recommendation’s source is no longer available.',404);
      const details = parse(r.details);
      return {type:'recommendation',id:r.id,kind:r.kind==='papers'?'paper':r.kind==='media'?(details.kind || 'book'):'project',title:r.title,
        sentence:r.kind==='papers'?'':r.sentence,url:r.url,origin:r.kind==='papers'?'Paper':details.origin || 'Idea to build',
        creator:details.creator || '',year:details.year || '',checkedAt:details.checkedAt || null,
        status:details.status || '',evidence:details.evidence || '',abstract:details.abstract || '',summary:details.summary || '',artwork:details.artwork || '',state:'interested',identity:r.dedupe};
    }
  }
  fail('This reference is no longer available. Remove it from the draft.',404);
}
export function saveReference(owner, ref) {
  const item=resolveReference(owner,ref);
  if(item.type==='media') {db.prepare('UPDATE interest_works SET kept=1 WHERE id=? AND owner=?').run(item.id,owner);return item;}
  if(item.type==='passage'||item.type==='saved')return item;
  // Already in the Library under another spelling: that copy is the one kept.
  const fp=workFingerprint(item);
  if(fp)for(const w of db.prepare('SELECT id,kind,title,creator,year,episode FROM interest_works WHERE owner=?').all(owner))
    if(workFingerprint(w)===fp&&sameEntry(w,item))db.prepare('UPDATE interest_works SET kept=1 WHERE id=?').run(w.id);
  db.prepare('INSERT OR IGNORE INTO reference_saves(id,owner,identity,source_id,snapshot) VALUES(?,?,?,?,?)')
    .run(randomUUID(),owner,item.identity,item.id,JSON.stringify(item));
  const row=db.prepare('SELECT id FROM reference_saves WHERE owner=? AND identity=?').get(owner,item.identity);
  return {...item,type:'saved',id:row.id};
}
export function referenceSaved(owner, identity) {return !!db.prepare('SELECT 1 FROM reference_saves WHERE owner=? AND identity=?').get(owner,identity);}
// A work's year as a number, from its own row or from what the catalogues said.
const yearOf=(v)=>{const m=String(v||'').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);return m?Number(m[1]):0;};
export function listReferences(owner,{kind='',query='',offset=0,limit=40,from='',to=''}={}) {
  ownerCheck(owner);
  // Newest first (his ask, 2026-09-27): what he just added shows at the top. Two
  // timestamp formats live in these tables ('YYYY-MM-DD HH:MM:SS' and ISO), so each
  // row carries one comparable number.
  const addedMs=(t)=>{if(!t)return 0;const v=String(t).replace(' ','T');const n=Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(v)?v:v+'Z');return Number.isNaN(n)?0:n;};
  const media=db.prepare('SELECT id,kind,title,creator,year,state,episode,created_at FROM interest_works WHERE owner=?').all(owner).map(({created_at,...r})=>({...r,type:'media',added:addedMs(created_at)}));
  // A passage kept from a conversation carries no source line; only one from a
  // book or a document names where it came from.
  const passages=db.prepare('SELECT id,text,source_title,convo_id,message_id,created_at FROM saved_passages WHERE created_by=? AND deleted_at IS NULL').all(owner)
    .map(r=>({type:'passage',id:r.id,kind:'passage',title:r.text.slice(0,100),text:r.text,sourceTitle:(r.convo_id||r.message_id)?'':(r.source_title||''),added:addedMs(r.created_at)}));
  const saved=db.prepare('SELECT id,snapshot,created_at FROM reference_saves WHERE owner=? ORDER BY created_at DESC').all(owner).map(r=>({...parse(r.snapshot),type:'saved',id:r.id,added:addedMs(r.created_at)}));
  const words=String(query).toLowerCase().slice(0,250).split(/\s+/).filter(Boolean);
  // Filtering by year or by words reaches what the catalogues know too: the year a
  // book or film came out, and what it is about, so a word like "prison" finds the
  // works about prisons and not only the ones with it in the title (his ask, 2026-10-08).
  const yFrom=yearOf(from), yTo=yearOf(to);
  if(words.length||yFrom||yTo) for(const r of media){
    let f=null;
    try{f=r.kind==='book'?cachedBookFacts(r.title,r.creator):cachedScreenFacts(owner,r.kind,r.title,r.year);}catch(e){f=null;}
    r.text=f?.overview||'';
    r.yearN=yearOf(r.year)||yearOf(f?.year);
  }
  const inYears=(r)=>{if(!yFrom&&!yTo)return true;if(r.type!=='media'&&!['book','film','series'].includes(r.kind))return false;
    const y=r.yearN||yearOf(r.year);return !!y&&(!yFrom||y>=yFrom)&&(!yTo||y<=yTo);};
  const hit=(r)=>inYears(r)&&words.every(w=>[r.title,r.creator,r.text,r.sentence].join(' ').toLowerCase().includes(w));
  // A saved suggestion that is the same work as a Library entry is shown once, as
  // the entry — matched with or without subtitle, author or year (2026-09-28).
  const twinOf=(r)=>{const fp=workFingerprint(r);return !!fp&&media.some(m=>workFingerprint(m)===fp&&sameEntry(m,r));};
  const savedShown=saved.filter(r=>!twinOf(r));
  const items=[...savedShown,...media,...passages].filter(r=>(!kind||r.kind===kind)&&hit(r))
    .sort((a,b)=>(b.added||0)-(a.added||0));
  const start=Math.max(0,Number(offset)||0), cap=Math.max(1,Math.min(2000,Number(limit)||40));
  // How many of each kind the library holds (the search still applies, the kind
  // filter does not), for the kind menu. Book titles travel too so the page can
  // leave out the ones its own shelf already counts.
  const counts={}, bookTitles=[];
  for(const r of [...savedShown,...media,...passages]) {
    if(!hit(r)) continue;
    counts[r.kind]=(counts[r.kind]||0)+1;
    if(r.kind==='book') bookTitles.push(r.title);
  }
  return {items:items.slice(start,start+cap).map(({text,yearN,...r})=>({...r,...(yearN&&!yearOf(r.year)?{year:String(yearN)}:{}),excerpt:r.type==='media'?undefined:text?.slice(0,r.kind==='passage'?2000:300)})),total:items.length,counts,bookTitles};
}
// ─── Analogies found in conversation ────────────────────────────────────────
// The mind harvest reads each Room conversation every few messages; when it meets a
// real analogy — two things from different worlds or scales sharing one nameable
// pattern — it lands here, marked found. Keep promotes it; ✕ dismisses it for good.
export function analogyIdentity(left,right) {
  const pair=[norm(left),norm(right)].sort();
  return 'analogy-found:'+pair.join('|');
}
export function saveFoundAnalogy(owner,{left,right,pattern,saidBy,convoId,messageId,convoTitle}) {
  if(!db || !left || !right || !pattern) return null;
  const identity=analogyIdentity(left,right);
  if(db.prepare('SELECT 1 FROM reference_dismissed WHERE owner=? AND identity=?').get(owner,identity)) return null;
  if(db.prepare('SELECT 1 FROM reference_saves WHERE owner=? AND identity=?').get(owner,identity)) return null;
  const snap={type:'saved',kind:'analogy',title:String(pattern).slice(0,240),creator:String(left).slice(0,120)+' ↔ '+String(right).slice(0,120),
    text:String(pattern).slice(0,600),found:true,saidBy:saidBy==='he'?'you':'answer',convoId:convoId||null,messageId:messageId||null,
    sourceTitle:convoTitle||'',origin:'Found in conversation',identity};
  const id=randomUUID();
  db.prepare('INSERT OR IGNORE INTO reference_saves(id,owner,identity,source_id,snapshot) VALUES(?,?,?,?,?)').run(id,owner,identity,messageId||convoId||id,JSON.stringify(snap));
  return id;
}
export function keepFoundAnalogy(owner,id) {
  ownerCheck(owner);
  const r=db.prepare('SELECT snapshot FROM reference_saves WHERE id=? AND owner=?').get(id,owner);
  if(!r) fail('Reference not found.',404);
  const snap={...parse(r.snapshot),found:false};
  db.prepare('UPDATE reference_saves SET snapshot=? WHERE id=? AND owner=?').run(JSON.stringify(snap),id,owner);
  return {ok:true};
}
export function removeReference(owner,ref) {
  const item=resolveReference(owner,ref);
  if(item.type==='saved' && item.found && item.identity) db.prepare('INSERT OR IGNORE INTO reference_dismissed(owner,identity) VALUES(?,?)').run(owner,item.identity);
  if(item.type==='saved')db.prepare('DELETE FROM reference_saves WHERE id=? AND owner=?').run(item.id,owner);
  else if(item.type==='passage')db.prepare('UPDATE saved_passages SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND created_by=?').run(item.id,owner);
  else if(item.type==='media') {
    db.exec('BEGIN IMMEDIATE');
    try {db.prepare("UPDATE interest_entries SET work_id=NULL,status='removed' WHERE work_id=? AND owner=?").run(item.id,owner);db.prepare('DELETE FROM interest_works WHERE id=? AND owner=?').run(item.id,owner);
      // Its hidden twins go with it, or removing one copy would uncover the other.
      const fp=workFingerprint(item);
      if(fp)for(const saved of db.prepare('SELECT id,snapshot FROM reference_saves WHERE owner=?').all(owner)){const snap=parse(saved.snapshot);if(workFingerprint(snap)===fp&&sameEntry(item,snap))db.prepare('DELETE FROM reference_saves WHERE id=? AND owner=?').run(saved.id,owner);}
      db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  } else fail('This item is not saved.');
  return {ok:true};
}
export function referenceQuote(owner,ref) {
  const item=resolveReference(owner,ref);
  const text=item.kind==='passage' ? `Kept passage (${item.speaker || 'original attribution unavailable'}):\n${item.text}`
    : JSON.stringify(item);
  if(text.length>14000)fail('This passage is too long to attach whole. Select a shorter excerpt from Passages.');
  return {text,title:item.title,identity:item.identity,reference:{type:item.type,id:item.id},msgId:null};
}
export const REFERENCE_TOOLS=[
  {name:'search_reference_library',description:'Search saved media, papers, projects and kept passages; not full books or papers.',input_schema:{type:'object',properties:{query:{type:'string'},kind:{type:'string'},offset:{type:'integer'}}}},
  {name:'read_reference_item',description:'Read one saved reference. Metadata is not full content; kept passage text is available. Use nextOffset to continue long passages.',input_schema:{type:'object',properties:{type:{type:'string'},id:{type:'string'},offset:{type:'integer'}},required:['type','id']}}
];
export function referenceTool(owner,name,args={}) {
  if(name==='search_reference_library')return listReferences(owner,{...args,limit:20});
  const item=resolveReference(owner,args);
  if(item.text){const offset=Math.max(0,Number(args.offset)||0);return {...item,text:item.text.slice(offset,offset+12000),totalChars:item.text.length,nextOffset:offset+12000<item.text.length?offset+12000:null};}
  return item;
}
