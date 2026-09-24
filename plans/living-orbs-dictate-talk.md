# Living orbs, Dictate, Talk

**Status:** DONE 2026-09-24. Built and shipped in a live terminal session at Antoine's
request ("write it and implement here").

Antoine picked these from a mockup page built on 2026-09-24. The page itself was a
throwaway, served locally from the session scratchpad, so it is not in the repo. He picked
eight screens: Room answering, Dictate, Talk, Discover, Queue, Graph and Map, Readings,
Login. He did not pick two: **New chat** (a big orb in an empty Room) and **Read aloud**
(words lit up as they are spoken). Leave both out unless he asks for them.

## Sources (all MIT, inlined, no build step)

- **Thinking Orbs** by Jakub Antalik (github.com/Jakubantalik/thinking-orbs, npm
  `thinking-orbs@0.3.2`). Its `dist/index-*.js` engine uses no framework: `MODE_FRAMES`,
  `paintFrame`, `resolvePreset`. It is inlined into `fmcns_navigator.html` as-is, with its
  ES `export` removed. Nine motions: breathing, searching, composing, weaving, working,
  solving, connecting, shaping, listening. There are two preset sizes, 20 and 64; any
  other size is 64 scaled by the canvas.
- **ElevenLabs UI Orb** (github.com/elevenlabs/ui, `orb.tsx`). The original is
  Three.js/React. It is ported to plain WebGL2 with the same fragment shader. The perlin
  texture is generated on a canvas instead of being fetched. States: idle, thinking,
  listening, talking. It can also be driven by a live microphone level.
- **Paper Shaders "liquid metal"** (github.com/paper-design/shaders v0.0.76, the shader
  behind VoiceOrbs' Mercury orb). Only `ShaderMount` and the liquid-metal shader are
  bundled, minified, as `window.QnePaperLM`. It is used for the Login orb, tinted per look
  with a CSS filter.
- **ElevenLabs Shimmering text**: a CSS gradient sweep (`.qne-shimmer`).
- **ElevenLabs Matrix**: a small dot display for the active Queue stage.

## One engine, used everywhere

- **Markup:** `orbHtml(state, size)` returns `<span class="torb" data-orb=… data-size=…>`.
- **Drawing:** one `requestAnimationFrame` loop finds every `.torb` on screen and draws
  it. The canvas is created lazily, which survives innerHTML repaints. Hidden elements
  are skipped.
- **Pausing and motion:** the loop pauses when the tab is hidden. With reduced motion it
  draws one static frame.
- **Colour:** the look's `--c-accent`, re-read whenever `data-look` changes.

## Where each one goes

| Place | Orb | Code |
|---|---|---|
| Room / studio turn before the first token | 20px orb whose motion follows `e.phase` (thinking, searching the Library, folding, reading), with the phase line shimmering | busy branch in `fillEmbed` (the `se-dots` markup) |
| Room turn while streaming | a composing orb in place of the `▍` cursor | same |
| Room thread list | composing orb on the thread whose answer is being written | thread row render |
| Discover | globe orb on tiles still without art, and while the list is loading | `room-rec-*` |
| Library | working orb in place of `.shelf-spin`, and on book-card waits | `shelfWorkingMarkup`, `.se-card-wait`, `.shelf-note-wait` |
| Queue cards | an orb before the stage label while the stage is moving (tone `go`): shaping for drafting, searching for looking at the world, working for running, connecting for going live. The label shimmers and the active dot becomes a moving dot matrix. The task thread's thinking dots become a breathing orb. | `stageStripHtml`, `q-thread-thinking` |
| Graph and Map loading | large constellation (graph) or globe (map) in the middle of the stage until boot finishes | `boot()` |
| Readings | 20px orb and a shimmering line for the tag lens, books for a pattern, deeper read and passage reading | the `Loading…` / `Reading deeper…` / `pass-reading.is-waiting` sites |
| Login | liquid-metal orb above the password; a connecting orb on the button while logging in | `#loginGate`, `loginBtn` |

## Dictate (Room composer)

- **The button:** a microphone button in `.se-compose`, shown only where the browser has
  `SpeechRecognition` / `webkitSpeechRecognition` (free, built in, the same API the Queue
  mic already uses in `initQMic`).
- **The text:** interim words stream into the box live; final words stay. The text goes
  through the box's own `input` handler, so the draft is saved as usual.
- **Recording state:** the button turns the danger colour, and a live waveform replaces
  the lane picker. The level comes from `getUserMedia` plus an `AnalyserNode`.
- **Stopping:** click again or press Enter. Enter also sends.
- **Language:** always English (`en-US`), for both hearing and the Talk voice — Antoine's call 2026-09-24.

## Talk (Room only)

- **Opening:** a Talk button beside the mic opens a full-panel overlay over the
  conversation: a large ElevenLabs orb, a shimmering state word, and a conversation bar
  with a live waveform, a keyboard button (back to typing) and ✕ (end).
- **The loop:** listen until you pause; send through the embed's normal send path
  (`host.__seState` / the send button, so quotes, lanes and drafts behave exactly as when
  typing); the orb shows thinking while `e.busy`; the answer is read aloud with
  `speechSynthesis`, with markdown stripped and the best local English/French voice. Then
  it listens again.
- **Interrupting:** talking over it cuts the speech.
- **Cost:** nothing paid. ElevenLabs voices were considered and left out because they are
  metered (see the never-spend-real-money rule).

## Open questions for Antoine

- If the Mac's free voices are too flat, is a paid voice worth it for Talk? (Default: no.)
