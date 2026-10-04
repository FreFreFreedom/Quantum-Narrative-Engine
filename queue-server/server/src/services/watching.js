// What he is actually watching (his ask, 2026-10-04). The Plex extension pings this
// as an episode plays: which one, how far in, and — once per item — its subtitles with
// their times. Two things come out of it. The Library learns what he watches without
// him saving anything. And the Room can talk about a series knowing exactly what he
// has seen: the dialogue it is given stops at his own watch position, so it can read
// the relationships so far and never spoil what is coming.
import { randomUUID } from 'node:crypto';

let db = null;

export function bindWatching(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS watched_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'episode',
    series TEXT NOT NULL DEFAULT '',
    series_key TEXT NOT NULL DEFAULT '',
    season INTEGER,
    episode INTEGER,
    title TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    offset_ms INTEGER NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    cues TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS watched_items_series ON watched_items(series_key, season, episode)');
}

const key = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
// Watched to the end in practice: the credits are not the story.
const FINISHED_AT = 0.92;

export function recordWatch(input = {}) {
  if (!db) return { error: 'no_db' };
  const id = String(input.id || '').trim().slice(0, 120);
  if (!id) return { error: 'id_required' };
  const series = String(input.series || input.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const durationMs = Number(input.durationMs || 0) || 0;
  const offsetMs = Number(input.offsetMs || 0) || 0;
  const finished = input.finished ? 1 : (durationMs > 0 && offsetMs / durationMs >= FINISHED_AT ? 1 : 0);
  const cues = Array.isArray(input.cues) && input.cues.length ? JSON.stringify(input.cues.slice(0, 4000)) : '';

  const row = db.prepare('SELECT id, offset_ms, finished, cues FROM watched_items WHERE id=?').get(id);
  if (row) {
    db.prepare(`UPDATE watched_items SET
      offset_ms = MAX(offset_ms, ?), finished = MAX(finished, ?),
      duration_ms = CASE WHEN ? > 0 THEN ? ELSE duration_ms END,
      cues = CASE WHEN cues = '' AND ? <> '' THEN ? ELSE cues END,
      last_seen_at = CURRENT_TIMESTAMP
      WHERE id=?`).run(offsetMs, finished, durationMs, durationMs, cues, cues, id);
  } else {
    db.prepare(`INSERT INTO watched_items
      (id, kind, series, series_key, season, episode, title, duration_ms, offset_ms, finished, cues)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input.kind === 'movie' ? 'movie' : 'episode',
      series, key(series),
      input.season == null ? null : Number(input.season),
      input.episode == null ? null : Number(input.episode),
      String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      durationMs, offsetMs, finished, cues,
    );
  }
  mirrorToLibrary(series, input.kind === 'movie' ? 'film' : 'series');
  return { ok: true, id, finished: !!finished, hasCues: !!(cues || (row && row.cues)) };
}

// The Library row is the same one the Room already reads from, so a series he is
// watching turns up in a conversation without him saving anything by hand.
const OWNER = 'antoine';
function mirrorToLibrary(title, kind) {
  if (!db || !title) return;
  try {
    const identity = kind + ':' + key(title);
    const hit = db.prepare('SELECT id, state FROM interest_works WHERE owner=? AND identity=?').get(OWNER, identity);
    if (hit) {
      if (hit.state !== 'watching') db.prepare("UPDATE interest_works SET state='watching' WHERE id=?").run(hit.id);
      return;
    }
    db.prepare(`INSERT INTO interest_works (id, owner, kind, title, identity, state)
      VALUES (?,?,?,?,?,'watching')`).run(randomUUID(), OWNER, kind, title, identity);
  } catch (err) {
    console.warn('[watching] library mirror failed:', err.message);
  }
}

export function listWatched({ query = '', limit = 60 } = {}) {
  if (!db) return [];
  const rows = db.prepare(`SELECT id, kind, series, season, episode, title, duration_ms, offset_ms, finished, last_seen_at,
    (cues <> '') AS has_dialogue FROM watched_items ORDER BY last_seen_at DESC LIMIT ?`).all(Math.min(Number(limit) || 60, 200));
  const q = key(query);
  return q ? rows.filter((r) => key(r.series).includes(q) || key(r.title).includes(q)) : rows;
}

// One line per thing watched, grouped by series, for a prompt or a card.
export function watchedSummary({ limit = 20 } = {}) {
  const rows = listWatched({ limit: 400 });
  const bySeries = new Map();
  for (const r of rows) {
    const k = key(r.series) || key(r.title);
    if (!bySeries.has(k)) bySeries.set(k, { series: r.series || r.title, kind: r.kind, items: [] });
    bySeries.get(k).items.push(r);
  }
  return [...bySeries.values()].slice(0, limit).map((g) => {
    const done = g.items.filter((i) => i.finished);
    const open = g.items.filter((i) => !i.finished).sort((a, b) => b.offset_ms - a.offset_ms)[0];
    const where = open && open.duration_ms
      ? `, part way through ${label(open)} (${Math.round((open.offset_ms / open.duration_ms) * 100)}%)`
      : '';
    return `${g.series}: ${done.length} ${g.kind === 'movie' ? 'watched' : 'episodes finished'}${where}`;
  });
}

function label(r) {
  if (r.kind === 'movie') return r.title || r.series;
  const se = r.season != null && r.episode != null ? `S${r.season}E${r.episode}` : '';
  return [se, r.title].filter(Boolean).join(' ') || r.id;
}

// The dialogue of what he has actually seen, and not one line more. Finished items
// come whole; the one he is in the middle of is cut at his own position.
export function watchedDialogue({ series = '', maxChars = 60_000 } = {}) {
  if (!db) return { error: 'no_db' };
  const k = key(series);
  const rows = db.prepare(`SELECT * FROM watched_items WHERE (? = '' OR series_key = ?)
    ORDER BY season IS NULL, season, episode, first_seen_at`).all(k, k);
  if (!rows.length) return { error: 'nothing_watched' };

  const parts = [];
  let seenAny = false;
  for (const r of rows) {
    if (!r.finished && r.offset_ms <= 0) continue;
    seenAny = true;
    if (!r.cues) { parts.push(`### ${label(r)}\n(no subtitles were saved for this one)`); continue; }
    let cues = [];
    try { cues = JSON.parse(r.cues); } catch { continue; }
    const cutS = r.finished ? Infinity : r.offset_ms / 1000;
    const text = cues.filter((c) => Number(c[0]) <= cutS).map((c) => c[1]).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    parts.push(`### ${label(r)}${r.finished ? '' : ' (he is part way through this one — it stops where he is)'}\n${text}`);
  }
  if (!seenAny) return { error: 'nothing_watched' };

  // Too long for one prompt: the earliest is trimmed first, the most recent kept whole.
  let out = parts.join('\n\n');
  while (out.length > maxChars && parts.length > 1) { parts.shift(); out = parts.join('\n\n'); }
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return { ok: true, text: out };
}

// Only when he names it. A standing list of everything he watches riding on every
// answer would be a rule in all but name — the Room gets one line, and only about
// the thing he just mentioned.
export function watchingContext(text) {
  if (!db) return '';
  const t = key(text);
  if (!t || t.length < 3) return '';
  const rows = listWatched({ limit: 400 });
  const titles = new Map();
  for (const r of rows) {
    const name = r.series || r.title;
    const k = key(name);
    if (k && k.length >= 3 && t.includes(k)) titles.set(k, name);
  }
  if (!titles.size) return '';
  const lines = watchedSummary({ limit: 40 }).filter((l) => [...titles.values()].some((n) => l.startsWith(n + ':')));
  if (!lines.length) return '';
  return `\n=== WHAT HE HAS WATCHED OF THIS ===\n${lines.join('\n')}\n`
    + 'Call read_watched_dialogue for what he has actually seen. It stops at his own position — '
    + 'do not go past it, and do not bring in anything you know about later episodes.\n';
}

// ---------------------------------------------------------------------------
// What the Room may ask for.
export const WATCHING_TOOLS = [
  {
    name: 'list_watched',
    description: 'What he has actually watched on his own media server — series with how many episodes he has finished and how far into the current one he is, and films. Use this before talking about a series so you know where he is.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'narrow to one series or film' } } },
  },
  {
    name: 'read_watched_dialogue',
    description: 'The actual dialogue of what he has watched of a series or film, in order. It STOPS at his own watch position — nothing after it is ever returned, so you cannot spoil what he has not seen. Use it to discuss characters, relationships and what has happened so far.',
    input_schema: { type: 'object', properties: { series: { type: 'string', description: 'the series or film title' } }, required: ['series'] },
  },
];

export function watchingTool(name, args = {}) {
  if (name === 'list_watched') {
    const lines = watchedSummary({ limit: 20 });
    const q = key(args.query || '');
    const kept = q ? lines.filter((l) => key(l).includes(q)) : lines;
    return kept.length ? kept.join('\n') : 'Nothing watched has been recorded yet.';
  }
  if (name === 'read_watched_dialogue') {
    const out = watchedDialogue({ series: args.series || '' });
    if (out.error === 'nothing_watched') return 'He has not watched anything of that yet.';
    if (out.error) return 'That could not be read.';
    return out.text;
  }
  return 'Unknown tool.';
}
