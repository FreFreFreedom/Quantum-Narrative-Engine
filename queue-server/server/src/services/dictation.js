// Dictation, heard properly. The browser's own recogniser drops words and gives up
// on a pause; what was said is recorded alongside it and handed to Whisper — the
// same family of model behind ChatGPT's dictation (his bar, 2026-09-26) — on
// Groq's free tier (2000 clips a day, two hours of audio an hour). A refusal or a
// timeout returns nothing and the browser's own words stay in the box.

const URL_ = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';

export async function transcribe({ audio, mime = 'audio/webm', context = '', language = 'en' }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { error: 'no_key' };
  const m = String(audio || '').match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s);
  const bytes = Buffer.from(m ? m[2] : String(audio || ''), 'base64');
  if (bytes.length < 800) return { text: '' };
  if (bytes.length > 24 * 1024 * 1024) return { error: 'too_long' };
  const type = (m && m[1]) || mime;
  const ext = /ogg/.test(type) ? 'ogg' : /mp4|m4a|aac/.test(type) ? 'm4a' : /wav/.test(type) ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), 'dictation.' + ext);
  form.append('model', MODEL);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (language) form.append('language', String(language).slice(0, 2));
  // What he is writing about, so names and his words come out spelled right.
  const hint = String(context || '').replace(/\s+/g, ' ').trim().slice(-600);
  if (hint) form.append('prompt', hint);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) { console.warn('[dictation] whisper', r.status, (await r.text()).slice(0, 200)); return { error: 'refused' }; }
    const j = await r.json();
    const text = String(j.text || '').trim();
    // Whisper's well-known words for silence: a clip with nothing said comes back as
    // "Thank you." or "Thanks for watching!", which must not land in the box.
    if (/^(thank you|thanks|thanks for watching|thank you for watching|you|bye|merci|sous-titrage[^.]*)[.!]?$/i.test(text)) return { text: '' };
    return { text };
  } catch (err) {
    console.warn('[dictation] whisper failed', err.message);
    return { error: 'unavailable' };
  }
}
