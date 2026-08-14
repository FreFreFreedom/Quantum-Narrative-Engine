// One-shot key check: verifies a Google AI Studio key against the REAL Google
// endpoint, through the exact adapter the app's Fast Lane uses
// (services/providers/openaiCompat.js runToolless → catalog.js google-ai-studio).
//
// Usage (run from queue-server/):
//   GOOGLE_AI_STUDIO_API_KEY=your-key node scripts/test-google-key.mjs
//
// The script never prints the key — only the model's reply and timing.
import { runToolless } from '../server/src/services/providers/openaiCompat.js';

const start = Date.now();
const out = await runToolless({
  prompt: 'Reply with exactly this sentence: Google key works.',
  model: 'gemini-flash-latest',
  providerId: 'google-ai-studio',
  maxTokens: 50,
  timeoutMs: 30_000,
});
const secs = ((Date.now() - start) / 1000).toFixed(1);

if (out.code === 0) {
  console.log(`OK in ${secs}s — model replied: "${out.text}"`);
} else {
  console.log(`FAILED after ${secs}s — ${out.text || out.code}`);
  if (out.limit) console.log('(looks like a quota/rate limit — the key is valid but throttled)');
  process.exit(1);
}
