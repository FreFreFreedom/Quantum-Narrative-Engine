// The real IMDb rating and the real number of votes — IMDb's own published data,
// free, no key, no account.
//
// IMDb releases title.ratings.tsv.gz every day (a non-commercial dataset: one row
// per title, tconst → average rating, vote count). TMDB hands us the tconst for
// anything it knows, so the two together give the number people actually recognise
// instead of TMDB's own, which is close but never the same.
//
// The file is ~25 MB and lives next to the database. It is downloaded at most once
// a week, and read by streaming: a lookup scans it for the handful of ids asked
// for and the answers are stored on the film's row forever, so this runs only
// when something new arrives on the shelf.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { DB_PATH } from '../db/schema.js';

const SOURCE = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const FILE = path.join(path.dirname(DB_PATH), 'imdb-ratings.tsv.gz');
const WEEK = 7 * 24 * 60 * 60 * 1000;

function fresh() {
  try { return Date.now() - fs.statSync(FILE).mtimeMs < WEEK && fs.statSync(FILE).size > 1_000_000; }
  catch (err) { return false; }
}

let downloading = null;
async function ensureFile() {
  if (fresh()) return true;
  if (downloading) return downloading;
  downloading = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      const r = await fetch(SOURCE, { signal: ctrl.signal });
      if (!r.ok || !r.body) { clearTimeout(timer); return false; }
      const tmp = FILE + '.part';
      await pipeline(r.body, fs.createWriteStream(tmp));
      clearTimeout(timer);
      fs.renameSync(tmp, FILE);
      return true;
    } catch (err) {
      console.warn('[imdb] could not fetch the ratings file:', err.message);
      return false;
    } finally { downloading = null; }
  })();
  return downloading;
}

// One pass over the file for however many ids are wanted at once.
export async function imdbRatings(ids = []) {
  const want = new Set(ids.filter(Boolean));
  const out = {};
  if (!want.size) return out;
  if (!(await ensureFile())) return out;
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(FILE).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const id = line.slice(0, tab);
      if (!want.has(id)) continue;
      const [, rating, votes] = line.split('\t');
      out[id] = { rating: Number(rating) || 0, votes: Number(votes) || 0 };
      want.delete(id);
      if (!want.size) break;
    }
    rl.close();
  } catch (err) { console.warn('[imdb] could not read the ratings file:', err.message); }
  return out;
}
