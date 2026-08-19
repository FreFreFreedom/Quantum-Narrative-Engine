// One description of what this app IS, shared by every prompt that asks a model to
// think about the app.
//
// Why this file exists. Six prompts used to carry their own hand-written intro, and
// every one of them described FMCNS as a content tool: "a personal research platform
// that maps archetypal patterns across film characters, countries…". None of them
// mentioned that the app is also a system that builds itself — a queue that hands
// work to a coding agent, a live map of its own architecture, self-observation, a
// suggestion engine, an idea studio, a look at the world.
//
// The consequence was measurable, not theoretical: asked "what should I build next?",
// every engine proposed work on the material and almost never on the machine, because
// as far as the prompt was concerned the machine did not exist. Antoine reported it
// on a task about the Core Architecture section whose recommendations were all about
// the Content navigator.
//
// So the blurb below gives the two halves EQUAL WEIGHT, deliberately, and every prompt
// imports it instead of writing its own. Change it here and every engine changes.
//
// Plain English, per AGENTS.md: this text is not shown to Antoine, but the answers
// written from it are, and a jargon-laden self-description produces jargon-laden
// suggestions.

export const APP_BLURB =
  'FMCNS (Fractal Mythic Consciousness Navigation System), a personal research system with two halves that matter equally. ' +
  'THE MATERIAL: characters, films and countries held in one shared shape (a "character" is the universal unit — a person, ' +
  'a film and a nation are instances of one schema), tagged with archetypal patterns, scored on named spectrum axes, and ' +
  'navigated as a graph across scales. ' +
  'THE MACHINE THAT BUILDS IT: the app builds itself. It keeps a live map of its own architecture, watches that map for its ' +
  'own weak spots, ranks what to build next, proposes new work, talks a half-formed idea into a runnable task, looks at the ' +
  'world for inspiration before planning, hands the work to a coding agent, and ships the result. ' +
  'Both halves are real, active development areas. Neither is a footnote to the other.';

// The six areas of the app's own map of itself. Kept here (not only in the frontend)
// because several prompts have to enumerate them, and an enumeration that drifts out
// of sync with fmcns_navigator.html's TERRITORIES silently teaches the model that an
// area does not exist — which is exactly the bug this file exists to fix.
export const TERRITORY_LIST = [
  { id: 'perception', label: 'Perception', sub: 'how new material gets in' },
  { id: 'knowledge', label: 'Knowledge', sub: 'the shared shape, the tags, the cross-type links' },
  { id: 'reasoning', label: 'Reasoning', sub: 'the pattern engines and the spectrum axes' },
  { id: 'experience', label: 'Experience', sub: 'how it feels to move through the material' },
  { id: 'interface', label: 'Interface', sub: 'the look and feel' },
  { id: 'self', label: 'Core architecture', sub: "the app's own build system — the queue, the worker, shipping, self-observation, ranking, suggestions, the idea studio, the look at the world" },
];

export const TERRITORY_IDS = TERRITORY_LIST.map((t) => t.id);

export const TERRITORY_LINES = TERRITORY_LIST
  .map((t) => `- ${t.id} (${t.label}): ${t.sub}`)
  .join('\n');

// Attach to any prompt that answers a SPECIFIC request — a task, one component, one
// note. Without it the model answers about whatever part of the app it finds most
// interesting, which is how a task about the Core Architecture section came back with
// Content-navigator recommendations.
export function onSubjectRule(subjectLabel) {
  const where = subjectLabel ? `THIS part of the app: ${subjectLabel}` : 'THIS part of the app';
  return (
    `STAY ON SUBJECT. Everything you answer must serve THIS request, on ${where}. ` +
    `Do not propose improvements to other parts of the app, however attractive they are — ` +
    `an interesting answer about the wrong part of the app is a wrong answer. ` +
    `If you cannot say something useful about this subject, say fewer things rather than ` +
    `widening the subject.`
  );
}
