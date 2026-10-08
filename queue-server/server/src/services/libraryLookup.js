// The Library, as the Room's model sees it (his ask, 2026-10-08: "look at a book in
// the library", in the main conversation or a side talk alike).
//
// Nothing rides unless he points at it. A title from his Library named in his
// message brings that work with what the app already knows about it — the
// catalogue's synopsis, the rating, the book a film came from, the line on why it
// is here. Pointing at the Library itself ("my library", "ma bibliothèque", "my
// films") brings the whole list of titles too, so the model can look through it.
// Only cached facts are read: no catalogue is asked while he waits for an answer.

import { listInterests } from './interestLibrary.js';
import { listBooks } from './bookShelf.js';
import { cachedBookFacts } from './bookFacts.js';
import { cachedScreenFacts } from './screenFacts.js';

const POINTED = /\b(?:library|librar(?:y|ies)|biblioth[eè]que|shelf|[eé]tag[eè]re|saved|my (?:books?|films?|movies?|series|shows?|list)|mes (?:livres|films|s[eé]ries)|ma liste)\b/i;
const LIST_CAP = 24000;
const NAMED_CAP = 8;

const plain = (t) => String(t || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function titleKey(t) {
  const raw = String(t || '').replace(/\s+/g, ' ').trim();
  const main = raw.split(/\s*[:—–]\s*|\s+-\s+/)[0] || raw;
  return plain(main.length >= 3 ? main : raw).replace(/^(the|a|an|le|la|les|l) /, '');
}
// A one-word title ("Broken", "Dune") counts only when he wrote it as a name.
function names(text, said, title) {
  const k = titleKey(title);
  if (k.length < 4 || !` ${said} `.includes(` ${k} `)) return false;
  if (k.includes(' ')) return true;
  const bare = String(text).normalize('NFKD').replace(/\p{M}/gu, '');
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...bare.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'))].some((m) => /\p{Lu}/u.test(m[0][0]));
}

function allWorks(owner) {
  const works = [];
  for (const kind of ['book', 'film', 'series']) {
    for (let offset = 0; offset < 2000; offset += 100) {
      const rows = listInterests(owner, { kind, limit: 100, offset });
      works.push(...rows);
      if (rows.length < 100) break;
    }
  }
  return works;
}

function line(w) {
  return `${w.kind} · ${w.title}${w.creator ? ` — ${w.creator}` : ''}${w.year ? ` (${w.year})` : ''}${w.episode ? ` · episode ${w.episode}` : ''}${w.whole ? ' · whole text on the shelf' : ''}`;
}

function described(owner, w) {
  const f = (w.kind === 'book' ? cachedBookFacts(w.title, w.creator) : cachedScreenFacts(owner, w.kind, w.title, w.year)) || {};
  return [
    line(w),
    f.overview ? `What it is: ${String(f.overview).slice(0, 900)}` : '',
    f.rating ? `Rated ${Number(f.rating).toFixed(1)}/10 by ${f.votes || 'some'} people${f.ratingFrom === 'imdb' ? ' on IMDb' : ''}.` : '',
    f.book?.title ? `Made from the book "${f.book.title}"${f.book.author ? ` by ${f.book.author}` : ''}.` : '',
    f.relevance ? `Why it is in his library (written earlier): ${String(f.relevance).slice(0, 700)}` : '',
  ].filter(Boolean).join('\n');
}

export function libraryContext(owner, text) {
  const said = plain(text);
  if (!owner || !said) return '';
  const pointed = POINTED.test(text);
  let works;
  try {
    works = allWorks(owner);
    for (const b of listBooks(owner)) {
      const twin = works.find((w) => w.kind === 'book' && titleKey(w.title) === titleKey(b.title));
      if (twin) twin.whole = true;
      else works.push({ kind: 'book', title: b.title, creator: b.author || '', year: b.year || '', whole: true });
    }
  } catch (err) { return ''; }
  if (!works.length) return '';

  const named = works.filter((w) => names(text, said, w.title)).slice(0, NAMED_CAP);
  if (!named.length && !pointed) return '';

  const parts = ['\n=== HIS LIBRARY ===',
    'What he has saved in the app\'s Library. Saved means he was drawn to it, not that he has read or watched it.'];
  if (named.length) parts.push('\nTHE ONES HE NAMES:\n' + named.map((w) => described(owner, w)).join('\n\n'));
  if (pointed) {
    const wantKind = /\b(books?|livres?)\b/i.test(text) ? 'book' : /\b(films?|movies?)\b/i.test(text) ? 'film' : /\b(series|s[eé]ries|shows?)\b/i.test(text) ? 'series' : '';
    const pool = wantKind ? works.filter((w) => w.kind === wantKind) : works;
    let list = '', n = 0;
    for (const w of pool) {
      const l = line(w) + '\n';
      if (list.length + l.length > LIST_CAP) break;
      list += l; n += 1;
    }
    parts.push(`\nEVERYTHING IN IT${wantKind ? ` (${wantKind === 'series' ? 'series' : wantKind + 's'})` : ''}, newest first${n < pool.length ? ` — the newest ${n} of ${pool.length}` : ''}:\n${list.trim()}`);
  }
  return parts.join('\n');
}
