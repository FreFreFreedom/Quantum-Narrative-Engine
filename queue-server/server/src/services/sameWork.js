// One rule for "is this the same work?", shared by every path that writes to or
// reads from the Library, so a double cannot slip in through the one path that
// still compared exact titles (his ask, 2026-09-28: "no double entries").
//
// "The New Jim Crow: Mass Incarceration in the Age of Colorblindness" and
// "New Jim Crow" are one book; a film saved once as a series is one work; a book
// and the film made from it are two works that the Library shows as a pair.

const norm = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// The title without its subtitle or a leading article.
export function workKey(t) {
  const raw = String(t || '').replace(/\s+/g, ' ').trim();
  const main = raw.split(/\s*[:—–]\s*|\s+-\s+/)[0] || raw;
  return norm(main.length >= 3 ? main : raw).replace(/^(the|a|an|le|la|les|l) /, '');
}
export function sameWork(a, b) { const x = workKey(a); return !!x && x === workKey(b); }

// Film and series are one family: the same title under both is one work.
export const kindGroup = (k) => (k === 'film' || k === 'series') ? 'screen' : String(k || '');

// "Desmond, Matthew" and "Matthew Desmond" are one author; an empty side never
// disagrees. Two books sharing a main title but by different people stay two.
export function sameMaker(a, b) {
  const x = norm(a).split(' ').filter((t) => t.length > 2);
  const y = new Set(norm(b).split(' ').filter((t) => t.length > 2));
  return !x.length || !y.size || x.some((t) => y.has(t));
}

// Two Library entries that are the same thing: same family, same main title, and
// nothing that tells them apart (the author for a book, the year for a screen work).
// A series and one of its episodes are two entries; two episodes are two too.
export const sameEpisode = (a, b) => norm(a) === norm(b);
export function sameEntry(a, b) {
  if (!a || !b || kindGroup(a.kind) !== kindGroup(b.kind) || !sameWork(a.title, b.title) || !sameEpisode(a.episode, b.episode)) return false;
  if (kindGroup(a.kind) === 'screen') {
    const ya = String(a.year || '').match(/\d{4}/)?.[0], yb = String(b.year || '').match(/\d{4}/)?.[0];
    return !ya || !yb || ya === yb;
  }
  return sameMaker(a.creator, b.creator);
}

// A key for grouping: entries with different keys are never the same work.
export function workFingerprint(item) {
  if (!item || !['book', 'film', 'series'].includes(item.kind)) return null;
  const k = workKey(item.title);
  return k ? kindGroup(item.kind) + '|' + k + (item.episode ? '|ep ' + norm(item.episode) : '') : null;
}
