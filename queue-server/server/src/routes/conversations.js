// Idea Studio conversation routes — mounted at /api/convos (plan
// "universal-conversations-core-architecture"). Backed by services/conversations.js
// and the subject registry in services/subjectContext.js.
import { Router } from 'express';
import { isKnownProvider } from '../services/ai/providers.js';
import * as convos from '../services/conversations.js';
import * as shelf from '../services/bookShelf.js';
import * as screen from '../services/screenFacts.js';
import { bookContents } from '../services/bookContents.js';
import { workNote } from '../services/workNotes.js';
import * as bookFacts from '../services/bookFacts.js';
import * as analogies from '../services/roomAnalogies.js';
import * as board from '../services/board.js';
import { rhymeSoon } from '../services/boardRhyme.js';
import { proposeRemember, saveRemembered } from '../services/mind.js';
import { listChapters, chapterize, recaseChapters } from '../services/chapters.js';
import * as docExtraction from '../services/docExtraction.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import * as interests from '../services/interestLibrary.js';
import { lookupWord, glossaryFor } from '../services/wordLookup.js';

// The lanes the manual model picker (plan "chat-model-picker") may point a
// conversation at. Kept in sync by hand with turnRouter.js's FORCED_LANES and
// the frontend's picker options — a short, deliberately-curated list, not the
// full provider catalogue.
// 'openai' is the one metered lane here (gpt-4.1, the Idea Studio's own model).
// It was reachable only as Auto, which meant pinning any other lane was a one-way
// door — added at Antoine's ask, 2026-09-09. The monthly cap in ai/text.js still
// governs the spend; this only decides what may be asked for.
// Any lane the router actually knows — the three named ones plus every provider
// in the free catalogue, so a key added to the environment becomes pickable in
// the Room without editing a list here. isKnownProvider is the same check
// ai/text.js uses when it resolves a lane, so nothing can be pinned that the
// generator would then refuse.
const FIXED_LANE_PROVIDERS = new Set(['claude-code', 'claude-side', 'opencode']);
const VALID_LANE_PROVIDERS = { has: (id) => FIXED_LANE_PROVIDERS.has(id) || isKnownProvider(id) };

function isConvoError(out) {
  return out && typeof out === 'object' && out.error && !out.ok;
}

function statusFor(err) {
  if (err === 'not_found' || err === 'not_exist' || err === 'no_plan' || err === 'not_attached') return 404;
  if (err === 'unknown_subject_type' || err === 'empty' || err === 'too_many_subjects'
      || err === 'cannot_detach_primary' || err === 'cannot_attach_open' || err === 'text_required' || err === 'no_such_message' || err === 'no_title'
      || err === 'invalid_kind' || err === 'invalid_mode' || err === 'images_too_large' || err === 'invalid_images'
      || err === 'cannot_link_self' || err === 'too_many_links' || err === 'link_cycle'
      || err === 'immutable_origin' || err === 'invalid_merge_count' || err === 'source_unavailable'
      || err === 'not_a_merge') return 400;
  return 500;
}

export function conversationsRoutes() {
  const router = Router();

  const interestRoute = fn => (req, res) => {
    try {
      const owner = req.user?.sub || req.user?.id;
      if (!owner) return res.status(401).json({ error: 'Sign in first.' });
      res.json(fn(req, owner));
    } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not update the interest library.' }); }
  };
  router.get('/interests', interestRoute((req, owner) => ({ items: interests.listInterests(owner, req.query) })));
  router.get('/interest-review', interestRoute((req, owner) => ({ entries: interests.pendingInterestReview(owner) })));
  router.get('/interest-imports/:batchId/image', interestRoute((req, owner) => interests.importImage(owner,req.params.batchId)));
  router.patch('/interests/:itemId', interestRoute((req, owner) => interests.changeInterest(owner, req.params.itemId, req.body || {})));
  router.delete('/interests/:itemId', interestRoute((req, owner) => interests.changeInterest(owner, req.params.itemId, {}, true)));
  router.post('/interest-entries/:entryId', interestRoute((req, owner) => interests.resolveInterestEntry(owner, req.params.entryId, req.body || {})));
  router.post('/interest-imports/:batchId/:action', interestRoute((req, owner) => interests.changeImport(owner, req.params.batchId, req.params.action)));
  router.get('/:id/interest-imports', interestRoute((req, owner) => ({ batches: interests.importStatus(owner, req.params.id) })));
  router.post('/:id/interest-imports', interestRoute((req, owner) => interests.createInterestImport(owner, req.params.id, req.body || {})));

  // GET /api/convos/subject/:type/:id — fetch (or create) the conversation for a
  // subject, plus its message history.
  router.get('/subject/:type/:id', (req, res) => {
    const { type, id } = req.params;
    const out = convos.getOrCreateConvo({
      subjectType: type,
      subjectId: id,
      subjectHint: req.query.hint || null,
      createdBy: req.user?.id || 'antoine',
    });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    // `acts` tells the studio which of fold / more / reframe this subject can
    // actually do, so it never offers a button that would only apologise.
    res.json({
      convo: out.convo,
      chat_override: convos.getChatLane(out.convo.id),
      messages: convos.listMessages(out.convo.id),
      created: out.created,
      acts: convos.writeActsForConvo(out.convo.id),
      edits: convos.convoSubjectEdits(out.convo.id),
      subjects: convos.listConvoSubjects(out.convo.id),
      marks: convos.listMarks(out.convo.id),
    });
  });

  // ─── Roaming conversations (plan "roaming-conversations-backend") ──────────
  // Declared before /:id so "open" is not captured as an id.

  // GET /api/convos/open — the roaming threads, newest activity first.
  router.get('/open', (req, res) => {
    res.json({ convos: convos.listOpenConvos(req.query.limit) });
  });

  // GET /api/convos/plans — the plan backlog mirrored into the knowledge store,
  // as a light list ({id, title, status}) for the Room's attach picker. Titles
  // and statuses only; the picker must not download 400-line plans to draw a list.
  router.get('/plans', (req, res) => {
    res.json({ plans: convos.listPlans() });
  });

  // GET /api/convos/files — the file backlog mirrored into the knowledge store,
  // as a light list ({id, title, status}) for the Room's attach picker. Titles
  // and statuses only; the picker must not download the full document to draw a list.
  router.get('/files', (req, res) => {
    res.json({ files: convos.listFiles() });
  });

  // ─── Films and series: what the Library knows about them ───────────────────
  // One call for the whole wall (poster, rating, votes, synopsis, whether it came
  // out of a book), cached per title; the relevance line is its own call because
  // it costs a model and is written only when he opens the panel.
  router.get('/screen', asyncHandler(async (req, res) => {
    const owner = req.user?.id || 'antoine';
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
    const items = convos.mediaItemsByIds(owner, ids);
    const [onScreen, inPrint] = await Promise.all([
      screen.screenFactsFor(owner, items.filter((i) => i.kind !== 'book')),
      bookFacts.bookFactsFor(owner, items.filter((i) => i.kind === 'book')),
    ]);
    res.json({ facts: { ...onScreen, ...inPrint } });
  }));

  // Where a margin cover should go: the book's own Amazon page (its ISBN) or the
  // film's own IMDb page (its tconst). Same cached facts the Library uses.
  router.get('/outlink', asyncHandler(async (req, res) => {
    const owner = req.user?.id || 'antoine';
    const it = { id: 'x', kind: String(req.query.kind || 'book'), title: String(req.query.title || '').slice(0, 300),
      creator: String(req.query.creator || '').slice(0, 200), year: String(req.query.year || '').slice(0, 8) };
    if (!it.title.trim()) return res.status(400).json({ error: 'title required' });
    if (it.kind === 'book') { const f = (await bookFacts.bookFactsFor(owner, [it])).x || {}; return res.json({ isbn: f.isbn || '', cover: f.poster || '' }); }
    const f = (await screen.screenFactsFor(owner, [it])).x || {};
    res.json({ imdbId: f.imdbId || '', cover: f.poster || '' });
  }));

  // The film/book card in a Room answer: the catalogue facts plus a 75-word line
  // on the work written for this conversation (services/workNotes.js).
  router.get('/:id/work-card', asyncHandler(async (req, res) => {
    const owner = req.user?.id || 'antoine';
    const it = { id: 'x', kind: String(req.query.kind || 'film'), title: String(req.query.title || '').slice(0, 300),
      creator: String(req.query.creator || '').slice(0, 200), year: String(req.query.year || '').slice(0, 8) };
    if (!it.title.trim()) return res.status(400).json({ error: 'title required' });
    const facts = it.kind === 'book'
      ? (await bookFacts.bookFactsFor(owner, [it])).x || {}
      : (await screen.screenFactsFor(owner, [it])).x || {};
    const note = await workNote(req.params.id, { ...it, year: facts.year || it.year, overview: facts.overview || '' }, { refresh: req.query.refresh === '1' });
    res.json({ ...facts, note: note.text });
  }));

  // A book's table of contents, from the catalogues in turn (services/bookContents.js).
  router.get('/contents', asyncHandler(async (req, res) => {
    const title = String(req.query.title || '').slice(0, 300);
    if (!title.trim()) return res.status(400).json({ error: 'title required' });
    res.json(await bookContents(title, String(req.query.author || '').slice(0, 200),
      { isbn: String(req.query.isbn || '').slice(0, 20), refresh: req.query.refresh === '1' }));
  }));

  router.get('/screen/:id/notes', asyncHandler(async (req, res) => {
    const owner = req.user?.id || 'antoine';
    const item = convos.mediaItemsByIds(owner, [req.params.id])[0];
    if (!item) return res.status(404).json({ error: 'not_found' });
    const refresh = req.query.refresh === '1';
    if (item.kind === 'book') {
      const facts = await bookFacts.bookFactsFor(owner, [item]);
      const out = await bookFacts.bookRelevance(owner, item, { refresh });
      return res.json({ ...(facts[item.id] || {}), ...out });
    }
    const facts = await screen.screenFactsFor(owner, [item]);
    const out = await screen.screenRelevance(owner, item, { refresh });
    res.json({ ...(facts[item.id] || {}), ...out });
  }));

  // ─── The shelf: whole books, available in every conversation ───────────────
  // Books are not per-conversation attachments (see services/bookShelf.js) — a
  // book put here is quotable from any thread, so these routes hang off the
  // owner, not off a convo id. The browser extracts the PDF's text and page
  // offsets before posting, exactly as it does for a file: no raw bytes ever
  // reach the server or the prompt.
  router.get('/books', (req, res) => {
    res.json({ books: shelf.listBooks(req.user?.id || 'antoine') });
  });

  router.post('/books', (req, res) => {
    const { title, author, year, filename, text, pages, sha, fromFile, cover } = req.body || {};
    const out = shelf.addBook(req.user?.id || 'antoine', { title, author, year, filename, text, pages, sha, fromFile, cover });
    if (out.error) return res.status(out.error === 'no_db' ? 500 : 400).json({ ...out, error: out.message || out.error });
    res.json(out);
  });

  // A passage lookup he can run himself, the same one the model's search_book uses.
  router.get('/books/search', (req, res) => {
    res.json(shelf.searchShelf(req.user?.id || 'antoine', {
      query: String(req.query.query || ''), book: String(req.query.book || ''), limit: req.query.limit,
    }));
  });

  // One book's own panel: length, when it arrived, the passages kept from it,
  // how many conversations have named it.
  router.get('/books/:id', (req, res) => {
    const out = shelf.bookDetail(req.user?.id || 'antoine', req.params.id);
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // The two summaries — the publisher's, and what the book is doing here. The
  // second is one cheap model call, written once and then stored; ?refresh=1
  // rewrites it, which is his call and never automatic.
  router.get('/books/:id/notes', asyncHandler(async (req, res) => {
    const out = await shelf.bookNotes(req.user?.id || 'antoine', req.params.id, { refresh: req.query.refresh === '1' });
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  router.patch('/books/:id', (req, res) => {
    const out = shelf.updateBook(req.user?.id || 'antoine', req.params.id, req.body || {});
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.delete('/books/:id', (req, res) => {
    const out = shelf.removeBook(req.user?.id || 'antoine', req.params.id);
    if (out.error) return res.status(statusFor(out.error)).json({ ...out, error: 'That book is not on the shelf.' });
    res.json(out);
  });

  // GET /api/convos/notes — the notes saved with /note, mirrored into the
  // knowledge store under the `Note: ` prefix, as a light list ({id, title,
  // description}) for the Room's attach picker.
  // ?full=1 adds each note's body. That is how the Mac runner reads them to write
  // the repo mirror (the container cannot: no git binary), and it is also the only
  // way to read a note's text over HTTP at all — readKnowledgeDoc has never had a
  // route of its own.
  router.get('/notes', (req, res) => {
    res.json({ notes: convos.listNotes({ full: req.query.full === '1' }) });
  });

  // GET /api/convos/transcripts — full transcripts of open conversations, for the
  // repo mirror. One call returns all threads (no N+1), already filtered by the
  // junk rule (>=3 user messages). Returns newest first.
  router.get('/transcripts', (req, res) => {
    const openConvos = convos.listOpenConvos();
    const filtered = openConvos
      .map((c) => {
        const messages = convos.listMessages(c.id);
        const userCount = messages.filter((m) => m.role === 'user').length;
        if (userCount < 3) return null;
        return {
          id: c.id,
          title: c.title,
          created_at: c.created_at,
          updated_at: c.updated_at,
          turns: c.turns,
          messages: messages.map((m) => ({ role: m.role, content: m.text, created_at: m.created_at })),
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    res.json({ convos: filtered });
  });

  // POST /api/convos/open — start one. No subject to pick: it gets a synthetic
  // one, and cards are attached afterwards (or never).
  router.post('/open', (req, res) => {
    const out = convos.createOpenConvo({
      title: req.body?.title || null,
      createdBy: req.user?.id || 'antoine',
    });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json({ convo: out.convo, messages: [], created: true, acts: convos.writeActsForConvo(out.convo.id), edits: [], subjects: convos.listConvoSubjects(out.convo.id) });
  });

  // POST /api/convos/merge — a new Room thread descended from two to six
  // conversations. Sources are captured, never altered or concatenated.
  router.post('/merge', asyncHandler(async (req, res) => {
    const out = await convos.mergeConversations(req.body?.source_ids, { createdBy: req.user?.id || 'antoine' });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // GET /api/convos/for?type=arch_component&ids=a,b,c — which of these subjects
  // already have a conversation (for the ✨/💬 markers in the "Not built" list).
  // Declared before /:id so "for" is not captured as an id.
  router.get('/for', (req, res) => {
    const type = String(req.query.type || '');
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    if (!type || !ids.length) return res.json({ convos: {} });
    res.json({ convos: convos.listConvosForSubjects(type, ids) });
  });

  // GET /api/convos/:id — fetch a specific conversation + its messages.
  router.get('/:id', (req, res) => {
    const convo = convos.getConvo(req.params.id);
    if (!convo) return res.status(404).json({ error: 'not_found' });
    // chat_override rides on the row as a raw JSON string (or null) — parsed here
    // into { provider, model, account, tag } so the frontend never re-implements
    // the parse, same shape as GET/POST /:id/lane below.
    res.json({ convo, chat_override: convos.getChatLane(convo.id), messages: convos.listMessages(convo.id), acts: convos.writeActsForConvo(convo.id), edits: convos.convoSubjectEdits(convo.id), subjects: convos.listConvoSubjects(convo.id), marks: convos.listMarks(convo.id) });
  });

  // ─── Analogies beside the Room (plan "the analogy engine in the Room") ─────
  // The side pane is its own small conversation: arrivals land here unasked, he
  // can ask for another kind, and he carries what he wants into the Room himself.
  // Nothing here ever writes into the main thread — "bring" is a frontend move
  // that loads the composer.

  router.get('/:id/analogies', (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json(analogies.listAnalogies(req.params.id));
  });

  // His own question into the side pane. A durable request is created and
  // answered right away with 202 — the actual generation runs in the background
  // in batches, so the ask box stays usable and a second ask can queue behind it.
  router.post('/:id/analogies/ask', (req, res) => {
    const out = analogies.askAnalogies(req.params.id, req.body?.text);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.status(202).json(out);
  });

  router.post('/:id/analogies/requests/:requestId/resume', (req, res) => {
    const out = analogies.resumeRequest(req.params.id, req.params.requestId);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.post('/:id/analogies/requests/:requestId/cancel', (req, res) => {
    const out = analogies.cancelRequest(req.params.id, req.params.requestId);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.patch('/:id/analogies/steer', (req, res) => {
    const out = analogies.setSteer(req.params.id, req.body || {});
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json({ steer: out });
  });

  // Replace one card in place with a freshly generated one — waits on the model,
  // same as ask above.
  router.post('/:id/analogies/:messageId/regenerate', asyncHandler(async (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const out = await analogies.regenerateAnalogy(req.params.id, req.params.messageId);
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json({ ...out, ...analogies.listAnalogies(req.params.id) });
  }));

  router.delete('/:id/analogies/:messageId', (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const out = analogies.forgetAnalogy(req.params.id, req.params.messageId);
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.delete('/:id/analogies', (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json(analogies.clearAnalogies(req.params.id));
  });

  // ─── The board (plan "room-mood-board") ────────────────────────────────────
  // GET .../wall is the flowing images — searched, shown, forgotten. GET/POST/
  // PATCH/DELETE .../board is what he kept. Keeping is one tap: nothing is ever
  // asked, the automatic "why" is filled in afterwards by boardRhyme.js.

  router.get('/:id/wall', asyncHandler(async (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const out = await board.wallFor(req.params.id, { force: req.query.force === '1' });
    if (out.error) return res.status(500).json(out);
    res.json(out);
  }));

  router.get('/:id/board', (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json({ cards: board.listBoard(req.params.id) });
  });

  router.post('/:id/board', (req, res) => {
    const out = board.keepCard(req.params.id, {
      kind: req.body?.kind,
      payload: req.body?.payload || null,
      sourceMessageId: req.body?.sourceMessageId || null,
      passage: req.body?.passage || null,
    });
    if (out.error) return res.status(statusFor(out.error)).json(out);
    rhymeSoon(out.card.id);
    res.json(out);
  });

  router.patch('/:id/board/:cardId', (req, res) => {
    const out = board.updateCard(req.params.cardId, {
      col: req.body?.col, pos: req.body?.pos, note: req.body?.note,
    });
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.delete('/:id/board/:cardId', (req, res) => {
    const out = board.deleteCard(req.params.cardId);
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // ─── Side talks (plan "side talks in the Room, and remember this") ─────────
  // A tangent without polluting the main thread — its own small conversation in
  // the pane, on Gemini, seeing the whole parent conversation. "↑ bring" (a
  // frontend move, same as analogies' above) is how anything reaches the main
  // composer; nothing here ever writes into the main thread itself.

  router.get('/:id/sides', (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json({ sides: convos.listSideTalks(req.params.id) });
  });

  // POST /api/convos/:id/sides — body: { mode: 'empty'|'fork', throughMessageId?,
  // title?, text?, quotes?, body? }. 'empty' opens a fresh aside — if `text` is
  // given (the from-quotes door), it is sent as the aside's first message,
  // `quotes`/`body` riding through unchanged to sendMessage. 'fork' branches the
  // parent thread itself into the pane instead of the thread list.
  router.post('/:id/sides', asyncHandler(async (req, res) => {
    const parentId = req.params.id;
    if (!convos.getConvo(parentId)) return res.status(404).json({ error: 'not_found' });
    const createdBy = req.user?.id || 'antoine';
    const mode = req.body?.mode === 'fork' ? 'fork' : 'empty';

    const out = mode === 'fork'
      ? convos.forkConvo(parentId, {
          throughMessageId: req.body?.throughMessageId || null,
          title: req.body?.title || null,
          createdBy,
          toSide: true,
        })
      : convos.createSideTalk(parentId, { title: req.body?.title || null, createdBy });
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);

    const text = String(req.body?.text || '').trim();
    if (mode === 'empty' && text) {
      const sent = await convos.sendMessage(out.convo.id, {
        text, userId: req.user?.id, quotes: req.body?.quotes || null, body: req.body?.body || null,
      });
      return res.json({ ...out, sent });
    }
    res.json(out);
  }));

  // POST /api/convos/sides/backfill-titles — one-time fix for side talks
  // started before smart titles covered them (plan "fix the Aside / side-talk
  // flow"). Mirrors /api/travaux/suggestions/classify: waits for the answer,
  // reports how many rows changed, no polling needed. Safe to run more than
  // once — a side talk already titled is not touched again.
  router.post('/sides/backfill-titles', asyncHandler(async (req, res) => {
    const out = await convos.backfillSideTitles();
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // POST /api/convos/:id/remember — body: { passage, messageId?, ownerNote?, central?, destination? }.
  // One call, from the capture card's single Save action: proposes the memory
  // from the passage + his note, then saves it. Where it lands (Memory vs Core
  // paradigm) is always his choice, made before this fires — Core is his direct
  // instruction to publish, no second approval screen after this.
  router.post('/:id/remember', asyncHandler(async (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const passage = String(req.body?.passage || '').trim();
    if (!passage) return res.status(400).json({ error: 'empty' });
    const ownerNote = req.body?.ownerNote || null;
    const central = !!req.body?.central;
    const destination = req.body?.destination === 'core' ? 'core' : 'memory';
    const proposed = await proposeRemember({
      sourceType: 'passage', text: passage, convoId: req.params.id, messageId: req.body?.messageId || null,
      ownerNote, central, destination,
    });
    if (proposed.error) return res.status(proposed.error === 'empty' ? 400 : 500).json(proposed);
    const out = saveRemembered({
      sourceType: 'passage', sourceText: passage, convoId: req.params.id, ownerNote, central,
      destination, kind: proposed.kind, text: proposed.text, detail: proposed.detail,
    });
    if (out.error) return res.status(out.error === 'duplicate' ? 409 : 400).json(out);
    res.json(out);
  }));

  // POST /api/convos/:id/define — the word selected, read in its sentence, for him.
  router.post('/:id/define', asyncHandler(async (req, res) => {
    const out = await lookupWord(req.params.id, { word: req.body?.word, sentence: req.body?.sentence, messageId: req.body?.messageId || null });
    if (out.error) return res.status(out.error === 'not_found' ? 404 : out.error === 'not_a_word' ? 400 : 500).json(out);
    res.json(out);
  }));

  // GET /api/convos/:id/glossary/:messageId — one answer's words, read ahead of time.
  router.get('/:id/glossary/:messageId', asyncHandler(async (req, res) => {
    const out = await glossaryFor(req.params.id, req.params.messageId);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 500).json(out);
    res.json(out);
  }));

  // POST /api/convos/:id/lane — the manual model picker's sticky pick (plan
  // "chat-model-picker"): body { provider, model?, account? }, or {} / provider:
  // null to clear back to Auto. Every message on this conversation runs on this
  // lane until it is cleared.
  router.post('/:id/lane', (req, res) => {
    const convo = convos.getConvo(req.params.id);
    if (!convo) return res.status(404).json({ error: 'not_found' });
    const provider = req.body?.provider || null;
    if (provider && !VALID_LANE_PROVIDERS.has(provider)) return res.status(400).json({ error: 'unknown_provider' });
    const lane = convos.setChatLane(req.params.id, provider ? { provider, model: req.body?.model || null, account: req.body?.account || null, effort: req.body?.effort || null } : null);
    res.json({ chat_override: lane });
  });

  // POST /api/convos/:id/stop — the Stop button, sent just before the browser drops
  // the streaming request. Without it a dropped connection and a deliberate stop are
  // the same event, and the app has to guess (it used to guess "cancel", and lost
  // finished answers).
  router.post('/:id/stop', (req, res) => {
    res.json(convos.markTurnCancelled(req.params.id));
  });

  // POST /api/convos/:id/clarification-mode — body: { mode: 'normal'|'interview' }.
  // The Interview switch in the composer, and the narrow natural-language start/
  // end phrases in sendMessage, both land here (or its sibling /answer-now).
  router.post('/:id/clarification-mode', (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'normal' && mode !== 'interview') return res.status(400).json({ error: 'invalid_mode' });
    const out = convos.setClarificationMode(req.params.id, mode);
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/answer-now — Antoine's explicit "enough material,
  // answer now" during Interview mode. Same NDJSON/plain-JSON split as
  // /:id/message, since the composer streams this exactly like an ordinary turn.
  router.post('/:id/answer-now', asyncHandler(async (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const wantsStream = /application\/x-ndjson/i.test(String(req.headers.accept || ''));

    if (!wantsStream) {
      const out = await convos.answerNow(req.params.id, {});
      if (out.error) return res.status(statusFor(out.error)).json(out);
      return res.json(out);
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); } catch {} };
    const cancel = new AbortController();
    const clientGone = () => cancel.signal.aborted;
    // Only an explicit Stop cancels. A connection that simply closed (a proxy
    // giving up on a long stream) lets the turn run to its end and save, so the
    // answer is there when the Room asks for it. See markTurnCancelled().
    res.on('close', () => {
      if (!res.writableFinished && convos.turnCancelledRecently(req.params.id)) cancel.abort();
    });

    try {
      const out = await convos.answerNow(req.params.id, {
        signal: cancel.signal,
        onToken: (t) => { if (!clientGone()) write({ type: 'token', text: t }); },
        onStatus: (m) => { if (!clientGone()) write({ type: 'status', text: String(m || '') }); },
      });
      write({ type: 'done', ...out });
    } catch (e) {
      write({ type: 'error', error: 'answer_now_failed', message: e.message });
    }
    res.end();
  }));

  // GET /api/convos/:id/subjects — every card attached to this conversation,
  // primary first.
  router.get('/:id/subjects', (req, res) => {
    const convo = convos.getConvo(req.params.id);
    if (!convo) return res.status(404).json({ error: 'not_found' });
    res.json({
      subjects: convos.listConvoSubjects(convo.id), max: convos.MAX_ATTACHED_SUBJECTS,
      links: convos.listConvoLinks(convo.id), max_links: convos.MAX_CONVO_LINKS,
      merge_bridge_ready: convos.mergeBridgeReady(convo.id),
    });
  });

  // Conversations are first-class Room attachments, but unlike card subjects
  // they are frozen snapshots with their own lineage rules.
  router.get('/:id/link-sources', (req, res) => {
    if (!convos.getConvo(req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json({ convos: convos.listLinkSources(req.params.id) });
  });

  router.post('/:id/links', (req, res) => {
    const out = convos.attachConvoReference(req.params.id, req.body?.source_id);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.post('/:id/links/:linkId/refresh', (req, res) => {
    const out = convos.refreshConvoReference(req.params.id, req.params.linkId);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.delete('/:id/links/:linkId', (req, res) => {
    const out = convos.detachConvoReference(req.params.id, req.params.linkId);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.post('/:id/merge-bridge', asyncHandler(async (req, res) => {
    const out = await convos.retryMergeBridge(req.params.id);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // POST /api/convos/:id/subjects — attach a card. Capped; every attached card
  // is re-sent on every turn, so the cap is a cost control, not tidiness.
  router.post('/:id/subjects', (req, res) => {
    const out = convos.attachSubject(req.params.id, {
      subjectType: req.body?.type,
      subjectId: req.body?.id,
      subjectHint: req.body?.hint || null,
    });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // DELETE /api/convos/:id/subjects/:type/:subjectId — take one off. The card the
  // conversation started from cannot be removed; it is the conversation's identity.
  router.delete('/:id/subjects/:type/:subjectId', (req, res) => {
    const out = convos.detachSubject(req.params.id, req.params.type, req.params.subjectId);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    // Detaching a file must stop its background reading immediately — see
    // plans/cancel-extraction-on-detach.md.
    if (req.params.type === 'file') {
      docExtraction.cancelExtraction({ convoId: req.params.id, knowledgeDocTitle: 'File: ' + req.params.subjectId });
    }
    res.json(out);
  });

  // POST /api/convos/:id/rename — a roaming thread earns its name as it goes.
  router.post('/:id/rename', (req, res) => {
    const out = convos.renameConvo(req.params.id, req.body?.title);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/star — keep a thread above the date groups, or let it go.
  router.post('/:id/star', (req, res) => {
    const out = convos.setConvoStar(req.params.id, !!req.body?.starred);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/message — one user turn (or a command like /plan, /handoff).
  //
  // Two response shapes from one endpoint:
  //   Accept: application/x-ndjson  → chunked, one JSON object per line, tokens
  //                                    forwarded as they arrive
  //   anything else                 → the original single res.json(), unchanged
  //
  // NDJSON rather than SSE because EventSource cannot send an Authorization
  // header, and everything in this app authenticates with a bearer token. It also
  // needs no new endpoint and no new client library — plain fetch() can read a
  // chunked body.
  router.post('/:id/message', asyncHandler(async (req, res) => {
    const wantsStream = /application\/x-ndjson/i.test(String(req.headers.accept || ''));
    // An explicit one-off override in the request body (the picker changing lane
    // right before this send) takes effect immediately, same call, no separate
    // /lane round trip required first. Omitting it entirely means "use whatever
    // this conversation is stickily pinned to" (see sendMessage's effectiveOverride).
    const bodyOverride = req.body?.override;
    const override = bodyOverride === undefined
      ? undefined
      : (bodyOverride?.provider && VALID_LANE_PROVIDERS.has(bodyOverride.provider)
        ? { provider: bodyOverride.provider, model: bodyOverride.model || null, account: bodyOverride.account || null, effort: bodyOverride.effort || null }
        : null);

    if (!wantsStream) {
      const out = await convos.sendMessage(req.params.id, { text: req.body?.text, userId: req.user?.id, override, quotes: req.body?.quotes, body: req.body?.body, images: req.body?.images, attachments: req.body?.attachments });
      if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
      return res.json(out);
    }

    // Once the first byte is written the status code is committed and res.json()
    // is no longer available — so from here every outcome, errors included,
    // travels as a line in the body.
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // ask any proxy in front not to buffer
    res.flushHeaders?.();

    const write = (obj) => {
      try { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); } catch {}
    };

    // If the reader hangs up before the answer is written, the turn is cancelled:
    // the Room's stop button (and only that — a finished response also fires
    // 'close', harmlessly) cuts the request, and conversations.js then drops the
    // question instead of saving an answer nobody waited for.
    const cancel = new AbortController();
    const clientGone = () => cancel.signal.aborted;
    // Only an explicit Stop cancels. A connection that simply closed (a proxy
    // giving up on a long stream) lets the turn run to its end and save, so the
    // answer is there when the Room asks for it. See markTurnCancelled().
    res.on('close', () => {
      if (!res.writableFinished && convos.turnCancelledRecently(req.params.id)) cancel.abort();
    });

    try {
      const out = await convos.sendMessage(req.params.id, {
        text: req.body?.text,
        userId: req.user?.id,
        override,
        // Carried passages, kept apart from the words he typed: the model still
        // gets them inside `text`, but the screen draws them as a folded line
        // above his message instead of repeating them inside it.
        quotes: req.body?.quotes,
        body: req.body?.body,
        images: req.body?.images,
        attachments: req.body?.attachments,
        signal: cancel.signal,
        onToken: (t) => { if (!clientGone()) write({ type: 'token', text: t }); },
        // Progress lines. Same channel as the tokens, different type — an older
        // cached frontend ignores an unknown type, so this cannot break one.
        onStatus: (m) => { if (!clientGone()) write({ type: 'status', text: String(m || '') }); },
      });
      write({ type: 'done', ...out });
    } catch (e) {
      write({ type: 'error', error: 'send_failed', message: e.message });
    }
    res.end();
  }));

  // POST /api/convos/:id/plan — generate the coder brief (TITLE + BRIEF).
  router.post('/:id/plan', asyncHandler(async (req, res) => {
    const out = await convos.requestPlan(req.params.id);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // POST /api/convos/:id/handoff — queue the plan as a paused task (idempotent).
  router.post('/:id/handoff', asyncHandler(async (req, res) => {
    const out = await convos.handoffToQueue(req.params.id, { title: req.body?.title || null, prompt: req.body?.prompt || null });
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

// POST /api/convos/:id/files — upload a file and store it in knowledge_docs
  // as a File: subject. Expects multipart/form-data with a "file" field.
  // Returns { id, title, status } so it can be attached to the conversation.
  // POST /api/convos/:id/files — attach a file. The browser has already
  // extracted the text (a file never rides raw into the prompt or the DB — see
  // plans/files-in-the-room.md), so this is a plain JSON body, not multipart.
  router.post('/:id/files', asyncHandler(async (req, res) => {
    const { filename, mimeType, text, bytes, sha, outline } = req.body || {};
    const out = convos.attachFile(req.params.id, { filename, mimeType, text, bytes, sha, outline });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // ─── Section-by-section PDF extraction (plan "pdf-section-extraction") ─────
  // POST /api/convos/:id/extract/start — plan this doc's chunks (idempotent) and
  // fire the sweep in the background; returns immediately, same shape as the
  // world-look's runWorldLookGuarded callers.
  router.post('/:id/extract/start', (req, res) => {
    const convoId = req.params.id;
    const knowledgeDocTitle = req.body?.knowledgeDocTitle;
    if (!knowledgeDocTitle) return res.status(400).json({ error: 'knowledge_doc_title_required' });
    // Full reset: always stop any in-flight read and wipe every prior section
    // for this conversation, then plan this document from scratch (section 1) —
    // even if a previous read is still running.
    docExtraction.resetExtraction({ convoId });
    const planned = docExtraction.planChunks({ convoId, knowledgeDocTitle });
    if (planned.error) return res.status(planned.error === 'not_found' ? 404 : 400).json(planned);
    // No websocket message for this — same as the world-look sweep, the
    // frontend polls GET .../extract/status instead (plan's explicit choice).
    docExtraction.startExtractionSweep({ convoId });
    res.json({ started: true, ...planned });
  });

  // GET /api/convos/:id/extract/status — counts for the "Read N of M sections" line.
  router.get('/:id/extract/status', (req, res) => {
    res.json(docExtraction.extractionStatus(req.params.id));
  });

  // GET /api/convos/:id/extract/chunks?status=extracted — rows awaiting review
  // (or confirmed/rejected, for a status filter later).
  router.get('/:id/extract/chunks', (req, res) => {
    const status = String(req.query.status || 'extracted');
    res.json({ chunks: docExtraction.listChunks(req.params.id, status) });
  });

  // POST /api/convos/:id/extract/chunks/:chunkId/confirm — freeze this section's
  // reading and append it into the running "confirmed findings" note.
  router.post('/:id/extract/chunks/:chunkId/confirm', (req, res) => {
    const out = docExtraction.confirmChunk(req.params.chunkId);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/extract/chunks/:chunkId/reject — mark this section
  // wrong; capturing the note is manual re-work for now (see plan's out-of-scope).
  router.post('/:id/extract/chunks/:chunkId/reject', (req, res) => {
    const out = docExtraction.rejectChunk(req.params.chunkId, req.body?.reviewer_note);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/extract/cancel — stop reading a document explicitly
  // (the detach route above already calls this internally for file detaches;
  // this exists for completeness — see plans/cancel-extraction-on-detach.md).
  router.post('/:id/extract/cancel', (req, res) => {
    const knowledgeDocTitle = req.body?.knowledgeDocTitle;
    if (!knowledgeDocTitle) return res.status(400).json({ error: 'knowledge_doc_title_required' });
    const out = docExtraction.cancelExtraction({ convoId: req.params.id, knowledgeDocTitle });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/extract/clear — reject every section still awaiting
  // review in one call (the Room panel's "Clear all" button).
  router.post('/:id/extract/clear', (req, res) => {
    const out = docExtraction.rejectAllExtracted({ convoId: req.params.id });
    if (out.error) return res.status(out.error === 'missing_args' ? 400 : 400).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/unfold — put the last fold back.
  router.post('/:id/unfold', asyncHandler(async (req, res) => {
    const out = convos.unfoldConvoContext(req.params.id);
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));
  // POST /api/convos/:id/reset — fold conversation into a recap.
  router.post('/:id/reset', asyncHandler(async (req, res) => {
    const out = await convos.resetConvoContext(req.params.id);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // POST /api/convos/:id/retitle — name it again, properly. Waits for the model:
  // it is a click, and a click that changes nothing on screen reads as broken.
  router.post('/:id/retitle', asyncHandler(async (req, res) => {
    const out = await convos.retitleConvo(req.params.id);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // Chapters — both kinds in one list, in the order they occur in the thread: the
  // places he saved by hand, and the ones the conversation found in itself.
  router.get('/:id/chapters', (req, res) => {
    res.json({ chapters: listChapters(req.params.id) });
  });

  // Read the thread again now, whatever the "has it grown enough?" rule says.
  router.post('/:id/chapters/rebuild', (req, res) => {
    res.json(chapterize(req.params.id, { force: true }));
  });

  // Put the capitals back in chapter names written all lowercase.
  router.post('/:id/chapters/recase', asyncHandler(async (req, res) => {
    res.json(await recaseChapters(req.params.id));
  }));

  // Chapters — saved places inside one conversation.
  router.get('/:id/marks', (req, res) => {
    res.json({ marks: convos.listMarks(req.params.id) });
  });

  router.post('/:id/marks/named', asyncHandler(async (req, res) => {
    const out = await convos.addNamedMark(req.params.id, { messageId: req.body?.messageId, snippet: req.body?.snippet });
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  router.post('/:id/marks', (req, res) => {
    const out = convos.addMark(req.params.id, {
      messageId: req.body?.messageId,
      snippet: req.body?.snippet,
      label: req.body?.label,
    });
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.delete('/:id/marks/:markId', (req, res) => {
    const out = convos.deleteMark(req.params.id, req.params.markId);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/fork — the same thread up to a point, in a new one.
  // Body: { throughMessageId? } to branch from a message rather than the end.
  router.post('/:id/fork', (req, res) => {
    const out = convos.forkConvo(req.params.id, {
      throughMessageId: req.body?.throughMessageId || null,
      title: req.body?.title || null,
      createdBy: req.user?.id || 'antoine',
    });
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/rewind — remove a message and everything after it.
  router.post('/:id/rewind', (req, res) => {
    const out = convos.rewindConvo(req.params.id, req.body?.messageId || null);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // DELETE /api/convos/:id/messages/:messageId — remove one message, keep the rest.
  router.delete('/:id/messages/:messageId', (req, res) => {
    const out = convos.deleteMessage(req.params.id, req.params.messageId);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // DELETE /api/convos/:id — soft-delete the conversation.
  router.delete('/:id', (req, res) => {
    const out = convos.deleteConvo(req.params.id);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  return router;
}
