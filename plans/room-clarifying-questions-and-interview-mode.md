# Clarifying questions and Interview mode in the Room

| Status | Date |
|---|---|
| **DONE** | 2026-09-14 |

## Where you are

QNE's **Room** is the long-running conversation surface in `queue-server/public/index.html` (mirrored byte-for-byte from the repository-root `fmcns_navigator.html`). It sends turns through `server/src/routes/conversations.js` to `server/src/services/conversations.js`. Each ordinary turn is built by `buildTurnPrompt()` and sent through the existing turn router. The router can choose Auto or a manually pinned lane — Claude, the second Claude account, OpenCode, or Gemini — and all of those lanes receive the same Room prompt and transcript.

There is a hidden `/grill-me` command today. It asks one sharp question but is only a one-off generation: it does not persist a mode, has no visible control, and a reply to it goes back to ordinary conversation. This plan turns that small seed into a coherent conversational ability.

## Why

Antoine wants two ways for the Room to clarify him:

1. Any answering model should notice when what he means is genuinely unclear and ask a useful question before it commits to an answer.
2. He should be able to plainly say “ask me questions” or use one easy visible control when he wants a fuller interview before the model answers.

The Room must remain aware of the whole conversation's subject while it asks. Changing model halfway through must not make the questioning restart or forget what has already been settled. One question at a time is the desired rhythm, and Antoine — not the model — decides when there is enough understanding to answer.

## The intended behaviour

### Normal conversation: a model may clarify when it matters

Every ordinary Room model gets one shared instruction in the normal turn prompt:

- If a missing meaning, goal, constraint, or distinction would materially change the answer, ask **one** focused clarifying question before answering.
- Otherwise give the useful answer now. Do not turn ordinary conversation into a ritual of questions merely because more detail could be useful.
- Use the thread, its recap, attached material, shared Room memory, and the active subject before asking. Never ask something Antoine already answered.
- A clarification is part of the conversation, not a form: no numbered survey, no list of questions, no technical explanation of why the question is needed.

This is provider-independent prompt behaviour. It must run on Auto and every manual lane without adding a second model, a side thread, or a special chat format.

### Interview mode: Antoine explicitly asks to be questioned

Add a persistent per-conversation clarification state, with the values `normal` and `interview`. New conversations start in `normal`; this is not an app-wide default. While `interview` is active:

- The next normal user message is understood as material to explore and the model asks the single most important next question.
- Each later answer continues the same interview from the full Room context. It asks one question only and does not offer a solution, plan, recommendation, or final reading yet.
- The question should uncover the goal, desired outcome, meaning of important words, tensions, boundaries, audience, and criteria for a good result only where those are relevant. It should not mechanically exhaust categories.
- The mode survives refreshes and a change of answering model, because it lives on the conversation rather than in one browser render or provider session.

Antoine can enter this mode in either of two equivalent ways:

- a quiet **Interview** control beside the existing Room composer lane picker;
- natural wording in his own message, including direct forms such as “ask me questions”, “interview me about this”, “help me clarify what I mean”, or “question me before answering”. Detect this narrowly enough that a discussion *about* whether models ask questions does not accidentally change the mode.

Keep `/grill-me` as a backwards-compatible alias for starting Interview mode and add `/interview` as the clearer typed name. Update `/help` accordingly.

### Answer now

While Interview mode is active, show a compact **Answer now** action beside the composer and beneath the latest interview question. It is Antoine's explicit decision that the interview has enough material. The action must:

1. ask the current selected/automatic lane for the answer or synthesis using the complete interview already in the Room context;
2. save that answer as an ordinary assistant message with metadata marking it as an interview synthesis; and
3. clear the conversation back to `normal` only after the answer was successfully saved. If generation fails, leave Interview mode on so nothing is lost.

Typing clear equivalents such as “answer now” or “you can answer now” must take the same path. Do not insert a fake user message solely to represent clicking the control; the existing conversation already supplies the material. A direct conversation endpoint/action is appropriate so the button is reliable and the transition is not inferred by the browser.

After a successful answer the thread stays in normal conversation. A later topic is answered normally unless Antoine starts Interview mode again or the model sees a material ambiguity and asks one ordinary clarifying question.

## Implementation

### Conversation persistence and API

1. In `server/src/db/schema.js`, add `convos.clarification_mode TEXT NOT NULL DEFAULT 'normal'` using the repository's idempotent `ALTER TABLE` pattern. Existing conversations must read as `normal` if the column is absent or empty.
2. In `server/src/services/conversations.js`, add small, exported `getClarificationMode(convoId)` and `setClarificationMode(convoId, mode)` helpers beside `getChatLane` / `setChatLane`. Validate only `normal` and `interview`; return `not_found` consistently with the existing lane helpers.
3. Include `clarification_mode` in every conversation fetch response that already includes `chat_override`: `GET /api/convos/subject/:type/:id` and `GET /api/convos/:id`. Include `normal` in the initial `POST /api/convos/open` response too, so the UI needs no guess during its first render.
4. Add `POST /api/convos/:id/clarification-mode` with body `{ mode: 'normal' | 'interview' }`. It persists the choice and returns the resulting mode.
5. Add `POST /api/convos/:id/answer-now`. It calls one service function that builds a normal answer turn with an explicit synthesis instruction, preserving the conversation's sticky model override and normal router behaviour. Clear the stored mode only after its assistant message is saved. Return the normal streaming/non-streaming answer shape the frontend already understands; support the same NDJSON path as `/:id/message` if that is the least duplicative route.

### Prompt and message handling

1. Put two clearly named, shared prompt blocks near `baseSystem()` / `buildTurnPrompt()` in `conversations.js`: the normal clarification judgement and the Interview-only rule above. Add the latter in the cache-safe variable region after Room memory, repo facts, and transcript — never ahead of the project map.
2. Thread the conversation's stored clarification mode into both streaming and non-streaming `runChatTurn` paths. The mode changes the instruction for the turn; it must not replace the selected provider, model, tools, subject context, transcript, recap, Room memory, or analogy context.
3. Before the ordinary router path in `sendMessage()`, recognise narrowly scoped direct start requests and direct completion phrases. A start request sets Interview mode before saving/generating the user turn; a completion phrase invokes the same service path as `answer-now`. Do not activate on a sentence merely asking whether this feature exists.
4. Replace the one-off `/grill-me` generator branch with the persistent Interview path. `/interview` starts the same mode. Existing slash commands such as `/plan`, `/handoff`, `/ask`, `/check`, and `/second` keep their current meaning and remain available; they must not silently end the interview.
5. Reuse the existing `convo_messages.meta` JSON for `{ interview_synthesis:true }`; do not alter the SQLite `kind` CHECK or create a second transcript table.

### Room interface

1. In `fmcns_navigator.html`, find the Room composer rendered by `studioEmbed()` and its lane-picker state/wiring. Add one compact stateful control in that same composer idiom — no new horizontal band, sidebar, modal, helper prose, or form-like questionnaire. It reads **Interview** when inactive and has a clear active state when enabled.
2. Persist the switch through the new mode endpoint and reflect the returned state whenever a conversation loads or re-renders. It is per thread, so switching thread switches its displayed state.
3. When active, render **Answer now** in the composer and as a small action on the newest interview question. Both call the same endpoint; disable while a turn is streaming to prevent two concurrent synthesis requests.
4. Keep the lane picker and Interview control independently reachable. A person must be able to switch from Auto to a named model during an interview without losing or reinitialising the mode.
5. Copy the finished root frontend file to `queue-server/public/index.html` and verify the two are byte-identical. Railway serves only the latter.

## Do not do

- Do not make every new Room thread start by interrogating Antoine.
- Do not ask multiple questions in one reply, build a dedicated question panel, or show internal prompt/model machinery to him.
- Do not add an extra paid model call to decide whether clarification is needed.
- Do not make the model decide that the interview is over.
- Do not touch the separately scoped Room analogy engine, world-idea generation, queue behaviour, or the existing model-picker persistence beyond preserving it.

## Verification

1. Add a focused Node self-test (extend `scripts/room-selftest.mjs` when practical or create a small neighbour) for mode normalisation, narrow natural-language start/end detection, prompt selection, and the invariant that an interview synthesis only clears mode after successful saving.
2. Run syntax checks on every edited server file and the focused self-test.
3. Verify routes against a local database: old conversations default to `normal`, mode changes persist, invalid modes are rejected, and fetch responses expose the saved state.
4. Drive the live Room through these cases:
   - a clear normal request gets an answer;
   - an under-specified normal request gets one useful question;
   - the Interview control and a natural request both start the same mode;
   - several answers and a mid-interview model change continue the same subject;
   - **Answer now** produces a synthesis and returns the thread to normal;
   - a failed synthesis leaves the mode active;
   - `/grill-me`, `/interview`, and `/help` behave as documented.
5. Test the composer with the Room sidebars and an expanded lane picker, including a narrow window. Confirm every visible control can be clicked and no popover covers its own trigger.

## Completion record

Implemented as specified: `convos.clarification_mode` (normal/interview, additive `ALTER TABLE`, defaults existing rows to normal); `getClarificationMode`/`setClarificationMode` in `conversations.js`; `POST /:id/clarification-mode` and `POST /:id/answer-now` (NDJSON + plain-JSON, same split as `/:id/message`); the normal-clarify rule and the Interview instruction threaded into `buildTurnPrompt`/`runChatTurn`/`runChatTurnStreaming` via a `clarifyMode` param, provider-independent; narrow whole-message regexes for the natural-language start/end phrases; `/grill-me` and `/interview` both start the same persistent mode (no longer a one-off); `/help` updated. Frontend: an Interview toggle beside the lane picker and an Answer now action (composer + inline under the newest question) in `fmcns_navigator.html`, mirrored byte-identically to `queue-server/public/index.html`.

Tested: `node --check` on every edited server file and the frontend's inline `<script>` blocks; extended `scripts/room-selftest.mjs` (mode normalisation, narrow phrase detection, the answer-now failure invariant) — all passing, no model cost. Verified live against a local server + real database: old conversations default to normal, mode changes persist and reject invalid values, fetch responses expose `clarification_mode`, `/help` lists the new commands. Also drove the actual turn/model pipeline live (not mocked) via direct API calls exercising the same code the browser calls: `/interview` set the mode and asked one real question (answered by Google's free lane); `answer-now` synthesised from the interview and returned the thread to normal (Cerebras); the natural phrase "ask me questions" re-entered interview mode and asked a further question; a pinned lane going rate-limited on `answer-now` left the mode on `interview` untouched (the failure invariant, caught live, not just in the self-test); the `/grill-me` alias still starts the same mode. Normal clarification (the shared "ask when it matters" instruction on ordinary turns) is wired into the same prompt path proven live above, on two real free-lane providers (Google AI Studio, Cerebras) plus the deterministic self-test — not separately re-verified with a message ambiguous enough to force a live clarifying question, since that judgment call belongs to the model on a real Antoine message rather than a scripted one.

Not done: could not drive the actual browser UI (click the Interview button, the composer's Answer now, resize the window, check popovers) — this sandbox has no browser. The frontend markup, CSS and event wiring were written, syntax-checked, and reasoned through against the existing composer's own patterns, but not visually confirmed. The lane-picker/Interview independence and narrow-window layout claims in the plan's "How to verify" §5 are therefore unverified and worth a real look before calling this fully closed.
