// Load queue-server/.env into process.env, for local runs (the server and the queue
// runner both call this first thing).
//
// Why hand-rolled instead of node's --env-file / --env-file-if-exists flag: the flag
// version-gates the START COMMAND. `--env-file-if-exists` needs Node 22.9+, this
// project only pins >=22.5, and Railway resolves its own Node — so a host one minor
// version behind would refuse to start the app at all ("bad option"), which is a
// deployment failure caused purely by how we read a local config file. This function
// cannot fail that way: no file, no problem.
//
// Real environment variables always win. On Railway everything is set as a project
// variable and no .env exists, so this is a no-op there.
import { readFileSync } from 'node:fs';

export function loadEnvFile(url) {
  let text;
  try { text = readFileSync(url, 'utf8'); } catch { return { loaded: 0 }; }
  let loaded = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // a real env var beats the file
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue; // an empty placeholder in .env.example style means "unset"
    process.env[key] = value;
    loaded++;
  }
  return { loaded };
}
