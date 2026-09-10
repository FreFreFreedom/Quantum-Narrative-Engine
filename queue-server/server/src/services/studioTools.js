// The lookup tools a conversation can actually call (plan
// "roaming-conversations-backend" §2).
//
// Two halves of one conversation:
//   - THE SUBJECT — the seven ontology/knowledge tools the drawer chat has had
//     since day one (services/chat.js), moved here so the unified conversation
//     engine can use them too. chat.js is left alone and keeps its own copies:
//     it is a different transport (the Anthropic Messages API via
//     anthropicLoop.js) and rewiring it buys nothing.
//   - THE APP ITSELF — three more, so "what should this app become" is a
//     question that can be answered from the real state of the build rather than
//     from the standing project map alone.
//
// Definitions are Anthropic-shaped (`input_schema`). That is the shape
// providers/openaiCompat.js already knows how to translate into OpenAI's
// `tools`/`tool_calls`, so the same list drives both lanes.
//
// Every dispatch here is READ-ONLY and every result is bounded. A tool result is
// re-sent with the next round's prompt, so an unbounded one is an unbounded bill:
// see the row caps below and toolResultCap in the callers.

import * as q from './ontologyQuery.js';
import * as rel from './entityRelations.js';
import { peersOf } from './peers.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getComponents } from './architecture.js';
import { listNodes } from './architectureNodes.js';
import { listKnowledgeDocs, readKnowledgeDoc } from './knowledgeDocs.js';
import { recallFacts } from './mind.js';

export const STUDIO_TOOLS = [
  {
    name: 'search_entities',
    description: 'Search/filter the project\'s entities by type, cluster, tag, name substring, or grounded status. Entity types include characters, films, countries, and — from the civic/justice corpus — institutions, families, cities and groups. A film is a MEDIUM (a record carrying testimony), not a thing that sits on the scale ladder; the institutions, families and cities it testifies about are the entities.',
    input_schema: {
      type: 'object',
      properties: {
        // Deliberately NOT an enum. It was ['character','film','country'] and that went
        // stale the moment institutions, families, cities and groups arrived — the Room
        // could not name them, so 35 entities were unreachable through this tool while
        // being perfectly visible in the app. A free string cannot go stale that way, and
        // the result of an unfiltered call names every type actually in use (see
        // `types_in_use` below), so the live list is discoverable rather than declared.
        type: { type: 'string', description: 'Entity type. Call with no arguments first if unsure — the result lists every type in use.' },
        cluster: { type: 'string', description: 'Cluster code, e.g. "I" or "II"' },
        tag: { type: 'string' },
        name: { type: 'string', description: 'Substring match on entity name' },
        grounded: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_entity',
    description: "Fetch one entity by id with full detail: tags, continuum scores, container entity (e.g. a character's film), and children (e.g. a film's characters).",
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_clusters',
    description: 'List the 12 hand-defined thematic FILM clusters (roman-numeral IDs) with their grounding status (grounded vs. reasoned). This is NOT the tag communities — for those, use list_theme_clusters / theme_cluster_for_tag.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_continuum_axes',
    description: 'List all Integration Continuum axes defined so far, with their two poles.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'nearby_on_axis',
    description: 'Find entities whose score on a given continuum axis is closest to a target value — useful for "what else scores like X".',
    input_schema: {
      type: 'object',
      properties: { axis_key: { type: 'string' }, value: { type: 'number' }, limit: { type: 'number' } },
      required: ['axis_key', 'value'],
    },
  },
  {
    name: 'list_knowledge_docs',
    description: 'List the reference documents held by the app — the full ontology doc, the films master list, the source archive that grounded the film analysis, the shared memory of every engine that has worked on this project (titled "Memory: ..."), and every note saved out of a conversation. Returns titles and descriptions only, not content.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_knowledge_doc',
    description: 'Read a reference document in full or a slice of it by title (from list_knowledge_docs). The source archive is very large — prefer offset/length to read a portion rather than the whole thing unless truly needed.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        offset: { type: 'number', description: 'Character offset to start from. Default 0.' },
        length: { type: 'number', description: 'Max characters to return. Default 12000.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_architecture_components',
    description: 'List the pieces this app is built out of, each with its current status and a one-line statement of where it stands today. Use this before proposing something the app may already do.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_tech_tree',
    description: 'Read the tech tree: the named things the app could become, built and speculative, with what each is, why it exists and what it depends on.',
    input_schema: {
      type: 'object',
      properties: { territory: { type: 'string', description: 'Optional territory filter.' } },
    },
  },
  {
    name: 'list_theme_clusters',
    description: 'List the theme clusters — communities of tags computed from which entities actually share them, NOT the 12 hand-defined film clusters (use list_clusters for those). Returns a bounded summary: each cluster\'s id, name, size and a few example tags. For the full tag list, siblings and entities of one cluster, call theme_cluster_for_tag with one of its tags.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'theme_cluster_for_tag',
    description: 'Given one tag, return the theme cluster (tag community, NOT a film cluster) it belongs to: the cluster\'s full tag list, its sibling tags, and the entities that carry any of them, heaviest sharers first. Answers "what else travels with this tag, and what carries it".',
    input_schema: {
      type: 'object',
      properties: { tag: { type: 'string' } },
      required: ['tag'],
    },
  },
  {
    name: 'list_recent_work',
    description: 'List recent items in the Dispatch Queue — what has been built lately, what is running and what is waiting. Optional status filter (queued/running/done/blocked/paused/cancelled).',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'integer' } },
    },
  },
  {
    name: 'recall_memory',
    description: "Recall a specific fact about the owner from his long-term memory — standing preferences, decisions and the reason behind them, people, constraints. Use this when a question depends on something he may have said before. The most relevant facts are already in the prompt; this reaches the longer tail of older or lower-ranked facts.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall, e.g. "preferred model" or "why we switched X"' },
        limit: { type: 'integer', description: 'Max facts to return. Default 5.' },
      },
      required: ['query'],
    },
  },
  // ─── The civic corpus: relations, loops, anatomies ───────────────────────
  // Everything above answers "what is in the corpus". These four answer "what has been
  // traced through it", which is a different kind of fact: a computed echo is a
  // resemblance the app noticed, a stored relation is a claim someone is answerable for.
  {
    name: 'get_relations',
    description: "Stored relations touching one entity — claims somebody made and wrote down, unlike the computed echoes in the graph. Each carries its move (vertical = a real path crossing exactly one rung of the scale ladder; horizontal = peers on the same rung; jump = structural kinship with no path traced), its direction and date, the source it came from, and a FALSIFIER: what observation would break the claim. Quote the falsifier when reporting one — it is what separates a claim that can lose from an assertion.",
    input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
  },
  {
    name: 'find_loops',
    description: "Loops: chains of vertical relations that leave a rung and return to it with time moving forward — a rule descending to the people it lands on, and their fracture returning as pressure for the next rule. `entity_id` means loops the entity PARTICIPATES IN, not loops that start at it; omit it for every loop in the corpus. A loop is a query over relations, never a stored object.",
    input_schema: { type: 'object', properties: { entity_id: { type: 'string' } } },
  },
  {
    name: 'shape_audit',
    description: "Which anatomies have been traced at which rungs of the scale ladder, as a grid of counts. THE EMPTY CELLS ARE THE POINT: a rung where a shape is certain to be operating and nobody has looked yet. Report the gaps before the coverage.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_anatomy',
    description: "One entity's interior, where it has been mapped: who interacts with whom inside it, how heavily, and whether each relation is opposition or alliance — plus whether the signed network is BALANCED (splits cleanly into two camps) and its FRUSTRATION (how many relations must break for the split to be clean). Parts are opaque codes with a separate name map; the structure is the evidence, the names are only for reading it out. Very few entities have one.",
    input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
  },
  {
    name: 'horizontal_peers',
    description: "The horizontal move: who else sits on this entity's rung of the scale ladder, and who is further along. Returns two orderings — `alongside` (most structurally alike first) and `furtherAlong` (biggest gap on a shared Integration Continuum axis first) — plus `difference`: what the peer furthest along holds that this one does not, as postures, shapes and tags. THE AXIS SCORE IS A HAND-ASSIGNED READING, NOT A MEASUREMENT: say so when you use it. 'Further along' means further toward integration on an axis a person scored — never that the peer is right. This is the move that answers 'who is doing this better, and what would we be importing'. A film has no peers; it is a medium and sits on no rung.",
    input_schema: { type: 'object', properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
  },
];

// Row caps. Each of these results is re-sent with every subsequent round, so a
// tool that returns "everything" is a tool that quietly multiplies the bill.
const ENTITY_CAP = 40;
const NODE_CAP = 80;
const WORK_CAP = 40;
const DOC_SLICE_CAP = 24000;
// list_theme_clusters is a summary of the WHOLE index (106 communities as of
// 2026-08-21) — every one, with just id/name/size/a few tags, would still risk
// clearing toolResultCap (8000 chars) and coming back truncated mid-JSON. Capped
// like the other list tools above, biggest communities first (the index is
// already ordered that way).
const CLUSTER_CAP = 40;
const CLUSTER_TAG_EXAMPLES = 4;
// The civic tools. Relations and loops are few today (14 and 2) and will not stay few;
// an anatomy is small per entity but every edge carries a sign tally, so it is capped by
// edges rather than by entities.
const RELATION_CAP = 40;
// Peers are the widest of these results — each row carries axes, postures, shapes and tags
// — and the individual rung holds 237 entities. Tighter than the rest, on purpose.
const PEER_TOOL_CAP = 8;
const LOOP_CAP = 20;
const ANATOMY_EDGE_CAP = 120;
const INTERIORS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data-seed/interiors');

function readNames(entityId) {
  const f = resolve(INTERIORS_DIR, entityId + '.names.json');
  if (!f.startsWith(INTERIORS_DIR) || !existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function dispatchStudioTool(db, name, input) {
  const args = input || {};
  if (!db) return { error: 'no_db' };
  switch (name) {
    case 'search_entities': {
      const rows = q.searchEntities(db, args) || [];
      return {
        total: rows.length,
        showing: Math.min(rows.length, ENTITY_CAP),
        // What the tool's description promises: an unfiltered call names every type that
        // exists right now. Computed, so a type added tomorrow appears without an edit
        // here — which is the mistake the removed enum made.
        ...(args.type ? {} : { types_in_use: q.listFacets(db).types.map((t) => `${t.value} (${t.n})`) }),
        entities: rows.slice(0, ENTITY_CAP).map((e) => ({
          id: e.id, name: e.name, type: e.type, scale: e.scale, clusters: e.clusters, grounded: e.grounded,
        })),
      };
    }
    case 'get_entity':
      return q.getEntity(db, args.id) || { error: 'not_found' };
    case 'list_clusters':
      return q.listClusters(db);
    case 'list_continuum_axes':
      return q.listContinuumAxes(db);
    case 'nearby_on_axis':
      return q.nearbyOnAxis(db, args.axis_key, args.value, Math.min(Number(args.limit) || 10, 25));
    case 'list_knowledge_docs':
      return listKnowledgeDocs(db);
    case 'read_knowledge_doc':
      return readKnowledgeDoc(db, args.title, Number(args.offset) || 0, Math.min(Number(args.length) || 12000, DOC_SLICE_CAP));
    case 'list_architecture_components':
      return getComponents(db).map((c) => ({
        id: c.id, status: c.status, now: c.now_text ? String(c.now_text).slice(0, 220) : null,
      })).slice(0, 200);
    case 'read_tech_tree': {
      const wanted = String(args.territory || '').trim().toLowerCase();
      return listNodes(db)
        .filter((n) => !wanted || String(n.territory || '').toLowerCase() === wanted)
        .slice(0, NODE_CAP)
        .map((n) => ({
          id: n.id, name: n.name, territory: n.territory, status: n.status,
          what: n.what ? String(n.what).slice(0, 300) : null,
          why: n.why ? String(n.why).slice(0, 300) : null,
          depends: n.depends || [],
          provenance: n.provenance || null,
        }));
    }
    case 'list_theme_clusters': {
      const idx = q.listTagCommunities();
      const communities = idx.communities || [];
      return {
        totalTags: idx.totalTags,
        totalCommunities: idx.totalCommunities,
        showing: Math.min(communities.length, CLUSTER_CAP),
        clusters: communities.slice(0, CLUSTER_CAP).map((c) => ({
          id: c.id, name: c.name, size: c.size, example_tags: c.tags.slice(0, CLUSTER_TAG_EXAMPLES),
        })),
      };
    }
    case 'theme_cluster_for_tag': {
      const tag = String(args.tag || '').trim();
      if (!tag) return { error: 'tag_required' };
      const result = q.tagCommunity(db, tag, ENTITY_CAP);
      if (!result) return { found: false, tag, message: 'No theme cluster for this tag — it does not exist, or shares no tags with any entity.' };
      return {
        found: true,
        tag: result.tag,
        community: { id: result.community.id, name: result.community.name, size: result.community.size },
        siblings: result.siblings,
        entityCount: result.entityCount,
        entities: result.entities,
      };
    }
    case 'list_recent_work': {
      const status = args.status ? String(args.status) : null;
      const limit = Math.min(Number(args.limit) || 25, WORK_CAP);
      return db.prepare(
        `SELECT id, title, status, mode, summary FROM work_prompts
          WHERE (:status IS NULL OR status = :status) AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT :limit`,
      ).all({ status, limit }).map((r) => ({
        ...r, summary: r.summary ? String(r.summary).slice(0, 220) : null,
      }));
    }
    case 'get_relations': {
      const rows = rel.relationsFor(db, args.entity_id) || [];
      return {
        total: rows.length,
        showing: Math.min(rows.length, RELATION_CAP),
        relations: rows.slice(0, RELATION_CAP).map((r) => ({
          other: r.role === 'from' ? r.to_name : r.from_name,
          other_id: r.role === 'from' ? r.to_id : r.from_id,
          other_rung: r.role === 'from' ? r.to_scale : r.from_scale,
          move: r.move,
          direction: r.direction,
          at: r.at,
          note: r.note,
          source_kind: r.source_kind,
          source: r.source_ref,
          falsifier: r.falsifier,
        })),
      };
    }
    case 'find_loops': {
      const loops = rel.findLoops(db, { entityId: args.entity_id || undefined }) || [];
      const name = (id) => {
        const row = db.prepare(`SELECT name FROM entities WHERE id=?`).get(id);
        return row ? row.name : id;
      };
      return {
        total: loops.length,
        showing: Math.min(loops.length, LOOP_CAP),
        loops: loops.slice(0, LOOP_CAP).map((l) => ({
          starts_at: name(l.entity),
          path: l.steps.map((st) => name(st.to)),
          span: l.span,
          dated_steps: l.datedSteps,
        })),
      };
    }
    case 'shape_audit':
      return rel.shapeByRungAudit(db);
    case 'get_anatomy': {
      // Read from the interiors written by the anatomy runs. Ids come from the corpus, so
      // they are not arbitrary strings — but this reads a path built from one, so anything
      // that could climb out of the directory is refused rather than sanitised.
      const id = String(args.entity_id || '');
      if (!/^[a-z0-9_]+$/i.test(id)) return { error: 'bad_entity_id' };
      const file = resolve(INTERIORS_DIR, id + '.graph.json');
      if (!file.startsWith(INTERIORS_DIR) || !existsSync(file)) {
        return { error: 'no_anatomy', message: 'This entity has no mapped interior. Very few do — say so rather than inferring one.' };
      }
      let doc;
      try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { return { error: 'unreadable_anatomy' }; }
      const b = doc.structuralBalance || {};
      return {
        entity: doc.entity,
        source: doc.source,
        scope: doc.scope,
        turns_attributed: doc.turnsAttributed,
        nodes: doc.graph?.nodes || [],
        edges: (doc.graph?.edges || []).slice(0, ANATOMY_EDGE_CAP),
        partition: doc.basePartition,
        balanced: b.balanced,
        frustration: b.frustration,
        camps: b.bestSplit,
        // The map out of codes into names. It is an exit for a human reading the answer —
        // never something to compare on, because a name has no interior to compare
        // (fractal_operational_core.md, the nameless interior).
        names: readNames(id),
        blur_survives: doc.blurB?.partition,
      };
    }
    case 'horizontal_peers': {
      const out = peersOf(db, args.entity_id, { limit: PEER_TOOL_CAP });
      if (!out) return { error: 'not_found' };
      if (out.rung === null) return { rung: null, reason: out.reason, alongside: [], furtherAlong: [] };
      // Trimmed hard: the full record carries every axis, every posture and every tag for
      // every peer, and this result is re-sent with each following round.
      const slim = (p) => ({
        name: p.name, id: p.id,
        axes: p.axes.map((a) => `${a.name}: ${a.mine} → ${a.theirs} (${a.delta > 0 ? '+' : ''}${a.delta}, ${a.direction})`),
        relations: `${p.relationProfile.total} stored (${p.relationProfile.down} down, ${p.relationProfile.up} up, ${p.relationProfile.horizontal} across, ${p.relationProfile.jump} jump)${p.relationProfile.inLoop ? ', in a loop' : ''}`,
        postures: p.postures.map((x) => x.name),
        sharedShapes: p.sharedShapes,
        sharedTags: p.sharedTags,
      });
      return {
        of: out.of.name,
        rung: out.rung,
        peerCount: out.peerCount,
        alongside: out.alongside.slice(0, PEER_TOOL_CAP).map(slim),
        furtherAlong: out.furtherAlong.slice(0, PEER_TOOL_CAP).map(slim),
        difference: out.difference,
      };
    }
    case 'recall_memory': {
      const query = String(args.query || '').trim();
      if (!query) return { error: 'query_required' };
      return { facts: recallFacts(query, Math.min(Number(args.limit) || 5, 20)) };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// The paragraph the system prompt uses to tell the model what it can look up.
// Kept beside the tool list on purpose: a prompt that promises a tool that was
// since renamed is worse than one that promises nothing (that is exactly why the
// old "can look things up" line had to be deleted).
export const TOOLS_PROMPT_BLOCK = `You have read-only lookup tools and you should USE them rather than guessing. They cover two things:

The project's content — search its entities (characters, films, countries are one kind of object at different scales), open one in full with its tags and continuum scores, list the 12 hand-defined film clusters, list the Integration Continuum axes, find what else scores near a given value on an axis, and list or read the reference documents in full (the ontology doc, the films master list, the source archive, and every note saved out of an earlier conversation). Separately, there are theme clusters — communities of tags computed from which entities actually share them, a different thing from the film clusters above: list them as a bounded summary, or give one tag to get its full cluster, sibling tags and the entities carrying them.

The app itself — list the pieces it is built from and where each stands, read the tech tree of what it could become, and list recent work in its queue.

What has been traced through the corpus — a separate kind of fact from what is in it. Entities sit on an ordered scale ladder (cell, individual, family, group, institution, city, nation, civilisation, planetary, cosmos); a film is a MEDIUM carrying testimony and sits on no rung, while the institutions, families and cities it testifies about are the entities. A policy is not a thing of its own: it is a dated POSTURE an institution holds, in that entity's detail. Beyond the computed echoes there are STORED RELATIONS — claims somebody made, each with a source and a falsifier — and LOOPS, which are chains of those that leave a rung and return to it with time moving forward. A few entities have a mapped INTERIOR: who interacts with whom inside them, signed opposition or alliance, and whether that splits cleanly into two camps. Ask the shape audit which rungs have never been looked at; the empty cells are the useful part.

The third navigation move is now askable too: horizontal_peers gives the entities on the same rung as one you are looking at, ordered both by how alike they are and by who sits further toward integration, with a plain difference for the one furthest along. Its scores are hand-assigned readings rather than measurements, so report them as somebody's judgement and never as a fact about the world.

When you report a stored relation, quote its falsifier — the claim is only worth as much as the thing that could break it. When you report an interior, the parts are codes with a separate name map: the structure is the evidence and the names are only for reading it out.

Call a tool for anything specific rather than inferring it from this prompt. Never claim you looked something up when you did not.`;
