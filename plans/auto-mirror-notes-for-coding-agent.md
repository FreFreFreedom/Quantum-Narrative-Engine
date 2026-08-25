| Status | Date |
|---|---|
| **PLANNED** | 2026-08-25 |

# Auto-mirror saved notes so the terminal coding agent can read them

## Where you are

FMCNS, the Idea Studio. `/note` (conversations.js `runSaveNoteTurn`) saves a conversation as
a `Note:` document in `knowledge_docs`. The **terminal coding agent** (Claude Code /
OpenCode) runs in a git worktree branched from `develop` and has **no database access** (its
brief and repo files only) — so it cannot read those notes. The app already mirrors repo
docs into `queue-server/project-docs/` (see `scripts/sync-docs.js`, `DEST =
join(QUEUE_SERVER, 'project-docs')`) so the deployed map can read them. We reuse that rail:
mirror every note to disk, commit it to `develop`, and point the coder at the folder — so it
sees saved notes automatically, no manual attach or handoff.

## Why (Antoine's words)

He wants the coding agent "to also see it just automatically, without me asking" — the
terminal coder should read the saved conversations/notes on its own, the same way the app's
chat does, without him attaching or handing off.

Scope (his choice): **all** notes, **one file per note**.

## What to do

### Backend — new `queue-server/server/src/services/noteMirror.js`

1. `syncNoteMirror()`:
   - Read all notes: `db.prepare(\`SELECT title, description, content, updated_at FROM knowledge_docs WHERE title LIKE 'Note: %'\`).all()` (mirror `listNotes` shape in `knowledgeDocs.js`).
   - Target dir `queue-server/project-docs/notes/` (resolve from this file: `join(__dirname,'..','project-docs','notes')`); `mkdirSync(..., {recursive:true})`.
   - For each note: filename = sanitized title + `.md` (strip the `Note: ` prefix, drop
     filesystem-unsafe chars; on collision append a short id). Write the content prefixed
     with a small header (`# <title>` + a `Saved: <updated_at>` line) so the coder sees
     what it is.
   - Write `index.md` listing every note (`- <title> — notes/<file>.md`).
   - **Reconcile:** read the existing `notes/` dir; delete any `<file>.md` (other than
     `index.md`) whose note no longer exists in `knowledge_docs`. This drops notes removed
     while the server was off.
2. `commitAndPushNotes()`: `git -C <repo> add queue-server/project-docs/notes`,
   `git commit -m "mirror: sync Idea Studio notes"` (no-op if nothing changed),
   then `git pull --rebase` and `git push origin develop`. **Reuse the exact safe-push
   discipline from `scripts/send-plan.js` `gitPush()` (~line 58): rebase before push, only
   touch the notes subtree, so it does not fight the queue's own `git-ship` pushes.**
   Debounce rapid `/note` saves (e.g. a 5s coalescing timer) so one push covers several.
3. Hook `syncNoteMirror()` + `commitAndPushNotes()` from **`createKnowledgeNote`** in
   `knowledgeDocs.js` (~line 68) right after the `INSERT` succeeds (the note is now in the
   DB). This is the automatic trigger.
4. Boot + safety: call `syncNoteMirror()` once at server start (`index.js`, alongside the
   existing boot wiring) and on a periodic `setInterval` (e.g. every 5 min) so notes written
   while the server was off still get mirrored and pushed.

### Make the coder aware — `CLAUDE.md` (repo root)

5. Add one line to `CLAUDE.md` (near the FMCNS / queue-runner guidance):
   "Idea Studio conversations saved with `/note` are mirrored to
   `queue-server/project-docs/notes/` (one file per note, plus `index.md`). When a task
   relates to a saved note or earlier conversation, read the relevant file there."
   This is read by the coding agent from its worktree, so it knows to look — no manual step.
   Per the docs-sync rule, after editing `CLAUDE.md` run `npm run docs:sync` from
   `queue-server/` and commit the result (it updates `queue-server/project-docs/CLAUDE.md`),
   or let `noteMirror`'s commit step include it.

### Frontend (`fmcns_navigator.html`)
None required. Optional polish: append "and the coding agent" to the `/note` success line
(conversations.js `runSaveNoteTurn` ~line 1420). Leave out unless trivial.

## Commit to read first

Current `develop` (advanced past `5db2feb` by the time this runs). Re-read:
`createKnowledgeNote` (knowledgeDocs.js ~68), `scripts/sync-docs.js` (the mirror pattern,
`DEST` ~line 23), `index.js` boot wiring, `taskRunner.js` worktree creation (confirms the
coder branches from `develop`), and `CLAUDE.md`. Line numbers drift — search the named
symbols.

## Traps

- **The coder has no DB access** — the entire point is the file mirror. Do not try to hand
  it a query; give it files.
- **Git churn / conflicts:** committing note files to `develop` on every `/note` can collide
  with the queue's own `git-ship` pushes (and `send-plan` pushes). The non-fast-forward we
  hit while sending plans is the same class of problem. Mitigate with **rebase-and-push,
  only the `project-docs/notes` subtree, debounced**. If conflicts still prove unworkable in
  practice, the escape hatch is to mirror to an **external absolute path** instead
  (`process.env.NOTES_MIRROR_DIR || join(os.homedir(), '.fmcns', 'notes')`) the coder reads
  directly — no commit, no deploy coupling. Prefer the repo-committed rail; fall back only
  if git fights back.
- **Per-task visibility:** the coder only sees notes committed to `develop` *before* its
  worktree was created. A note added after a task starts appears on the next task — that is
  the intended "automatic per task", not live.
- **Filename sanitization:** titles contain spaces, colons, slashes, apostrophes — sanitize
  or collisions occur; append a short id on clash.
- Keep `index.md` in the mirror so the coder can discover notes without guessing filenames.
- `project-docs/notes/` must be created (recursive mkdir) before the first write.

## How to verify (no test suite)

- `node --check` the new/changed server files.
- In the app, save a conversation with `/note`; confirm `queue-server/project-docs/notes/<slug>.md`
  exists with the content, `index.md` lists it, and the notes dir is committed + pushed to
  `develop`.
- Confirm `CLAUDE.md` (and its `project-docs/CLAUDE.md` mirror) mentions the path.
- Start a coding task (or ask the coder in a task to "list the saved Idea Studio notes") and
  confirm it reads `queue-server/project-docs/notes/` with **no** manual attach/handoff.
- Delete a note (or stop the server, delete one, restart) and confirm its mirror file is
  removed by the reconcile step.

## Out of scope

- Filtering which notes are mirrored (Antoine chose **all**).
- One combined notes file (he chose **one file per note**).
- The chat reading the mirror (the chat already reads `knowledge_docs` directly via its
  tools, so it needs no change).
- Pushing the mirror specifically to the Railway image (the local coder is the target; the
  committed repo copy already reaches its worktree).
