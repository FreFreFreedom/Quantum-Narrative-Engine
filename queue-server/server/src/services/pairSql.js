// Two models answering one question (plan two-models-side-by-side).
//
// Both answers stay on screen and both stay in the database. Only ONE of them —
// the kept side — may be read as the thread's answer: a prompt, a note, the
// running log, the chapters or the mind harvest that saw both would be handed two
// different answers to the same question and would contradict itself on the next
// turn.
//
// Its own tiny module so every reader can import the rule without importing
// conversations.js (which imports half of them back).

// For a raw SQL read of convo_messages. Aliased or not, it reads `meta`.
export const KEPT_SIDE_ONLY_SQL =
  `(meta IS NULL OR meta NOT LIKE '%"pair":"%' OR meta LIKE '%"kept":true%')`;

// Same rule in JS, for a row already in hand.
export function isDroppedSide(meta) {
  if (!meta) return false;
  const raw = typeof meta === 'string' ? meta : JSON.stringify(meta);
  if (raw.indexOf('"pair"') === -1) return false;
  try {
    const m = typeof meta === 'string' ? JSON.parse(meta) : meta;
    return !!m?.pair && m?.kept !== true;
  } catch { return false; }
}
