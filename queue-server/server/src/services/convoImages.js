// The images sent with a Room message, kept so the message can show them again
// (a click on the file chip opens it) and so answering it again sends the image
// too, instead of the words alone. The transcript itself keeps only names.
import { randomUUID } from 'node:crypto';

let db = null;

export function bindConvoImages(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS convo_images (
    id TEXT PRIMARY KEY, convo_id TEXT NOT NULL, msg_id TEXT NOT NULL,
    name TEXT, mime TEXT, data_url TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS convo_images_msg ON convo_images(msg_id)');
  // A message removed from the Room takes its images with it.
  try { db.exec('DELETE FROM convo_images WHERE msg_id NOT IN (SELECT id FROM convo_messages)'); } catch {}
}

// Returns one id per image, in order.
export function saveConvoImages(convoId, msgId, images) {
  if (!db || !Array.isArray(images) || !images.length) return [];
  const put = db.prepare('INSERT INTO convo_images (id, convo_id, msg_id, name, mime, data_url) VALUES (?,?,?,?,?,?)');
  return images.map((x) => {
    const id = randomUUID();
    try { put.run(id, convoId, msgId, x.name || 'image', x.mimeType || '', x.dataUrl); return id; } catch { return null; }
  });
}

export function convoImage(convoId, id) {
  if (!db) return null;
  return db.prepare('SELECT id, name, mime, data_url FROM convo_images WHERE convo_id=? AND id=?').get(convoId, id) || null;
}

export function dropMessageImages(msgIds) {
  if (!db || !msgIds?.length) return;
  const del = db.prepare('DELETE FROM convo_images WHERE msg_id=?');
  for (const id of msgIds) del.run(id);
}
