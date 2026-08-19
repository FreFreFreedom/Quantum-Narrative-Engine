// Rewrite the world-look ideas that already exist.
//
// The prompts that produce a world-look were changed so that the asking task's own
// words and its subject now reach the point where the ideas are actually chosen.
// Before that, the last pass only ever saw a twenty-word summary of the idea, so the
// shelves drifted toward whatever part of the app the model found most interesting —
// which is why a task about the Core Architecture section came back with ideas about
// the Content navigator.
//
// That fix only applies to looks taken from now on. Every report already stored was
// written by the old prompts. This script redoes them, in place, for tasks,
// suggestions, pieces of the architecture and seeds alike.
//
// Run it from the Mac, not from Railway: it needs a model lane, and the Railway
// container has no Claude. It uses the free lane first, like every other world-look.
//
//   node queue-server/scripts/rewrite-world-looks.js --dry-run
//   node queue-server/scripts/rewrite-world-looks.js --limit 20
//   node queue-server/scripts/rewrite-world-looks.js --sources prompt,suggestion
//
// It is resumable and safe to run twice: each report it redoes is stamped with the
// current generation, so a second run only picks up what is left. A run that dies
// halfway loses nothing but the item it was on.

import { openDb } from '../server/src/db/schema.js';
import { bindAiTextDb } from '../server/src/services/ai/text.js';
import { bindRouterDb } from '../server/src/services/ai/router.js';
import { rewriteWorldLooks, staleWorldLooks, WORLD_LOOK_GEN } from '../server/src/services/codeDiscovery.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] || '');
};
const has = (name) => args.includes(`--${name}`);

const dryRun = has('dry-run');
const limit = Math.max(1, Math.min(500, Number(flag('limit')) || 25));
const sources = flag('sources') ? String(flag('sources')).split(',').map((s) => s.trim()).filter(Boolean) : null;

const db = openDb();
// The text seam and the model router need the database before any prompt can run —
// index.js does this at boot, and this script bypasses index.js entirely.
bindAiTextDb(db);
bindRouterDb(db);

const pending = staleWorldLooks(db, { sources });
console.log(`World-look generation ${WORLD_LOOK_GEN}. ${pending.length} item(s) still carry ideas written by an older generation.`);

if (dryRun) {
  const out = await rewriteWorldLooks(db, { dryRun: true, limit, sources });
  console.log(`\nBy kind: ${JSON.stringify(out.by_kind)}`);
  console.log(`\nThe next ${out.would_do.length} it would redo:`);
  for (const w of out.would_do) console.log(`  · [${w.source}] ${w.idea}`);
  console.log('\nNothing was changed. Drop --dry-run to actually redo them.');
  process.exit(0);
}

if (!pending.length) {
  console.log('Nothing to redo — every stored look is already on the current generation.');
  process.exit(0);
}

console.log(`Redoing up to ${limit}, one at a time. Each one is a few model calls on the free lane.\n`);
const out = await rewriteWorldLooks(db, {
  limit,
  sources,
  onProgress: (p) => {
    if (p.state === 'running') console.log(`  … [${p.source}] ${p.idea}`);
    else if (p.state === 'done') console.log(`  ✓ [${p.source}] redone${p.subject ? ` — subject: ${p.subject}` : ''}`);
    else if (p.state === 'skipped') console.log(`  – [${p.source}] skipped, nothing left to act on`);
    else if (p.state === 'failed') console.log(`  ✗ [${p.source}] failed: ${p.why || 'unknown'}`);
  },
});

console.log(`\n${out.rewritten} redone, ${out.skipped} skipped, ${out.failed} failed, ${out.remaining} left.`);
if (out.remaining) console.log(`Run it again to continue with the remaining ${out.remaining}.`);
if (out.failed) console.log('Failures are usually a cooled-down model lane — running it again picks them up.');
