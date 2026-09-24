import { randomUUID } from 'node:crypto';
let db;
const parse = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const fail = (s, status = 400) => { throw Object.assign(new Error(s), { status }); };
const norm=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function mediaKey(item) {
  if(!['book','film','series'].includes(item.kind))return null;
  const qualifier=item.kind==='book'?item.creator:item.year;
  return qualifier?[item.kind,norm(item.title),norm(qualifier)].join('|'):null;
}
export function bindReferenceLibrary(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS reference_saves (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, identity TEXT NOT NULL, source_id TEXT NOT NULL,
    snapshot TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner,identity)
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
  const key=mediaKey(item);
  if(key)db.prepare('UPDATE interest_works SET kept=1 WHERE owner=? AND identity=?').run(owner,key);
  db.prepare('INSERT OR IGNORE INTO reference_saves(id,owner,identity,source_id,snapshot) VALUES(?,?,?,?,?)')
    .run(randomUUID(),owner,item.identity,item.id,JSON.stringify(item));
  const row=db.prepare('SELECT id FROM reference_saves WHERE owner=? AND identity=?').get(owner,item.identity);
  return {...item,type:'saved',id:row.id};
}
export function referenceSaved(owner, identity) {return !!db.prepare('SELECT 1 FROM reference_saves WHERE owner=? AND identity=?').get(owner,identity);}
export function listReferences(owner,{kind='',query='',offset=0,limit=40}={}) {
  ownerCheck(owner);
  const media=db.prepare('SELECT id,kind,title,creator,year,state FROM interest_works WHERE owner=?').all(owner).map(r=>({...r,type:'media'}));
  const passages=db.prepare('SELECT id,text,source_title FROM saved_passages WHERE created_by=? AND deleted_at IS NULL').all(owner)
    .map(r=>({type:'passage',id:r.id,kind:'passage',title:r.text.slice(0,100),text:r.text,sourceTitle:r.source_title}));
  const saved=db.prepare('SELECT id,snapshot FROM reference_saves WHERE owner=? ORDER BY created_at DESC').all(owner).map(r=>({...parse(r.snapshot),type:'saved',id:r.id}));
  const words=String(query).toLowerCase().slice(0,250).split(/\s+/).filter(Boolean);
  const importedKeys=new Set(media.map(mediaKey).filter(Boolean));
  const items=[...saved.filter(r=>!mediaKey(r)||!importedKeys.has(mediaKey(r))),...media,...passages].filter(r=>(!kind||r.kind===kind)&&words.every(w=>[r.title,r.creator,r.text,r.sentence].join(' ').toLowerCase().includes(w)));
  const start=Math.max(0,Number(offset)||0), cap=Math.max(1,Math.min(100,Number(limit)||40));
  return {items:items.slice(start,start+cap).map(({text,...r})=>({...r,excerpt:text?.slice(0,300)})),total:items.length};
}
export function removeReference(owner,ref) {
  const item=resolveReference(owner,ref);
  if(item.type==='saved')db.prepare('DELETE FROM reference_saves WHERE id=? AND owner=?').run(item.id,owner);
  else if(item.type==='passage')db.prepare('UPDATE saved_passages SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND created_by=?').run(item.id,owner);
  else if(item.type==='media') {
    db.exec('BEGIN IMMEDIATE');
    try {db.prepare("UPDATE interest_entries SET work_id=NULL,status='removed' WHERE work_id=? AND owner=?").run(item.id,owner);db.prepare('DELETE FROM interest_works WHERE id=? AND owner=?').run(item.id,owner);
      const key=mediaKey(item);
      if(key)for(const saved of db.prepare('SELECT id,snapshot FROM reference_saves WHERE owner=?').all(owner))if(mediaKey(parse(saved.snapshot))===key)db.prepare('DELETE FROM reference_saves WHERE id=? AND owner=?').run(saved.id,owner);
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
