// The one stopword list, in a module with no dependencies.
//
// It started inside services/mind.js, where it drops filler words before normalising a
// fact for the deterministic dedup check. entityMentions.js needs exactly the same list to
// block entity names that are ordinary English words — and importing it from mind.js would
// have dragged the realtime server and every AI lane into a matcher that is pure string
// work, and into a selftest that is meant to run with nothing installed. Two copies would
// drift. So it lives here and both import it.
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'my', 'me', 'we', 'our', 'you', 'it', 'its',
  'is', 'are', 'was', 'were', 'am', 'do', 'does', 'did', 'have', 'has', 'had',
  'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'this', 'that', 'these',
  'those', 'with', 'as', 'at', 'be', 'been', 'being', 'will', 'would', 'should',
  'can', 'could', 'about', 'he', 'she', 'they', 'them', 'his', 'her', 'their',
]);
