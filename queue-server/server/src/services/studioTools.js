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
import { getComponents } from './architecture.js';
import { listNodes } from './architectureNodes.js';
import { listKnowledgeDocs, readKnowledgeDoc } from './knowledgeDocs.js';

export const STUDIO_TOOLS = [
  {
    name: 'search_entities',
    description: 'Search/filter the project\'s entities (characters, films, countries) by type, cluster, tag, name substring, or grounded status.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['character', 'film', 'country'] },
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
    description: 'List the reference documents held by the app — the full ontology doc, the films master list, the source archive that grounded the film analysis, and every note saved out of a conversation. Returns titles and descriptions only, not content.',
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

export function dispatchStudioTool(db, name, input) {
  const args = input || {};
  if (!db) return { error: 'no_db' };
  switch (name) {
    case 'search_entities': {
      const rows = q.searchEntities(db, args) || [];
      return {
        total: rows.length,
        showing: Math.min(rows.length, ENTITY_CAP),
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

Call a tool for anything specific rather than inferring it from this prompt. Never claim you looked something up when you did not.`;
