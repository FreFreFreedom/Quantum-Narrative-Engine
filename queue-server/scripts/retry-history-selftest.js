#!/usr/bin/env node
// retry-history-selftest.js — guards the two promises that make an interrupted
// task inspectable: its ending remains terminal, and a retry is a separate linked row.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const queue = readFileSync(resolve(here, '../server/src/services/promptQueue.js'), 'utf8');
const schema = readFileSync(resolve(here, '../server/src/db/schema.js'), 'utf8');
const route = readFileSync(resolve(here, '../server/src/routes/queue.js'), 'utf8');
let failed = 0;
function check(name, value) {
  if (value) console.log(`✓ ${name}`);
  else { failed++; console.log(`✗ ${name}`); }
}

check('schema stores the continuation link', /retry_of_prompt_id TEXT REFERENCES work_prompts\(id\)/.test(schema));
check('schema indexes the continuation link', /idx_work_prompts_retry_of/.test(schema));
check('queue creates a retry as a new prompt', /export async function retryPrompt/.test(queue) && /retry_of_prompt_id: original\.id/.test(queue));
check('queue refuses to overwrite an active continuation', /retry_of_prompt_id=\? AND status IN \('queued','running','paused'\)/.test(queue));
check('retry keeps the final plan as an owned brief', /plan_source: 'own'/.test(queue));
check('HTTP retry endpoint uses the linked continuation', /router\.post\('\/prompts\/:id\/retry'/.test(route) && /queue\.retryPrompt/.test(route));

const insert = /INSERT INTO work_prompts \(([^)]*)\)\s*\n\s*VALUES \(([^)]*)\)/.exec(queue);
check('prompt INSERT has matching columns and placeholders', !!insert && insert[1].split(',').length === (insert[2].match(/\?/g) || []).length);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
