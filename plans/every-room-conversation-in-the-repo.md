# Every Room conversation reaches the repo, not only the saved ones

**Status: PLANNED (not a green light) — written 2026-09-13. Antoine names a plan before it
is implemented.**

## What he asked for

> "That would be cool if every conversation that we have in the Room is saved automatically
> — just as a conversation in our system — so other models, whatever, Claude in the terminal
> or whichever model we use, can access them and reference them and use them as context."

And, on the junk: **"skip the short junk threads."**

## What already exists (do not rebuild any of this)

- Every Room thread is already stored permanently — `convos` + `convo_messages`, on the
  Railway volume. Nothing is lost today; it is simply unreachable from a worktree.
- `/note` writes a curated note into `knowledge_docs` under the `Note: ` title convention
  (`services/knowledgeDocs.js`), and `services/noteMirror.js#noteFiles` turns those rows
  into `{path, content}` pairs under `queue-server/project-docs/notes/`.
- The Mac runner is the only thing that can reach the repo. **Railway's image has no `git`
  binary at all** — every server-side push dies on `spawnSync git ENOENT`. Do not write a
  server-side git path; this has already cost the project two weeks of silently missing
  files.
- `scripts/queue-runner.js#mirrorToRepo` runs every 5 minutes while the runner is idle,
  fetches `/api/convos/notes?full=1` and `/api/mind`, and hands one list of files to
  `scripts/git-ship.js#commitFilesToTrunk`, which writes them in its own worktree
  (`.claude/worktrees/mirror`) and pushes `develop`. It commits only when content differs.

So the gap is exactly one thing: **a thread that was never `/note`d has no file.**

## The shape

One more producer feeding the mirror that already runs. No new timer, no new push path, no
second commit.

### 1. A read route that returns whole transcripts

`GET /api/convos/transcripts` in `server/src/routes/conversations.js`, beside the existing
`/notes` and `/open` routes. One call, not N+1 — the runner must not walk `/convos/:id` per
thread.

Returns `{ convos: [{ id, title, created_at, updated_at, turns, messages: [{ role, content,
created_at }] }] }`, already filtered by the junk rule below, newest first.

Read it with the two functions that exist: `convos.listOpenConvos()` and
`convos.listMessages(id)` (`services/conversations.js`). No new query shapes.

### 2. The junk rule, and it is deliberately dumb

Keep a thread only when **it holds at least three messages from Antoine**. Count `role =
'user'` rows, not total turns.

Why three: it is the same watermark the Room's own memory harvest uses before it bothers
reading a conversation (`services/mind.js`), so the two agree on what counts as a real
conversation, and a thread worth remembering is a thread worth keeping.

Measured against production 2026-09-13: nine open threads, of which `probe lane failure`
and `Have a conversation` are the shape this rule is for.

No model call, no cleverness, nothing that can misjudge — a rule he can predict is worth
more here than a rule that is right more often.

### 3. `services/convoMirror.js` — the file list

Built in `noteMirror.js`'s image and for the same reason: the list is data, so the same
function can serve the runner (which pushes it) and the server's own disk (which does not).

```
export const CONVOS_REPO_PATH = 'queue-server/project-docs/conversations';
export function convoFiles(convos = []) -> [{ path, content }]
```

**Filenames must be a pure function of the data — no clock, no randomness.** The runner
re-derives the list every few minutes; a name that drifts would commit, and therefore
redeploy, forever.

Use `<slug-of-title>-<first 8 chars of id>.md`. Not `noteMirror`'s count-up collision
suffix: four live threads share the title *Fractal reasoning across civic and justice
narratives (fork)*, and a count-up depends on list order, so a new thread would rename its
neighbours. The id never moves.

File body:

```
# <title>

Thread <id> · <n> turns · last said <updated_at>

## <you / the room>            <- one heading per message, in order
<message text>
```

Cap each message at 8,000 characters with a visible `…(cut)` marker. A single pasted
document should not put 300KB into a git commit; the note path is where a document belongs.

Plus `conversations/index.md` — one line per thread, title and filename, so a coding agent
can scan the shelf without opening anything.

### 4. Into the existing commit

In `mirrorToRepo()`, after the notes block and before the mind block:

- `GET /api/convos/transcripts`
- If the answer is a **non-empty** array, `files.push(...convoFiles(convos))` and add
  `${convos.length} conversation(s)` to `said`.
- An empty or failed answer is never acted on and never prunes — same guard the notes block
  already carries, and for the same reason (a broken query looks exactly like "he deleted
  everything"; that guard was added after the notes mirror was wiped twice on 2026-09-09).

### 5. Pruning needs a real fix first, not a second guess

`commitFilesToTrunk` takes a single `pruneDir` and builds its keep-set from
**`basename(f.path)` across every file in the list**. With two mirrored directories that is
wrong in a way that will not show up in testing: `notes/index.md` and
`conversations/index.md` share a basename, so each keeps the other alive.

Change `pruneDir` to `pruneDirs: string[]` and compare **repo-relative paths**, not
basenames. Update the one existing caller. Prune a directory only on a tick where that
directory's source answered non-empty — so a failed transcripts call never deletes notes,
and vice versa.

## What this deliberately does not do

- **No summarising, no model, no cost.** It copies text. A distilled version of a
  conversation already has a home: `/note`.
- **No de-duplication against notes.** A `/note`d conversation will have both a curated note
  and a raw transcript. They are different things and both are wanted; say so in
  `index.md` rather than trying to link them (notes are keyed by title, threads by id, and
  the two cannot be matched reliably).
- **No new branch, no new commit.** It rides the existing `mirror: what the Room knows`
  commit.

## Two things he should know, and they are not defects

- Conversations reach the repo **only while the runner is running**. Starting it catches
  everything since.
- Each mirror commit pushes `develop`, which **redeploys the app**. That is already true of
  notes and memory; this adds more occasions. A live conversation will commit roughly every
  5 minutes while he is talking. If that becomes noise, the cheap fix is to skip a thread
  whose `updated_at` is under ~10 minutes old — let a conversation settle before filing it —
  and it is worth shipping that from the start.
- Everything said in the Room becomes a file in the repository. Single-user, private repo,
  so this is a statement of fact rather than a risk — but it is the reason the junk rule
  exists at all.

## Verification

- `npm run notes:selftest` must still pass — it covers `commitFilesToTrunk` against a
  throwaway repo, no network, no credits, and the `pruneDirs` change lands inside it.
- Extend that selftest with the case that motivated the change: two mirrored directories,
  each with an `index.md`, and a file removed from one must not remove the other's.
- A pure-function check on `convoFiles`: same input twice → identical paths; two threads
  with the same title → two different files; a 20,000-character message → cut, with the
  marker.
- Then drive it for real: say three things in a new Room thread, wait for a mirror tick, and
  read the file in a worktree.

## Files

- `queue-server/server/src/routes/conversations.js` — one route.
- `queue-server/server/src/services/convoMirror.js` — new, ~60 lines.
- `queue-server/scripts/queue-runner.js` — one block in `mirrorToRepo()`.
- `queue-server/scripts/git-ship.js` — `pruneDir` → `pruneDirs`, path-based.
- `queue-server/project-docs/conversations/` — new, written by the mirror.
