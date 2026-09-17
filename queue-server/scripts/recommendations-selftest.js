// In-memory integration checks only: no network, model calls, or live database.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
process.env.JWT_SECRET ||= 'recommendation-selftest-only';
const { initConversationsSchema, initRecommendationsSchema, initKnowledgeSchema } = await import('../server/src/db/schema.js');
const rec = await import('../server/src/services/roomRecommendations.js');
const { bindConversationsDb } = await import('../server/src/services/conversations.js');
const { paperKey, searchPapers } = await import('../server/src/services/recommendationPapers.js');
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('antoine')");
initConversationsSchema(db); initRecommendationsSchema(db); initKnowledgeSchema(db); bindConversationsDb(db);
const addThread = (id, type = 'open', parent = null) => db.prepare('INSERT INTO convos(id,subject_type,subject_id,title,parent_convo_id) VALUES(?,?,?,?,?)').run(id,type,id,id,parent);
const addMessage = (id, convo, role, text) => db.prepare('INSERT INTO convo_messages(id,convo_id,role,text) VALUES(?,?,?,?)').run(id,convo,role,text);
addThread('a'); addThread('b'); addThread('aside','side','a'); addThread('generated','analogy');
addMessage('owner-a','a','user','Institutions and authority'); addMessage('assistant-a','a','assistant','Assistant-only unrelated idea');
addMessage('owner-side','aside','user','Who may question authority?'); addMessage('owner-b','b','user','Architecture and cities');
addMessage('not-input','generated','assistant','Never include generated recommendation conversations');
let prompts = [], failModel = false, cancelDuring = null;
const generate = async args => {
  assert.equal(args.provider,'claude-side'); assert.equal(args.account,'side'); assert.equal(args.model,'sonnet'); assert.equal(args.strictModel,true);
  prompts.push(args.prompt);
  if (failModel) return { error:'unavailable' };
  if (cancelDuring) { rec.cancelRequest(cancelDuring); cancelDuring = null; }
  let value;
  if (args.prompt.includes('next chronological text chunk')) {
    const ids = [...args.prompt.matchAll(/"id":"(owner-[^"]+)"/g)].map(m=>m[1]);
    value = {summary:'Owner inquiry '+ids.join(' ')};
  } else if (args.prompt.includes('Extract the requested number')) value={count:1};
  else if (args.prompt.includes('academic search queries')) value={queries:['authority institutions']};
  else if (args.prompt.includes('verified metadata records')) value={papers:[{key:'doi:10.1/real',reason:'Relevant method',source_message_ids:['owner-a']},{key:'fake',source_message_ids:['owner-a']}]};
  else value={apps:[{title:'Authority explorer',sentence:'Explore who may question authority.',purpose:'compare authority structures',reason:'Owner inquiry',source_message_ids:['owner-a']}]};
  return {text:JSON.stringify(value)};
};
const search = async () => [{key:'doi:10.1/real',doi:'10.1/real',title:'A verified paper',url:'https://doi.org/10.1/real',abstract:'Metadata only'}];
rec.bindRecommendations(db,{start:false,generateForTest:generate,searchForTest:search});
rec.initializeCollection('papers','a'); rec.changeSettings('papers','a',{automatic:false});
const ask = rec.requestRecommendations('papers','a','One paper'); await rec.tick();
assert.equal(rec.listRecommendations('papers','a').items.length,1);
assert.equal(rec.listRecommendations('papers','a').items[0].title,'A verified paper');
const contextPrompts = prompts.filter(p=>p.includes('next chronological text chunk')).join('\n');
assert(contextPrompts.includes('owner-side')); assert(!contextPrompts.includes('owner-b')); assert(!contextPrompts.includes('not-input'));
assert.equal(db.prepare('SELECT status FROM recommendation_requests WHERE id=?').get(ask.id).status,'done');
assert.equal(paperKey({doi:'https://doi.org/10.1/REAL'}),'doi:10.1/real');
rec.dismissRecommendation(rec.listRecommendations('papers','a').items[0].id);
rec.requestRecommendations('papers','a','One more'); await rec.tick(); await rec.tick();
assert.equal(rec.listRecommendations('papers','a').items.length,0,'dismissed paper must not return');
assert.equal(db.prepare('SELECT COUNT(*) n FROM recommendations').get().n,1,'never store model-invented keys');
// Appends reuse the consumed prefix; the next summary sees only the new text.
prompts=[]; addMessage('owner-new','a','user','A new angle on authority');
rec.requestRecommendations('papers','a','One'); await rec.tick();
const updates=prompts.filter(p=>p.includes('next chronological text chunk'));
assert.equal(updates.length,1); assert(updates[0].includes('owner-new')); assert(!updates[0].includes('Assistant-only unrelated idea'));
// Global context includes every real thread and skips internal generated material.
rec.initializeCollection('apps','all'); rec.changeSettings('apps','all',{automatic:false});
rec.requestRecommendations('apps','all','One app'); await rec.tick(); await rec.tick();
assert(prompts.some(p=>p.includes('Architecture and cities')));
assert(!prompts.some(p=>p.includes('Never include generated recommendation conversations')));
const app=rec.listRecommendations('apps','all').items[0]; assert(app);
const opened=rec.openApp(app.id,'a'), reopened=rec.openApp(app.id,'a');
assert.equal(opened.convo.id,reopened.convo.id); assert(opened.prefill); assert.equal(reopened.prefill,null);
assert.equal(db.prepare('SELECT COUNT(*) n FROM convo_messages WHERE convo_id=?').get(opened.convo.id).n,0,'opening never sends a message');
assert(db.prepare("SELECT content FROM knowledge_docs WHERE title LIKE 'File: App idea context%'").get().content.includes('Institutions and authority'));
// Cancel while a model call is running: no arrival afterward.
rec.initializeCollection('apps','b'); rec.changeSettings('apps','b',{automatic:false});
const cancelled=rec.requestRecommendations('apps','b','One app'); cancelDuring=cancelled.id; await rec.tick();
assert.equal(rec.listRecommendations('apps','b').items.length,0);
// Helper failure remains resumable and never invents a result.
failModel=true; const waiting=rec.requestRecommendations('apps','b','One app'); await rec.tick();
assert.equal(db.prepare('SELECT status FROM recommendation_requests WHERE id=?').get(waiting.id).status,'waiting');
failModel=false; rec.resumeRequest(waiting.id);
// Restart recovers running requests without changing already stored cards.
db.prepare("UPDATE recommendation_requests SET status='running' WHERE id=?").run(waiting.id);
rec.bindRecommendations(db,{start:false,generateForTest:generate,searchForTest:search});
assert.equal(db.prepare('SELECT status FROM recommendation_requests WHERE id=?').get(waiting.id).status,'queued');
// Removed source material cannot remain visible as grounded recommendations.
db.prepare("UPDATE convos SET deleted_at='deleted' WHERE id='a'").run();
assert.equal(rec.listRecommendations('apps','all').items.length,0);
assert.throws(()=>rec.listRecommendations('papers','a'),/not found/);
assert.deepEqual(rec.resolveSourceRefs(['67c2d97e','assistant-id','invented'], ['67c2d97e-1234-owner']), ['67c2d97e-1234-owner']);
assert.deepEqual(rec.resolveSourceRefs(['67c2d97e'], ['67c2d97e-one','67c2d97e-two']), [], 'ambiguous prefixes must be rejected');
// A throttled source must not delay or discard results from the other source.
const originalFetch = globalThis.fetch;
let semanticCalls = 0, crossrefCalls = 0;
globalThis.fetch = async url => {
  if (url.includes('semanticscholar')) {
    semanticCalls++;
    return { status:429, ok:false, headers:new Headers({'retry-after':'120'}) };
  }
  crossrefCalls++;
  return { status:200,ok:true,json:async()=>({message:{items:[{title:['Verified fallback paper'],DOI:'10.2/fallback'}]}}) };
};
try {
  const papers=await searchPapers(['first topic','second topic']);
  assert.equal(papers.length,1); assert.equal(papers[0].title,'Verified fallback paper');
  assert.equal(semanticCalls,1,'respect Retry-After across queries'); assert.equal(crossrefCalls,2);
} finally { globalThis.fetch = originalFetch; }
console.log('Recommendation integration checks passed.');
