// Roots for the dictionary card (his pick #1, 2026-11-17): where a word came from, as a
// ladder down through time to its meaning here, and its kin — other words from the same
// root, preferably in other fields — branching off the oldest step, with one line on
// what the root still does in the word here. Shared by the Room's card and the QNE
// extension's card. Grounded on Wiktionary's own etymology text so the ladder is the
// attested one, not a plausible invention; one call per word per place, kept for good.
import { generateText, generateTextDirect } from './ai/text.js';
import * as router from './ai/router.js';

let db = null;
export function bindWordRoots(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS word_roots (
    scope TEXT NOT NULL, word TEXT NOT NULL, json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scope, word)
  )`);
}

// Wiktionary's etymology, followed back: the word's own entry (English first, then
// French — béchamel and velouté live there — then any language), then the entry of the
// word it came from, up to three hops. The oldest entry reached also gives its
// Descendants / Derived terms, the real kin, so siblings are found, not invented.
const LANG_NAMES = { en: 'English', enm: 'Middle English', ang: 'Old English', fr: 'French', frm: 'Middle French', fro: 'Old French',
  la: 'Latin', 'la-lat': 'Latin', 'la-med': 'Latin', 'la-vul': 'Latin', 'LL.': 'Latin', 'ML.': 'Latin', 'VL.': 'Latin',
  grc: 'Ancient Greek', it: 'Italian', es: 'Spanish', de: 'German', nl: 'Dutch', non: 'Old Norse', ar: 'Arabic', pt: 'Portuguese' };
async function wikitext(page) {
  try {
    const url = 'https://en.wiktionary.org/w/api.php?action=parse&prop=wikitext&format=json&redirects=1&page=' + encodeURIComponent(page);
    const r = await fetch(url, { headers: { 'User-Agent': 'qne-dictionary/1.0' }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return '';
    return (await r.json())?.parse?.wikitext?.['*'] || '';
  } catch { return ''; }
}
function langSection(text, name) {
  return ("\n" + text).split(/\n==(?!=)\s*/).find((l) => l.startsWith(name + '==') || l.startsWith(name + ' ==')) || '';
}
function section(block, title) {
  const m = block.match(new RegExp('===+\\s*' + title + '[^=\\n]*===+\\n([\\s\\S]*?)(?=\\n=|$)'));
  return m ? m[1] : '';
}
// Templates kept as words, never dropped: {{inh|fr|la|villus||hair}} → "Latin villus (hair)",
// {{ety|en|:bor|fr:velouté<t:velvety>}} → "French velouté (velvety)", {{prefix|en|de|glaze}} → "de glaze".
const langName = (c) => LANG_NAMES[c] || c;
function flatTpl(inner) {
  const ps = inner.split('|').filter((x) => !x.includes('=') && !/^:/.test(x));
  const name = ps.shift();
  if (name === 'ety') return ps.slice(1).map((x) => x.replace(/^([\w.-]+):([^<]*)(?:<t:([^>]*)>)?.*$/, (_, l, w, g) => `${langName(l)} ${w}${g ? ` (${g})` : ''}`)).join(', ');
  if (/^(inh|der|bor|uder|lbor|slbor|inh\+|der\+|bor\+)$/.test(name)) { const [, l, w, , g] = ps; return `${langName(l)} ${w || ''}${g ? ` (${g})` : ''}`; }
  if (/^(m|m\+|l|cog|noncog|desc|l-lite|ll)$/.test(name)) { const [l, w, , g] = ps; return `${langName(l)} ${w || ''}${g ? ` (${g})` : ''}`; }
  if (/^(prefix|suffix|affix|compound|confix)$/.test(name)) return ps.slice(1).join(' + ');
  return '';
}
function flatten(t) {
  let out = String(t || '');
  for (let i = 0; i < 3; i++) out = out.replace(/\{\{([^{}]*)\}\}/g, (_, inner) => flatTpl(inner));
  return out.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/<[^>]+>/g, '').replace(/'{2,3}/g, '').replace(/[ \t]+/g, ' ').trim();
}
// The first older word this etymology names: {{inh|fr|fro|velous}}, {{m|fr|velours}},
// or the new {{ety|en|:bor|fr:velouté}} form.
function parentOf(ety, here) {
  for (const m of ety.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const ps = m[1].split('|').filter((x) => !x.includes('=') && !/^:/.test(x));
    const name = ps.shift();
    let l, w;
    if (name === 'ety') { const hit = ps.slice(1).map((x) => x.match(/^([\w.-]+):([^<]+)/)).find(Boolean); if (hit) { l = hit[1]; w = hit[2]; } }
    else if (/^(inh|der|bor|lbor|inh\+|der\+|bor\+)$/.test(name)) { l = ps[1]; w = ps[2]; }
    else if (/^(m|m\+|l)$/.test(name)) { l = ps[0]; w = ps[1]; }
    if (!l || !w || !LANG_NAMES[l] || w.startsWith('*')) continue;
    w = w.normalize('NFD').replace(/[̄̆]/g, '').normalize('NFC');
    if (w.toLowerCase() === String(here).toLowerCase()) continue;
    return { lang: LANG_NAMES[l], word: w };
  }
  return null;
}
export async function wiktionaryEtymology(word) {
  const lines = [];
  let kin = '';
  const seen = new Set();
  let page = word, langs = ['English', 'French'];
  for (let hop = 0; hop < 5 && page; hop++) {
    let text = await wikitext(page);
    if (!text && hop === 0 && page !== page.toLowerCase()) { page = page.toLowerCase(); text = await wikitext(page); }
    if (!text) break;
    let up = null;
    for (const n of langs) {
      const block = langSection(text, n);
      if (!block || seen.has(n + page)) continue;
      seen.add(n + page);
      // A word with several histories (deglaze: removing glaze, and the cooking one) has
      // "Etymology 1", "Etymology 2": all of them go, the sentence picks.
      const ety = [...block.matchAll(/===+\s*Etymology[^=\n]*===+\n([\s\S]*?)(?=\n=|$)/g)].map((m) => m[1]).join('\n').slice(0, 1500);
      const derived = flatten(section(block, 'Descendants') + '\n' + section(block, 'Derived terms') + '\n' + section(block, 'Related terms'));
      if (derived.length > 10) kin = `${n} ${page}: ${derived.slice(0, 900)}`;
      if (ety) lines.push(`${n} ${page}: ${flatten(ety).slice(0, 500)}`);
      up = up || (ety && parentOf(ety, page));
    }
    if (!up) break;
    page = up.word; langs = [up.lang];
  }
  return [lines.join('\n'), kin ? `KIN FROM THE OLDEST ENTRY REACHED — ${kin}` : ''].filter(Boolean).join('\n\n').slice(0, 3200);
}

const LANES = [
  { provider: 'groq', model: 'openai/gpt-oss-120b', ms: 9000 },
  { provider: 'cerebras', model: 'gpt-oss-120b', ms: 9000 },
  { provider: 'google-ai-studio', model: 'gemini-flash-latest', ms: 12000 },
];
async function rootsText(prompt) {
  for (const l of LANES) {
    if (router.isExhausted(l.provider, l.model)) continue;
    const out = await generateTextDirect({ prompt, provider: l.provider, model: l.model, maxTokens: 2000, label: 'room:roots', timeoutMs: l.ms }).catch(() => null);
    if (out && out.text) return out;
  }
  return generateText({ prompt, feature: 'quick', label: 'room:roots', maxTokens: 2000, timeoutMs: 25_000 });
}

const PROMPT = `You show a reader where ONE word came from. English is his second language: plain words.
Return JSON only, no markdown fence:
{"steps":[{"word":"…","lang":"…","gloss":"…"}],"kin":[{"word":"…","where":"…"}],"echo":"…"}
- steps: the word's real line of descent, OLDEST FIRST, 2 to 4 steps, the last one being the word
  itself with lang "here" and as gloss what it means in THE SENTENCE. lang is one or two words
  ("Latin", "Old French", "Greek", "Proto-Indo-European"). gloss: 2 to 6 words.
  ALWAYS write the word in Latin letters: Greek, Arabic, Sanskrit and the rest are transliterated
  (athlon, not ἆθλον; melas, not μέλας), and a reconstructed root without its asterisk and symbols
  (dek, not *dek-; melh, not *melh₂-).
- kin: 2 or 3 other English words from the SAME oldest root, as far from the word's own field as
  you can truly find (body, law, music, science…), never a mere form of the word itself (not
  "disciplinary" for "discipline"). where: 1 or 2 words naming the field. Prefer words named in the
  REFERENCE's KIN; never a word that only looks alike. Fewer is better than one wrong.
- echo: ONE sentence, at most 18 words, saying what the old root still does in the word as it is
  used here — the image it carries into this sentence. No "the word", no "etymology".
Use only well-attested history. The REFERENCE below is Wiktionary's etymology, followed back
entry by entry: the steps must follow it. If the
origin is unknown or you are not sure, return {"steps":[]}.`;

// Latin letters always (his ask, 2026-11-17: Greek letters read as noise). Greek is
// spelled out letter by letter, a reconstructed root loses its star and symbols, and a
// step still in another script after that is dropped rather than shown.
const GREEK = { α: 'a', β: 'b', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'e', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'u', φ: 'ph', χ: 'kh', ψ: 'ps', ω: 'o' };
export function latinLetters(w) {
  let t = String(w || '').normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
  t = t.replace(/γ(?=[γκξχ])/gi, 'n');
  t = [...t].map((c) => { const l = GREEK[c.toLowerCase()]; return l ? (c !== c.toLowerCase() ? l[0].toUpperCase() + l.slice(1) : l) : c; }).join('');
  t = t.replace(/^\*/, '').replace(/[₀-₉ʰʷ]/g, '').replace(/-+$/, '').trim();
  return /^[\p{Script=Latin}\s'’.-]+$/u.test(t) ? t : '';
}

function clean(parsed, word) {
  const s = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const steps = (Array.isArray(parsed?.steps) ? parsed.steps : [])
    .map((x) => ({ word: latinLetters(s(x.word, 60)), lang: s(x.lang, 30), gloss: s(x.gloss, 80) }))
    .filter((x) => x.word);
  // The same word twice in a row (en PIE, en Greek) is one step: the older one is dropped.
  for (let i = steps.length - 2; i >= 0; i--) if (steps[i].word.toLowerCase() === steps[i + 1].word.toLowerCase()) steps.splice(i, 1);
  // No abbreviations in the language line.
  for (const x of steps) x.lang = x.lang.replace(/^PIE$/i, 'Proto-Indo-European').replace(/\bProto[‑-]/g, 'Proto-');
  if (steps.length > 5) steps.splice(4, steps.length - 5);
  if (steps.length < 2) return { steps: [], kin: [], echo: '' };
  if (steps.length < 2) return { steps: [], kin: [], echo: '' };
  const seen = new Set(steps.map((x) => x.word.toLowerCase()).concat(word.toLowerCase()));
  // A form of the word itself is not kin (athletics for athlete): the stems must differ.
  const stem = word.toLowerCase().slice(0, 5);
  const kin = (Array.isArray(parsed?.kin) ? parsed.kin : [])
    .map((x) => ({ word: latinLetters(s(x.word, 40)), where: s(x.where, 30) }))
    .filter((x) => x.word && !seen.has(x.word.toLowerCase()) && !x.word.toLowerCase().startsWith(stem)).slice(0, 3);
  return { steps, kin, echo: s(parsed?.echo, 220) };
}

// scope: a conversation id for the Room, "screen:<page or book>" for the extension.
export async function wordRoots({ scope = '', word = '', sentence = '', context = '' } = {}) {
  const w = String(word || '').trim().replace(/[’']s$/, '');
  if (!w || w.length > 40 || !/^\p{L}[\p{L}'’-]*$/u.test(w)) return { error: 'not_a_word' };
  const key = w.toLowerCase();
  // v3: no doubled steps; v2: Latin letters only, and no forms of the word as kin — older answers are read again.
  const sc = 'v3|' + String(scope || 'any').slice(0, 300);
  if (db) {
    const hit = db.prepare('SELECT json FROM word_roots WHERE scope=? AND word=?').get(sc, key);
    if (hit) { try { return { ok: true, ...JSON.parse(hit.json), cached: true }; } catch { /* read again */ } }
  }
  const ref = await wiktionaryEtymology(w);
  const out = await rootsText(`${PROMPT}\n\n=== THE WORD ===\n${w}\n\n=== THE SENTENCE ===\n${String(sentence || '').replace(/\s+/g, ' ').slice(0, 600) || '(not given)'}`
    + (context ? `\n\n=== WHERE HE IS READING ===\n${String(context).slice(0, 200)}` : '')
    + `\n\n=== REFERENCE ===\n${ref || '(Wiktionary could not be reached: use the history that is well known for this word; return no steps only when its origin is truly unknown.)'}`);
  if (out?.error || !out?.text) return { error: out?.error || 'generation_failed' };
  let parsed;
  try { parsed = JSON.parse(out.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return { error: 'unreadable' }; }
  const roots = clean(parsed, w);
  // An empty answer without the reference may be the network, not the word: not kept.
  if (db && (roots.steps.length || ref)) db.prepare('INSERT OR REPLACE INTO word_roots (scope, word, json) VALUES (?,?,?)').run(sc, key, JSON.stringify(roots));
  return { ok: true, ...roots };
}
