// Pictures in a Room answer that are neither a book cover nor a face (his ask,
// 2026-10-18: "it doesn't have to be just covers of books, it can be almost
// anything" — and placed with more judgment). One cheap call per answer reads the
// text and names the few moments where *seeing* the thing changes what the words
// mean: a painting the answer describes, the place where the event happened, the
// photograph an era is remembered by, the object, the map. Most answers deserve
// none, and the prompt says so. Each pick is then found on Wikipedia (the page's
// own lead picture), else on Wikimedia Commons, here on the server — so the Room
// gets a sure picture with its real shape and never searches or guesses in the
// browser. Free, no key, and any failure is simply an answer with no pictures.

import { generateText } from './ai/text.js';

let db = null;
// Bumped when the reading changes, so answers read before it are read once more.
export const PICTURES_V = 1;
const MAX_PICK = 4, MAX_KEEP = 3;
const KINDS = new Set(['place', 'art', 'event', 'object', 'nature', 'map', 'science', 'building', 'other']);
const UA = 'QNE/1.0 (personal research tool; https://quantum-narrative-engine-production.up.railway.app)';

export function bindAnswerPictures(database) { db = database; }

const plain = (t) => String(t || '').replace(/\*\*?([^*]+)\*\*?/g, '$1').replace(/\s+/g, ' ').trim();
const flat = (t) => plain(t).replace(/[*_`#>]/g, '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
function firstJson(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// A drawing is a picture only when it is meant to be one: a map, a diagram. A
// country's flag or an institution's seal stands for the thing; it does not show it.
const EMBLEM = /\b(flag|coat[_ ]of[_ ]arms|seal|logo|emblem|insignia|wordmark|signature|icon)\b/i;
function fits(src, w, h, kind) {
  if (!src || !w || !h) return false;
  if (w < 360 || h < 220) return false;
  const r = w / h;
  if (r < 0.5 || r > 2.8) return false;
  const name = decodeURIComponent(src.split('/').pop() || '');
  if (EMBLEM.test(name.replace(/_/g, ' '))) return false;
  if (/\.svg/i.test(name) && kind !== 'map' && kind !== 'science') return false;
  return true;
}

// The page's own lead picture: for a painting, the painting; for a town, the town.
async function fromWikipedia(subject, kind) {
  const j = await getJson('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1'
    + '&prop=pageimages|pageprops|description&piprop=thumbnail|original&pithumbsize=960&titles=' + encodeURIComponent(subject));
  const p = j?.query?.pages?.[0];
  if (!p || p.missing || p.pageprops?.disambiguation !== undefined) return null;
  const t = p.thumbnail, o = p.original;
  if (!t?.source || !fits(o?.source || t.source, o?.width || t.width, o?.height || t.height, kind)) return null;
  return { url: t.source, w: t.width, h: t.height, page: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(p.title.replace(/ /g, '_')), from: 'Wikipedia' };
}

// Commons, when the page has no picture of its own or no page fits: the file
// search ranks by how well the file's own name and description match.
async function fromCommons(query, kind) {
  const j = await getJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2'
    + '&generator=search&gsrnamespace=6&gsrlimit=10&gsrsearch=' + encodeURIComponent(query)
    + '&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=960');
  const pages = (j?.query?.pages || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png|webp|svg\+xml)$/.test(ii.mime || '')) continue;
    if (!fits(ii.url, ii.width, ii.height, kind)) continue;
    const url = ii.thumburl || ii.url;
    return { url, w: ii.thumbwidth || ii.width, h: ii.thumbheight || ii.height, page: ii.descriptionurl || '', from: 'Wikimedia Commons' };
  }
  return null;
}

export async function findPicture(subject, query, kind) {
  return (await fromWikipedia(subject, kind)) || (await fromCommons(query || subject, kind));
}

// The few places in an answer where a picture says what the words cannot, each
// found and checked. Null when there is nothing to read; throws when the reading
// itself failed, so the answer is read again later rather than marked as empty.
export async function answerPictures(answer) {
  const text = String(answer || '');
  if (text.length < 300) return null;
  const result = await generateText({
    feature: 'summary', maxTokens: 1400, label: 'room:pictures', timeoutMs: 45_000, maxAttempts: 2,
    claudeLastResort: true, helperWaitMs: 60_000,
    prompt: 'Below is an answer someone is reading. Choose the few moments where seeing a real picture would change what the words mean to them — where the text describes or leans on something that has a look: a painting or artwork it discusses, the place where something happened, a building, a historical photograph an event is remembered by, an object, an animal or a natural phenomenon, a map that makes a spread or a border visible, a scientific image.\n'
      + 'Most answers deserve none or one. Choose at most ' + MAX_PICK + ', fewer is better. Never a picture that only decorates.\n'
      + 'Never pick a person (faces are handled elsewhere) and never a book, film or series (covers are handled elsewhere). Never an abstract idea with no look of its own — unless the answer itself points to one famous image that embodies it (a named painting, a known photograph).\n'
      + 'For each: "anchor" — 3 to 8 words copied letter for letter from the answer, at the place where the picture belongs; "subject" — the exact English Wikipedia article title whose lead picture shows it; "query" — 2 to 5 words to search Wikimedia Commons for the same picture if the article has none; "caption" — 3 to 9 plain words saying what the picture shows; "kind" — place|building|art|event|object|nature|map|science|other; "weight" — 3 when the answer cannot really be pictured without it, 2 when it helps, 1 when it is only nice.\n'
      + 'Reply with JSON only: {"pictures":[{"anchor":"","subject":"","query":"","caption":"","kind":"","weight":2}]}, or {"pictures":[]}.\n\n'
      + '=== ANSWER ===\n' + text.slice(0, 12000),
  });
  if (result.error) throw new Error(String(result.error));
  const list = firstJson(result.text)?.pictures;
  if (!Array.isArray(list)) throw new Error('unreadable reply');
  const body = flat(text);
  const picks = [];
  for (const p of list.slice(0, MAX_PICK)) {
    const anchor = plain(p?.anchor).slice(0, 120);
    const subject = plain(p?.subject).slice(0, 140);
    // The anchor has to be in the words, or the picture has nowhere true to hang.
    if (anchor.split(/\s+/).length < 2 || !subject || body.indexOf(flat(anchor)) < 0) continue;
    const kind = KINDS.has(p?.kind) ? p.kind : 'other';
    picks.push({ anchor, subject, query: plain(p?.query || subject).slice(0, 100), caption: plain(p?.caption).slice(0, 90),
      kind, weight: Math.max(1, Math.min(3, Number(p?.weight) || 2)) });
  }
  const found = await Promise.all(picks.map(async (p) => {
    const img = await findPicture(p.subject, p.query, p.kind);
    return img ? { anchor: p.anchor, caption: p.caption || p.subject, subject: p.subject, kind: p.kind, weight: p.weight, ...img } : null;
  }));
  const seen = new Set(), out = [];
  for (const f of found) {
    if (!f || seen.has(f.url)) continue;
    seen.add(f.url); out.push(f);
  }
  out.sort((a, b) => b.weight - a.weight);
  return out.length ? out.slice(0, MAX_KEEP) : null;
}

// Answers written before pictures were chosen are read once, when their
// conversation opens: newest first, a few per call, each stored with its list —
// an empty one too, so it is never read again.
const scanning = new Set();
const failures = new Map();
export async function scanPictures(convoId, { limit = 6 } = {}) {
  if (!db || !convoId) return { found: {}, more: false };
  const rows = db.prepare(`SELECT id, text, meta FROM convo_messages WHERE convo_id=? AND role='assistant' AND kind='chat' ORDER BY created_at DESC, rowid DESC`).all(convoId);
  const unread = rows.filter((r) => {
    let meta = {}; try { meta = r.meta ? JSON.parse(r.meta) || {} : {}; } catch { meta = {}; }
    return !meta.failed && (!Array.isArray(meta.pictures) || (Number(meta.picturesV) || 0) < PICTURES_V)
      && !scanning.has(r.id) && (failures.get(r.id) || 0) < 2 && String(r.text || '').trim();
  });
  const todo = unread.slice(0, limit);
  const found = {};
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (r) => {
      scanning.add(r.id);
      try {
        let pictures;
        try { pictures = await answerPictures(r.text); } catch { failures.set(r.id, (failures.get(r.id) || 0) + 1); return; }
        const fresh = db.prepare('SELECT meta FROM convo_messages WHERE id=?').get(r.id);
        let meta = {}; try { meta = fresh?.meta ? JSON.parse(fresh.meta) || {} : {}; } catch {}
        meta.pictures = pictures || [];
        meta.picturesV = PICTURES_V;
        db.prepare('UPDATE convo_messages SET meta=? WHERE id=?').run(JSON.stringify(meta), r.id);
        found[r.id] = meta.pictures;
      } finally { scanning.delete(r.id); }
    }));
  }
  return { found, more: unread.length > todo.length };
}
