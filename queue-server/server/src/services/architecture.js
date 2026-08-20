// Architecture Navigator backend — live NOW status, versioned evolution ladders,
// generated "what's next" suggestions, and a build-history trail per component.
//
// Design decisions (per explicit user answers):
// - last_verified_at auto-stamps every time NOW is recomputed from live data (cheap,
//   always fresh — "verified" means "the query ran," not "a human re-read it").
// - Suggestions regenerate manually only (a Regenerate button, not automatic) — cost
//   control, since generation is a real Claude API call, same billing as chat/books.
// - Build history covers work going forward only. Commits are a manually-maintained
//   mapping (the deployed container has no .git access to compute this live); queued
//   prompts are tagged with component_id at creation time from now on.

import { randomUUID } from 'node:crypto';
import { generateText } from './ai/text.js';
import { shippedSince } from './shipFacts.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { APP_BLURB, onSubjectRule } from './ai/appModel.js';

// ─── Static content: what doesn't change with live data ────────────────────────
// WHAT/WHY/INPUT-OUTPUT/depends live in the frontend (fmcns_navigator.html) since
// they're pure prose, not data. This file only owns the parts that are either
// computed live (now_text/status) or versioned/generated content that benefits
// from living in the DB instead of being redeployed with every edit (evolution,
// suggestions).

export const EVOLUTION = {
  'observation-layer': [
    ['v0', 'No formal layer — manual curation only, hand-edited seed JSON (current)'],
    ['v1', 'A defined ingestion contract: what a "new entity submission" must contain'],
    ['v2', 'A semi-automated intake form that writes directly against that contract'],
    ['v3', 'Automated source connectors (e.g. archive/Reddit scraping) feeding the contract without manual entry'],
  ],
  'ontological-layer': [
    ['v0', 'Manually curated seed JSON migrated into one shared entities schema (current)'],
    ['v1', 'The full 199-film corpus represented as character-level rows, not just film containers'],
    ['v2', 'Schema-validated ingestion — writes must pass the ontological contract before landing'],
    ['v3', 'Versioned entity history — track how a record changed over time, not just its current state'],
  ],
  'semantic-layer': [
    ['v0', 'Hand-written tags per entity, no formal vocabulary'],
    ['v1', 'Grounded against primary archive material, cluster by cluster (current — 2 of 12 clusters)'],
    ['v2', 'Full corpus grounded, shared tag vocabulary enforced'],
    ['v3', 'Tag confidence scoring (grounded vs. reasoned shown in the UI, not just tracked internally)'],
  ],
  'analogical-layer': [
    ['v0', 'Client-side tag-overlap + continuum-proximity, recomputed on every render (current)'],
    ['v1', 'Server-side pattern-instance graph, computed once and cached instead of recomputed per client'],
    ['v2', 'Embedding-based similarity augmenting tag-overlap — catches related entities with no identical tags'],
    ['v3', 'GraphRAG-backed analogical traversal (see the GraphRAG ladder)'],
  ],
  'pattern-engine': [
    ['v0', 'No formal engine — tag-overlap count is an informal, implicit proxy (current)'],
    ['v1', 'One formally defined, named pattern as a proof of concept (structure, not just a tag)'],
    ['v2', 'A small pattern library — multiple formal patterns, entities scored against each'],
    ['v3', 'A pattern-authoring workflow — define new patterns without touching code'],
  ],
  'graphrag': [
    ['v0', 'Not built — no graph traversal or retrieval beyond direct DB lookups (current)'],
    ['v1', 'Static community detection over the existing tag/continuum data'],
    ['v2', 'Subgraph retrieval wired into the embedded chat assistant as a real tool'],
    ['v3', 'Dynamic re-clustering as new entities are added, not a one-time static pass'],
  ],
  'scale-echo': [
    ['v0', 'Semantic nearest-neighbor on a single shared axis, cross-type only (current)'],
    ['v1', 'Scale-aware weighting (distance in scale, not just axis value)'],
    ['v2', 'Pattern-instance graph (stored, not recomputed per render)'],
    ['v3', 'GraphRAG analogical traversal'],
    ['v4', 'Temporal trajectory — does the echo hold across time, not just a snapshot?'],
    ['v5', 'Dynamic cross-scale sensing — new entities auto-echo on ingestion'],
  ],
  'integration-continuum': [
    ['v0', 'Two axes (Guilt-as-Engine, Possession/Sovereignty), manually scored (current)'],
    ['v1', 'A third axis once cluster III is archive-grounded'],
    ['v2', 'Axis correlation analysis — which axes move together across the corpus'],
    ['v3', 'User-adjustable axis weighting per exploration session'],
  ],
  'thread-click': [
    ['v0', 'Works, but was reimplemented separately per app before the apps were unified (current)'],
    ['v1', 'Shared click-through across one unified app’s modes — largely true now that Content and Map share one renderer'],
    ['v2', 'A persistent "trail" of clicked-through entities — a breadcrumb history, not just the current selection'],
    ['v3', 'Shareable, bookmarkable deep links to a specific thread'],
  ],
  'fractal-zoom': [
    ['v0', 'Camera zoom/pan only — not truly recursive (current, in Content/Map modes)'],
    ['v1', 'Territory→component drill-down — the Architecture Navigator’s own first real recursive instance'],
    ['v2', 'The same recursive drill-down applied to Content mode: zoom into a cluster reveals its own subgraph'],
    ['v3', 'Zoom into a single entity reveals its own internal pattern-instance graph'],
  ],
  'maps': [
    ['v0', '10 hand-scored countries, static boundaries and static data (superseded)'],
    ['v1', 'Moved onto live backend data, sharing the full entity detail panel (current, shipped)'],
    ['v2', 'Extend scoring beyond the current 10 countries'],
    ['v3', 'Sub-national drill-down — regions or cities within a scored country'],
  ],
  'exploration': [
    ['v0', 'Per-app local search/filter only, before the apps were unified'],
    ['v1', 'Search across all entity types in the one live app (current, mostly true post-unification)'],
    ['v2', 'Saved searches / smart filters'],
    ['v3', 'Natural-language search via the embedded chat assistant’s existing query tools'],
  ],

  // ─── Interface territory: visual/UX quality, tracked as its own territory since
  // nothing else had a home for it — the graph-clutter issue existed for a while
  // before it got flagged manually, precisely because there was no tracked owner.
  'layout-spacing': [
    ['v0', 'Inconsistent spacing, no shared scale — ad hoc padding/margin per view (current)'],
    ['v1', 'A documented spacing scale applied consistently across Content/Map/Architecture'],
    ['v2', 'Responsive layout — usable below desktop width, not just a fixed-width app shell'],
  ],
  'typography-color': [
    ['v0', 'Per-view color choices, some duplicated/inconsistent ramps (current)'],
    ['v1', 'One shared color system — cluster colors, type colors, and semantic colors documented once'],
    ['v2', 'Full dark-mode pass — currently light-surface-only'],
  ],
  'interaction-patterns': [
    ['v0', 'Click-drag pan, scroll-wheel zoom, hover/click on nodes and now edges (current)'],
    ['v1', 'Native trackpad gestures — two-finger scroll to pan, pinch to zoom, matching OS conventions'],
    ['v2', 'Consistent spotlight/fade focus pattern applied everywhere selection happens, not just the graph'],
  ],
  'per-view-polish': [
    ['v0', 'Uneven — some views (Architecture Navigator) more considered than others (Content graph) (current)'],
    ['v1', 'Content graph brought up to the same bar as Architecture Navigator (cluster-zone layout, spotlight/fade — shipped this round; clutter/label-legibility fixes remain open)'],
    ['v2', 'Map mode polish pass — currently reuses Content mode\'s detail panel but hasn\'t had its own dedicated review'],
  ],

  // ─── Core architecture: the app's own build system ───────────────────────────
  // These nine mirror the 'self' territory added to ARCH_DATA in the frontend.
  // getComponents() iterates Object.keys(EVOLUTION), so a component only exists on
  // the server once it has a ladder here — which is why they had to be added in both
  // places, not one.
  'self-model': [
    ['v0', 'Hand-written list in the app\'s own code, sent up with every request (current)'],
    ['v1', 'Stored in the database, editable from inside the app'],
    ['v2', 'Pieces discovered from the code itself instead of described by hand'],
  ],
  'dispatch-queue': [
    ['v0', 'One task at a time, no plan drafted first, no conversation'],
    ['v1', 'Plan drafted before every run, a conversation per task, park and resume (current)'],
    ['v2', 'Several tasks running side by side on isolated copies of the code'],
    ['v3', 'A team of specialists working the same task from different angles'],
  ],
  'agent-runner': [
    ['v0', 'Claude started in the container, work lost on restart'],
    ['v1', 'Runs on the Mac against the real code, logs survive a restart, real cost read back, model steps down on quota (current)'],
    ['v2', 'A separate copy of the code per running task, so two runs can never collide'],
  ],
  'shipping-line': [
    ['v0', 'Shipping by hand, no undo'],
    ['v1', 'One step from the Mac, live and undoable afterwards (current)'],
    ['v2', 'The app is checked to still load before anything is pushed'],
  ],
  'self-observation': [
    ['v0', 'Weak spots on the structure only, drawn on the graph'],
    ['v1', 'Health scores recorded daily, thoughts kept as a feed (current)'],
    ['v2', 'Weak spots found by reading the code, not only the map'],
    ['v3', 'Looks back at finished work and learns from how it went'],
  ],
  'next-steps-ranking': [
    ['v0', 'About fifteen competing orders, none of them in charge'],
    ['v1', 'One free order from counting alone, Claude an optional second opinion (current)'],
    ['v2', 'The order you last asked for survives a reload'],
  ],
  'suggestion-engine': [
    ['v0', 'Proposals read the state of the material only'],
    ['v1', 'Both halves of the app read, with a balance rule so neither is starved (current)'],
    ['v2', 'Learns from what gets accepted versus turned down, not only from exact repeats'],
  ],
  'idea-studio': [
    ['v0', 'Ideas typed straight into the queue, unquestioned'],
    ['v1', 'A conversation on any thing in the app that comes out as a parked task (current)'],
    ['v2', 'Compares an idea against the ones already waiting before adding it'],
  ],
  'world-look': [
    ['v0', 'A search of open-source projects only'],
    ['v1', 'Three shelves with the bold one at the heart, checked over before use (current)'],
    ['v2', 'Every shelf held to the subject of the task that asked for it'],
    ['v3', 'Remembers which shelves actually led to shipped work'],
  ],
};

// The 'self' territory's ids, in build order. Used to filter the computed gap list
// (see gapsFor) and to say honestly, in the self-model's own NOW text, how much of
// the app's map is the app itself.
export const SELF_COMPONENT_IDS = [
  'self-model', 'dispatch-queue', 'agent-runner', 'shipping-line', 'self-observation',
  'next-steps-ranking', 'suggestion-engine', 'idea-studio', 'world-look',
];

// ─── Live NOW computation ────────────────────────────────────────────────────
// Each function returns { text, status }. Falls back to a static description when
// there's genuinely no live signal for that component (e.g. nothing is built yet).
const NOW_COMPUTERS = {
  'observation-layer': () => ({
    text: 'Not built as its own layer. All intake is still manual: entities are hand-curated in seed JSON and edited directly. No ingestion pipeline, submission form, or automated source-checking exists.',
    status: 'Concept',
  }),
  'ontological-layer': (db) => {
    const rows = db.prepare(`SELECT type, COUNT(*) as n FROM entities GROUP BY type`).all();
    const counts = Object.fromEntries(rows.map(r => [r.type, r.n]));
    return {
      text: `Working and deployed. ${counts.film||0} films, ${counts.character||0} characters, and ${counts.country||0} countries are live in the shared entities schema, auto-reseeded on every boot.`,
      status: 'Working',
    };
  },
  'semantic-layer': (db) => {
    const films = db.prepare(`SELECT COUNT(*) as n FROM entities WHERE type='film'`).get().n;
    const grounded = db.prepare(`SELECT COUNT(*) as n FROM entities WHERE type='film' AND grounded=1`).get().n;
    const countries = db.prepare(`SELECT COUNT(*) as n FROM entities WHERE type='country'`).get().n;
    const taggedCountries = db.prepare(`
      SELECT COUNT(DISTINCT entity_id) as n FROM entity_tags
      WHERE entity_id IN (SELECT id FROM entities WHERE type='country')
    `).get().n;
    const pct = films ? Math.round((grounded/films)*100) : 0;
    return {
      text: `${grounded} of ${films} films (${pct}%) are archive-grounded. ${taggedCountries} of ${countries} countries carry archetypal tags. The remaining films are reasoned, not archive-grounded, at character granularity.`,
      status: pct >= 80 ? 'Working' : 'Prototype',
    };
  },
  'analogical-layer': (db) => {
    const tagRows = db.prepare(`SELECT COUNT(*) as n FROM entity_tags`).get().n;
    const taggedEntities = db.prepare(`SELECT COUNT(DISTINCT entity_id) as n FROM entity_tags`).get().n;
    return {
      text: `Prototype. Computed client-side on every render — tag-overlap entanglement (${tagRows} tag rows across ${taggedEntities} tagged entities) and cross-type continuum-proximity bridges. Not a stored graph, not backed by embeddings.`,
      status: 'Prototype',
    };
  },
  'pattern-engine': (db) => {
    const distinctTags = db.prepare(`SELECT COUNT(DISTINCT tag) as n FROM entity_tags`).get().n;
    return {
      text: `Does not exist as a distinct component. ${distinctTags} distinct tags currently function as an informal, implicit proxy for "shares a pattern" — no pattern is defined, stored, or versioned as its own object.`,
      status: 'Concept',
    };
  },
  'graphrag': () => ({
    text: 'Not built. The embedded chat assistant has direct DB query tools (search_entities, get_entity, nearby_on_axis) but no graph traversal, community detection, or subgraph retrieval of any kind.',
    status: 'Concept',
  }),
  'scale-echo': (db) => {
    const scored = db.prepare(`SELECT COUNT(DISTINCT entity_id) as n FROM entity_continuum`).get().n;
    const total = db.prepare(`SELECT COUNT(*) as n FROM entities`).get().n;
    return {
      text: `Prototype, v0. ${scored} of ${total} entities carry at least one continuum score and are bridge-eligible. Implemented as continuum-proximity bridge edges, cross-type only, 0.07 delta threshold on a shared axis — proximity only, not causal or structural similarity.`,
      status: 'Prototype',
    };
  },
  'integration-continuum': (db) => {
    const axes = db.prepare(`SELECT COUNT(*) as n FROM continuum_axes`).get().n;
    const scored = db.prepare(`SELECT COUNT(DISTINCT entity_id) as n FROM entity_continuum`).get().n;
    return {
      text: `Working. ${axes} axes are live with real scores, covering ${scored} entities across characters, films, and countries.`,
      status: 'Working',
    };
  },
  'thread-click': () => ({
    text: 'Working. Click any connection (diagonal/entanglement/bridge) or node to jump to it, shared between Content and Map mode via one renderer now that the apps are unified.',
    status: 'Working',
  }),
  'fractal-zoom': () => ({
    text: 'Prototype. Camera zoom/pan exists in the graph views. Not truly fractal yet — zooming does not reveal a node’s own internal substructure. The Architecture Navigator’s own territory→component drill-down is the first real instance of that pattern.',
    status: 'Prototype',
  }),
  'maps': (db) => {
    const countries = db.prepare(`SELECT COUNT(*) as n FROM entities WHERE type='country'`).get().n;
    const scored = db.prepare(`
      SELECT COUNT(DISTINCT entity_id) as n FROM entity_continuum
      WHERE entity_id IN (SELECT id FROM entities WHERE type='country')
    `).get().n;
    return {
      text: `Working. Real boundaries render for all countries; ${scored} of ${countries} are scored on the Integration Continuum and interactive. Reads live from the backend, shares the full entity detail panel with Content mode.`,
      status: 'Working',
    };
  },
  'exploration': (db) => {
    const total = db.prepare(`SELECT COUNT(*) as n FROM entities`).get().n;
    return {
      text: `Working. Search, cluster filters, and type toggles function across all ${total} live entities in one app. Each mode currently searches the same shared dataset, but there’s no cross-type natural-language search yet.`,
      status: 'Working',
    };
  },

  // Interface territory has no DB signal for visual/UX quality — hand-written status,
  // per the explicit decision to not fake a live number here. Update these by hand
  // when a real UI pass happens, same as any other prose in this file.
  'layout-spacing': () => ({
    text: 'Prototype. No documented spacing scale — padding and margins were set ad hoc per view as each was built. Works, but drift between Content/Map/Architecture is visible on close inspection.',
    status: 'Prototype',
  }),
  'typography-color': () => ({
    text: 'Prototype. TYPE_COLORS, CLUSTER_COLORS, and continuum gradient colors are each defined separately with no shared system. Sentence-case and flat-surface conventions are followed but not written down anywhere.',
    status: 'Prototype',
  }),
  'interaction-patterns': () => ({
    text: 'Prototype. Click-drag pan and scroll-wheel zoom work; node and edge hover/click both now drive a spotlight/fade focus state. No native trackpad gesture support (two-finger pan, pinch-to-zoom) yet — currently flagged as a known gap.',
    status: 'Prototype',
  }),
  'per-view-polish': () => ({
    text: 'Uneven across views. Architecture Navigator got a dedicated design pass; the Content graph did too this round (cluster-zone layout, spotlight/fade, reduced default edge/label density) but was flagged as too cluttered before that fix shipped, and further legibility work is still open. Map mode has not had its own dedicated polish pass — it inherits Content mode\'s detail panel but its own layout hasn\'t been reviewed.',
    status: 'Prototype',
  }),

  // ─── Core architecture: the app's own build system ───────────────────────────
  // Same contract as the content ones: read live rows, say what is true today in
  // plain English. Every count goes through num() so one missing table on an older
  // database degrades to 0 instead of throwing the whole sentence away.
  'self-model': (db) => {
    const pieces = Object.keys(EVOLUTION).length;
    const stored = num(db, `SELECT COUNT(*) n FROM architecture_nodes WHERE deleted_at IS NULL`);
    return {
      text: `Prototype. ${pieces} pieces are described across six areas — ${SELF_COMPONENT_IDS.length} of them the app's own build system, added so that half of the app stops being invisible to its own ranking and suggestions. ${stored} more pieces have been added from inside the app. The list still lives in the app's own code, so the browser has to send it up with every request that needs it.`,
      status: 'Prototype',
    };
  },
  'dispatch-queue': (db) => {
    const total = num(db, `SELECT COUNT(*) n FROM work_prompts WHERE deleted_at IS NULL`);
    const done = num(db, `SELECT COUNT(*) n FROM work_prompts WHERE deleted_at IS NULL AND status='done'`);
    const waiting = num(db, `SELECT COUNT(*) n FROM work_prompts WHERE deleted_at IS NULL AND status IN ('queued','paused')`);
    return {
      text: `Working and in daily use. ${total} tasks have been through the queue, ${done} finished, ${waiting} waiting or parked. Every task is drafted into a plan before it runs, keeps its own conversation, and can be replied to mid-run. Still strictly one at a time.`,
      status: 'Working',
    };
  },
  'agent-runner': (db) => {
    const runs = num(db, `SELECT COUNT(*) n FROM work_prompts WHERE deleted_at IS NULL AND run_model IS NOT NULL`);
    const spent = num(db, `SELECT ROUND(COALESCE(SUM(cost_usd),0), 2) n FROM work_prompts WHERE deleted_at IS NULL`);
    return {
      text: `Working. ${runs} runs measured so far, for ${spent === 0 ? 'nothing yet' : '$' + spent}, read from Claude's own output rather than estimated. Claude runs as a separate program on the Mac against the real code, so a restart mid-task does not lose the work, and it steps down to another model rather than giving up when quota runs out.`,
      status: 'Working',
    };
  },
  'shipping-line': (db) => {
    const shipped = num(db, `SELECT COUNT(*) n FROM git_jobs WHERE status='done'`);
    const failed = num(db, `SELECT COUNT(*) n FROM git_jobs WHERE status='failed'`);
    return {
      text: `Working. ${shipped} pieces of finished work have gone live from the Mac in one step${failed ? `, ${failed} failed on the way` : ''}, each still undoable afterwards with "Put it back". Nothing checks that the app still loads before the push.`,
      status: 'Working',
    };
  },
  'self-observation': (db) => {
    const thoughts = num(db, `SELECT COUNT(*) n FROM intel_thoughts WHERE deleted_at IS NULL`);
    const open = num(db, `SELECT COUNT(*) n FROM intel_thoughts WHERE deleted_at IS NULL AND status='new'`);
    const snaps = num(db, `SELECT COUNT(*) n FROM intel_health_snapshots`);
    const lessons = num(db, `SELECT COUNT(*) n FROM intel_task_lessons`);
    return {
      text: `Prototype. ${thoughts} thoughts written about the app's own state, ${open} still unread, from ${snaps} daily health readings${lessons ? ` and ${lessons} lessons taken from finished work` : ''}. Eleven kinds of weak spot are detected — six on the structure, five on the material. It still only reads the map and the database, never the code itself.`,
      status: 'Prototype',
    };
  },
  'next-steps-ranking': (db) => {
    const moving = num(db, `SELECT COUNT(DISTINCT component_id) n FROM work_prompts WHERE component_id IS NOT NULL AND deleted_at IS NULL AND status IN ('queued','running','paused')`);
    return {
      text: `Working. One order, worked out from counting and arithmetic alone — no Claude, nothing to pay, and the same answer twice. Ready-to-start beats blocked, then how much a piece unlocks, then finishing beats starting${moving ? `; ${moving} pieces already being worked on are held out of the list` : ''}. Claude is an optional second opinion you have to ask for. The order you ask for is lost on reload.`,
      status: 'Working',
    };
  },
  'suggestion-engine': (db) => {
    const open = num(db, `SELECT COUNT(*) n FROM work_suggestions WHERE deleted_at IS NULL AND status='new'`);
    const taken = num(db, `SELECT COUNT(*) n FROM work_suggestions WHERE deleted_at IS NULL AND status='accepted'`);
    const turned = num(db, `SELECT COUNT(*) n FROM work_suggestions WHERE deleted_at IS NULL AND status='dismissed'`);
    return {
      text: `Prototype. ${open} proposals waiting, ${taken} taken into the queue, ${turned} turned down and remembered so they are never proposed again. It now reads both halves of the app — the material and the build system — and has to propose work on each, which it did not before.`,
      status: 'Prototype',
    };
  },
  'idea-studio': (db) => {
    const convos = num(db, `SELECT COUNT(*) n FROM convos`);
    const seeds = num(db, `SELECT COUNT(*) n FROM work_ideas WHERE deleted_at IS NULL`);
    const planted = num(db, `SELECT COUNT(*) n FROM work_ideas WHERE deleted_at IS NULL AND work_prompt_id IS NOT NULL`);
    return {
      text: `Prototype. ${convos} conversations held about things in the app, and ${seeds} notes saved to think about later, ${planted} of them turned into tasks. It opens on any piece, note, proposal or task and already knows what that thing is. What it hands over is always parked — nothing starts without you.`,
      status: 'Prototype',
    };
  },
  'world-look': (db) => {
    const reports = num(db, `SELECT COUNT(*) n FROM discovery_reports`);
    const forTasks = num(db, `SELECT COUNT(*) n FROM discovery_reports WHERE source='prompt'`);
    const plants = num(db, `SELECT COUNT(*) n FROM discovery_pick_plants`);
    return {
      text: `Prototype. ${reports} looks at the world so far, ${forTasks} of them run for a task before its plan was drafted, and ${plants} ideas planted into the map as pieces to build. Three shelves each time — real projects, products that keep their code private, and bold ideas nobody has built — with a quick editor stripping out what does not earn its place.`,
      status: 'Prototype',
    };
  },
};

// One count, or 0 if the table is not there yet. The nine computers above read
// nine different tables; without this, one missing table on an older database
// would take out the whole NOW sentence via computeLiveNow's catch.
function num(db, sql) {
  try { const r = db.prepare(sql).get(); return r ? Number(r.n) || 0 : 0; } catch { return 0; }
}

function computeLiveNow(db, id) {
  const fn = NOW_COMPUTERS[id];
  if (!fn) return { text: null, status: null };
  try { return fn(db); } catch (e) { return { text: null, status: null }; }
}

// ─── Component read/write ────────────────────────────────────────────────────
export function getComponents(db) {
  const ids = Object.keys(EVOLUTION);
  const now = new Date().toISOString();
  return ids.map((id) => {
    const live = computeLiveNow(db, id);
    let row = db.prepare(`SELECT * FROM architecture_components WHERE id=?`).get(id);
    if (live.text) {
      db.prepare(`
        INSERT INTO architecture_components (id, now_text, status, last_verified_at, evolution_json, updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET now_text=excluded.now_text, status=excluded.status,
          last_verified_at=excluded.last_verified_at, updated_at=excluded.updated_at
      `).run(id, live.text, live.status, now, JSON.stringify(EVOLUTION[id] || []), now);
      row = db.prepare(`SELECT * FROM architecture_components WHERE id=?`).get(id);
    } else if (!row) {
      db.prepare(`
        INSERT INTO architecture_components (id, now_text, status, last_verified_at, evolution_json, updated_at)
        VALUES (?,?,?,?,?,?)
      `).run(id, null, null, now, JSON.stringify(EVOLUTION[id] || []), now);
      row = db.prepare(`SELECT * FROM architecture_components WHERE id=?`).get(id);
    }
    return {
      id,
      now_text: row.now_text,
      status: row.status,
      last_verified_at: row.last_verified_at,
      evolution: JSON.parse(row.evolution_json || '[]'),
      suggestions: row.suggestions_json ? JSON.parse(row.suggestions_json) : null,
      suggestions_generated_at: row.suggestions_generated_at,
    };
  });
}

export function getQueueStatus(db) {
  const executionConfigured = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) && !!process.env.CLAUDE_BIN;
  const completed = db.prepare(`SELECT COUNT(*) as n FROM work_prompts WHERE status='done'`).get().n;
  const running = db.prepare(`SELECT COUNT(*) as n FROM work_prompts WHERE status='running'`).get().n;
  const queued = db.prepare(`SELECT COUNT(*) as n FROM work_prompts WHERE status='queued' AND deleted_at IS NULL`).get().n;
  return { executionConfigured, completedCount: completed, runningCount: running, queuedCount: queued, checkedAt: new Date().toISOString() };
}

export function getComponentHistory(db, id) {
  const commits = db.prepare(`
    SELECT sha, message, committed_at FROM component_commits WHERE component_id=? ORDER BY committed_at DESC
  `).all(id);
  const prompts = db.prepare(`
    SELECT id, title, status, created_at, completed_at FROM work_prompts
    WHERE component_id=? AND deleted_at IS NULL ORDER BY created_at DESC
  `).all(id);
  return { commits, prompts };
}

// ─── Suggestion generation (manual trigger only — real API cost) ───────────────
// This used to be a hardcoded KNOWN_GAPS string injected into EVERY component's
// suggestion call. Two things were wrong with it. It had gone stale — its first
// line said "Task queue has no queue UI yet (API-only)", years after the queue UI
// shipped, so every call was told something false. And five of its six lines were
// about the material, so even a suggestion for an interface piece got nudged toward
// corpus grounding. That is a large part of why suggestions for the Core Architecture
// section came back about the Content navigator.
//
// It is now computed, free, from the same rows the ranking reads, and narrowed to
// the component being asked about. A composed sentence about a counted number is
// true; a hand-written list about last year's state is not.
function gapsFor(db, id) {
  const lines = [];
  const isSelf = SELF_COMPONENT_IDS.includes(id);
  try {
    const rows = db.prepare(`SELECT id, status FROM architecture_components`).all();
    const unbuilt = rows.filter((r) => !['Working', 'Validated', 'Advanced'].includes(r.status || ''));
    const mine = unbuilt.filter((r) => SELF_COMPONENT_IDS.includes(r.id) === isSelf);
    if (mine.length) {
      lines.push(`- Not finished yet in this same part of the app: ${mine.map((r) => r.id).join(', ')}.`);
    }
    const other = unbuilt.length - mine.length;
    if (other > 0) {
      lines.push(`- ${other} pieces elsewhere in the app are unfinished too — mention them ONLY if this piece genuinely depends on one of them.`);
    }
  } catch { /* an older database without the table yields no gap lines */ }
  if (!isSelf) {
    try {
      const ungrounded = db.prepare(`SELECT code FROM clusters WHERE COALESCE(grounding_status,'') <> 'grounded'`).all().map((c) => c.code);
      if (ungrounded.length) lines.push(`- Groups of material not yet checked against sources: ${ungrounded.join(', ')}.`);
      const untagged = db.prepare(`
        SELECT COUNT(*) n FROM entities e WHERE NOT EXISTS (SELECT 1 FROM entity_tags t WHERE t.entity_id = e.id)
      `).get()?.n || 0;
      if (untagged) lines.push(`- ${untagged} things in the material carry no archetypal tags at all.`);
    } catch { /* same */ }
  }
  return lines.join('\n') || '- (nothing counted as a gap right now)';
}

// Two blocks of context that cost nothing to assemble and change what this call is
// able to say: what has SHIPPED against this component since the last time we asked,
// and the suggestions we gave last time. Without them, regeneration re-derives from
// the same static facts and hands back the same three ideas — including ones the
// work has already satisfied, which is the "already done" complaint in its most
// visible form. Free: both are DB reads (shipFacts.js).
function shippedBlock(db, id, since) {
  if (!since) return '';
  const shipped = shippedSince(db, since, { componentId: id, limit: 8 });
  if (!shipped.length) return '';
  const lines = shipped.map((t) => {
    const files = (t.files || []).slice(0, 6).join(', ');
    return `- ${t.title}${files ? ` — changed: ${files}` : ''}`;
  });
  return `WHAT JUST SHIPPED HERE since your last suggestions:\n${lines.join('\n')}\n\n`;
}

function previousBlock(c) {
  let prev = [];
  try { prev = JSON.parse(c.suggestions_json || '[]'); } catch { prev = []; }
  if (!Array.isArray(prev) || !prev.length) return '';
  const lines = prev.slice(0, 3).map((p, i) => `${i + 1}. ${p.title || ''} — ${String(p.prompt || '').slice(0, 200)}`);
  return `THE SUGGESTIONS YOU GAVE LAST TIME:\n${lines.join('\n')}\n\n`;
}

export async function generateSuggestions(db, id) {
  const rows = getComponents(db);
  const c = rows.find((r) => r.id === id);
  if (!c) return { error: 'not_found' };

  // Read straight from the table: getComponents() shapes rows for the UI and does
  // not carry the raw suggestions_json / generated_at this needs.
  const stored = db.prepare(`SELECT suggestions_json, suggestions_generated_at FROM architecture_components WHERE id=?`).get(id) || {};
  const shipped = shippedBlock(db, id, stored.suggestions_generated_at);
  const previous = previousBlock(stored);
  const nextVersion = (c.evolution || []).find(([tag]) => {
    const currentTag = (c.evolution[0] || [])[0];
    return tag !== currentTag;
  });

  const prompt = [
    `You are suggesting concrete next steps for ONE piece of ${APP_BLURB}\n\n`,
    `The piece you are suggesting for: ${id}${SELF_COMPONENT_IDS.includes(id) ? ' — this one belongs to the app\'s own build system, not to the material it studies' : ''}\n`,
    `Current state (NOW): ${c.now_text || '(no live data)'}\n`,
    `Status: ${c.status || 'unknown'}\n`,
    `Next version on its evolution path: ${nextVersion ? nextVersion[0] + ' — ' + nextVersion[1] : '(none defined)'}\n\n`,
    `Gaps counted right now, narrowed to this piece's side of the app:\n${gapsFor(db, id)}\n\n`,
    shipped,
    previous,
    `${onSubjectRule(id)}\n\n`,
    // The accounting instruction only makes sense when there IS a last time to
    // account for — asking a first-ever call to review suggestions it never made
    // invites it to invent some.
    previous
      ? `Before proposing anything, account for each suggestion you gave last time: is it still open, already done (say so if what shipped above satisfies it), or now different? Then propose the NEXT rung — do not repeat a suggestion the shipped work has already satisfied.\n\n`
      : '',
    `Produce exactly 2 or 3 concrete, actionable suggestions for this specific component. `,
    `Each suggestion must already be phrased as a ready-to-execute task-queue prompt — an instruction an autonomous coding agent could act on directly, `,
    `not a vague description. Be specific: name the file/mechanism where you can infer it.\n\n`,
    `${USER_FACING_STYLE} (applies to the title the owner reads; the "prompt" field may stay technical for the coding agent)\n\n`,
    `Respond with ONLY a JSON array, no prose, no markdown fences, in this exact shape:\n`,
    `[{"title": "short label, under 8 words", "prompt": "the full ready-to-queue instruction"}]`,
  ].join('');

  const out = await generateText({ prompt, feature: 'build', maxTokens: 900, label: 'architecture:suggestions' });
  if (out.error) return { error: out.error, message: out.message };
  const text = out.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return { error: 'parse_error' };
  let suggestions;
  try { suggestions = JSON.parse(match[0]); } catch { return { error: 'parse_error' }; }
  suggestions = suggestions.slice(0, 3).map((s) => ({
    id: randomUUID(), title: String(s.title || '').slice(0, 120), prompt: String(s.prompt || ''),
  })).filter((s) => s.prompt);

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE architecture_components SET suggestions_json=?, suggestions_generated_at=?, updated_at=? WHERE id=?
  `).run(JSON.stringify(suggestions), now, now, id);
  return { suggestions, suggestions_generated_at: now };
}

// ─── Component-commit seeding (manual mapping, appended to over time) ──────────
export function seedComponentCommits(db, entries) {
  for (const e of entries) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO component_commits (id, component_id, sha, message, committed_at)
        VALUES (?,?,?,?,?)
      `).run(randomUUID(), e.component_id, e.sha, e.message, e.committed_at);
    } catch {}
  }
}
