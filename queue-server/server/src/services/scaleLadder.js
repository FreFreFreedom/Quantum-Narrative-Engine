// The scale ladder — plans/scale-as-an-ordered-ladder.md, and Stage 1 of
// plans/civic-structures-and-loops.md.
//
// `entities.scale` is a plain text column with no ordering. Three legacy values were
// written by bootstrapData.js from the start (`individual`, `film`, `national`); the
// civic-structures work adds rungs that name themselves (`family`, `institution`,
// `city`). This module is the one place that says what order those rungs are in, so
// "cross-scale" can mean a real distance instead of "the two rows have different types".
//
// The ladder itself is the paradigm's, unchanged, from data-seed/docs/fractal_vision_spec.md
// ("The scale ladder"): somatic/cell → psyche/individual → family/lineage → group →
// organisation/institution → city → nation → civilisation → planetary → cosmos.
//
// Two rules this file exists to hold:
//
//   1. A MEDIUM HAS NO RUNG. A film does not maintain a boundary against its own
//      dissolution — it is a fixed record carrying the testimony of entities that do
//      (fractal_operational_core.md §1). So `film` maps to null, not to a rung, and
//      never participates in a distance calculation. Its *characters* have rungs.
//   2. NO RUNG IS NOT RUNG ZERO. rungDistance() returns null rather than a number when
//      either side is unplaced, so an unplaced entity cannot accidentally sort as the
//      nearest or the furthest thing in the corpus.
//
// Empty rungs are kept. Cell, group, civilisation, planetary and cosmos hold zero
// entities in this corpus today; that is a true fact about the corpus, not a bug to
// paper over by trimming the ladder to what happens to be populated.

// Ordered, smallest first. `key` is what may be stored in entities.scale; `name` is for
// display; `vocab` is the per-domain naming from the spec's "Vocabulary translation"
// table, which is what makes the ladder legible rather than a code-only abstraction.
export const SCALE_LADDER = [
  { key: 'cell', name: 'Cell / soma', vocab: { biology: 'tissue · lesion · autoimmunity' } },
  { key: 'individual', name: 'Individual / psyche', vocab: { psychology: 'shadow · complex · projection' } },
  { key: 'family', name: 'Family / lineage', vocab: { psychology: 'estrangement · the black sheep · disowning' } },
  { key: 'group', name: 'Group', vocab: { sociology: 'out-group · norm violation · scapegoat mechanism' } },
  { key: 'institution', name: 'Organisation / institution', vocab: { sociology: 'purge · forced-out faction · exclusion rule' } },
  { key: 'city', name: 'City', vocab: { sociology: 'segregation · zoning · the wrong side of the line' } },
  { key: 'nation', name: 'Nation', vocab: { religion: 'exile · demonisation · redemption' } },
  { key: 'civilisation', name: 'Civilisation', vocab: { religion: 'the fall · the covenant · the remnant' } },
  { key: 'planetary', name: 'Planetary', vocab: { cosmology: 'aspect · resonance · synchronicity' } },
  { key: 'cosmos', name: 'Cosmos', vocab: { cosmology: 'aspect · resonance · synchronicity' } },
];

// Legacy stored values that predate the ladder, mapped without touching the data. Do not
// migrate entities.scale — this lookup is the migration.
const LEGACY = {
  national: 'nation',   // written by bootstrapData.js for countries
  film: null,           // a medium, not a rung — see rule 1 above
};

const INDEX = new Map(SCALE_LADDER.map((r, i) => [r.key, i]));

// The rung a stored scale value sits on, or null if it names no rung (a medium, an
// unknown value, or nothing at all). Never throws — an unrecognised value is a corpus
// fact to report, not an exception to handle at every call site.
export function rungOf(scale) {
  if (!scale) return null;
  const key = Object.prototype.hasOwnProperty.call(LEGACY, scale) ? LEGACY[scale] : scale;
  if (!key) return null;
  const i = INDEX.get(key);
  return i === undefined ? null : i;
}

export function rungKeyOf(scale) {
  const i = rungOf(scale);
  return i === null ? null : SCALE_LADDER[i].key;
}

export function rungName(scale) {
  const i = rungOf(scale);
  return i === null ? null : SCALE_LADDER[i].name;
}

// How many rungs apart, or null when either side is unplaced (rule 2). Callers must
// treat null as "cannot compare", never as 0.
export function rungDistance(scaleA, scaleB) {
  const a = rungOf(scaleA);
  const b = rungOf(scaleB);
  if (a === null || b === null) return null;
  return Math.abs(a - b);
}

// Adjacent rungs — what vertical navigation is allowed to cross in one step. The
// paradigm's rule is that neither direction skips a rung: every intermediate node is
// real, visited and causal (fractal_operational_core.md §9). Stage 4's relation writer
// enforces exactly this.
export function isAdjacentRung(scaleA, scaleB) {
  return rungDistance(scaleA, scaleB) === 1;
}

// 'up' (A is smaller than B), 'down', or null when they cannot be compared or sit on the
// same rung.
export function rungDirection(scaleFrom, scaleTo) {
  const a = rungOf(scaleFrom);
  const b = rungOf(scaleTo);
  if (a === null || b === null || a === b) return null;
  return a < b ? 'up' : 'down';
}
