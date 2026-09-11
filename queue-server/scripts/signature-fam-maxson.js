// scripts/signature-fam-maxson.js — plans/anatomy-replaces-tags.md, Part 1.
//
// The one entity, done end to end, before any batch — the rule §14c states and the two
// interiors already honoured. fam_maxson is the household: it already carries a mapped
// interior with signed edges (data-seed/interiors/fam_maxson.graph.json), a written-down
// jump relation with its own falsifier, and a closed vertical loop with the truck crew
// (data-seed/civic_relations.json) — the richest material in the corpus for a first pass.
//
// Every reading below is read off material that already exists on disk. Nothing is
// invented for the ladder; if a reading needed material that was not there, it would stay
// blank rather than be guessed, which is the whole point of the falsifier discipline.
//
// This is a hand pass, not a model call — same precedent as scripts/interior-fences.js.
// Run: node scripts/signature-fam-maxson.js   (needs the server's db; run against the same
// DB_PATH the server boots with, so the rows are there on the next boot)

import { DatabaseSync } from 'node:sqlite';
import { initOntologySchema } from '../server/src/db/schema.js';
import { setSignature, signatureFor } from '../server/src/services/entitySignature.js';

const DB_PATH = process.env.DB_PATH || 'data/queue.db';
const db = new DatabaseSync(DB_PATH);
initOntologySchema(db);

const READ = [
  {
    entity_id: 'fam_maxson',
    reading: 'locus_of_exile',
    answer: 'Lyons. He is admitted on a schedule (payday) and on a transaction (ten dollars), '
      + 'never on the terms that would make him simply belong. Of the 17 exchanges between him and '
      + 'Troy in the mapped scene, 12 are opposed — the heaviest opposed tie in the household — and he '
      + 'is the one who always leaves.',
    points_at: 'l',   // Lyons Maxson, the interior's own opaque code for the speaker
    source_kind: 'witness',
    source_ref: 'data-seed/interiors/fam_maxson.graph.json — edge l-t, weight 17, 12 of 17 opposed',
    falsifier: 'A scene in which Troy extends Lyons unconditional belonging, without the transactional frame, would break this.',
  },
  {
    entity_id: 'fam_maxson',
    reading: 'load_shift',
    answer: "The sanitation department's rule about who may drive the truck — who is inside its own "
      + 'boundary — never lands on the department. It lands on the household two rungs down, as the '
      + "harshness Troy enforces at his own dinner table.",
    points_at: 'inst_pittsburgh_sanitation',
    source_kind: 'witness',
    source_ref: 'data-seed/civic_relations.json — inst_pittsburgh_sanitation -> fam_maxson, jump, 1957',
    falsifier: "If Troy's exclusion from driving the truck left no trace in how he holds his own household, this would break.",
  },
  {
    entity_id: 'fam_maxson',
    reading: 'sovereignty_reversal',
    answer: "The household's own boundary — Troy's authority, built to keep his sons from the world's "
      + 'violence — is what estranges them instead. Troy is opposed in both of his heaviest ties inside '
      + 'the house (12 of 17 with Lyons, 8 of 9 with Rose): the fortress becomes the instrument of its '
      + 'own isolation, in the household seed record\'s own words.',
    points_at: 't',   // Troy Maxson
    source_kind: 'witness',
    source_ref: "data-seed/civic_cluster.json#fam_maxson.note; data-seed/interiors/fam_maxson.graph.json edges l-t, r-t",
    falsifier: "A scene where Troy's authority visibly protects Cory or Lyons from a threat worse than himself would break this.",
  },
  {
    entity_id: 'fam_maxson',
    reading: 'loop_dynamics',
    answer: 'What the truck crew taught Troy about who is inside arrives at the dinner table as who is '
      + 'inside there (c.1950) — and it returns: once the household is emptied of his son, the crew is '
      + 'the only structure left holding him (1965). The same boundary-miscut closes a loop between the '
      + 'two rungs rather than staying at one.',
    points_at: 'grp_truck_crew',
    source_kind: 'witness',
    source_ref: 'data-seed/civic_relations.json — grp_truck_crew <-> fam_maxson, vertical, c.1950 and 1965',
    falsifier: 'Troy rebuilding a household tie after Cory leaves would break the closure.',
  },
];

for (const r of READ) {
  setSignature(db, r);
  console.log(`  ${r.entity_id} / ${r.reading} -> ${r.points_at}`);
}

console.log('\nfam_maxson signature:', JSON.stringify(signatureFor(db, 'fam_maxson'), null, 1));
