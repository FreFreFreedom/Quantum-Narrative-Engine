// The paradigm voice, as a prompt — QNE 3.0, the Architect of the Unbuilt.
//
// The rules themselves live in AGENTS.md ("The voice for paradigm work"), which every
// coding engine is already required to read. But a model answering inside the app never
// reads AGENTS.md, so the same voice is kept as a prompt-ready file at
// data-seed/voices/qne-3-0.md and handed over from here.
//
// One source of truth per audience, and they are deliberately different shapes: AGENTS.md
// is the authority and the place to edit; the voice file is its condensation for a prompt.
// The file's own header says so, and says AGENTS.md wins if they drift.
//
// Two callers, and only two on purpose:
//   - the Room (via ai_settings.studio_persona, which Antoine can edit or clear — the box
//     wins there, since it is his live control);
//   - the generators that INTERPRET meaning for him: pattern readings, tag lenses, book
//     picks and book detail. Status lines, task cards, queue questions and suggestions
//     stay plain, because a mythic register on "this task failed" fights the job the line
//     is doing. That split is Antoine's, made 2026-09-07.
//
// Read once and cached: this is a committed file, it cannot change under a running
// process, and it rides in cached prompt prefixes.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// services/ai -> services -> src -> server -> queue-server
const VOICE_FILE = resolve(HERE, '../../../..', 'data-seed/voices/qne-3-0.md');

// Everything above the closing --> is authoring notes for whoever edits the file, not
// instruction for the model. Strip it rather than pay for it on every generation.
function stripHeaderComment(text) {
  return String(text || '').replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
}

let cached = null;
export function paradigmVoice() {
  if (cached !== null) return cached;
  try {
    cached = existsSync(VOICE_FILE) ? stripHeaderComment(readFileSync(VOICE_FILE, 'utf8')) : '';
    if (!cached) console.warn('[voice] qne-3-0.md missing or empty — generators will run without the paradigm voice');
    else console.log(`[voice] QNE 3.0 loaded (${cached.length} chars)`);
  } catch (e) {
    console.error('[voice] could not read qne-3-0.md:', e.message);
    cached = '';
  }
  return cached;
}

// For a prompt that already carries USER_FACING_STYLE. Returns '' when the file is
// missing, so a generator degrades to its previous plain behaviour instead of breaking.
//
// `lengthRuleWins` exists because of a real contradiction, not as a knob. The voice says
// "density, not brevity" and "no length ceiling" — right for a conversation, wrong for a
// tag reading capped at 40-55 words or a book note capped at 70-100. Handing those
// prompts the voice unguarded gives the model two opposite orders and the UI then
// truncates whatever it picks. So the caller's own limit is declared the winner, in the
// last words of the block, where it is weighted most.
export function paradigmVoiceBlock({ lengthRuleWins = false } = {}) {
  const v = paradigmVoice();
  if (!v) return '';
  const guard = lengthRuleWins
    ? '\n\nOne exception, absolute: the length limit given for THIS text overrides everything '
      + 'the voice says about length, density or having no ceiling. Keep the register — the way '
      + 'of seeing, the refusal to flatten an idea — and obey the limit.'
    : '';
  return `\n\n=== HOW TO THINK AND WRITE ===\n${v}${guard}`;
}
