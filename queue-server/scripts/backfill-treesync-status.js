// One-off backfill for the "On the Horizon" bug: tree-sync proposals (nodes
// auto-created from a finished queue task's diff, or from git history —
// services/treeSync.js) used to be stamped status='Concept' even though they
// only ever get created for code that already shipped. That made already-built
// work show up in "On the Horizon" (fmcns_navigator.html's isBuilt() gates on
// status) forever, since nothing else ever advances a node's status.
//
// treeSync.js now creates these as status='Working' going forward; this script
// fixes rows created before that change. Safe to re-run — it only touches rows
// with sync_source set (i.e. actually created by tree-sync, not hand-authored
// or speculated nodes) that aren't already marked built.
import { openDb } from '../server/src/db/schema.js';

const db = openDb();
const result = db.prepare(`
  UPDATE architecture_nodes
  SET status='Working', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE deleted_at IS NULL AND sync_source IS NOT NULL
    AND status NOT IN ('Working','Validated','Advanced')
`).run();
console.log(`Backfilled ${result.changes} tree-sync node(s) to status='Working'.`);
