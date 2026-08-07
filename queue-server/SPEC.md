# File de travaux pilotée par Claude Code — spécification + code complet

**But de ce document** : décrire exactement, et fournir le code complet, de la fonctionnalité
« Travaux » de l'ERP Orisha — une file de prompts que le serveur exécute tout seul via le CLI
`claude`, avec conversation par tâche, steering en cours d'exécution, questions de l'agent à
l'humain, pause/quotas, suggestions générées par l'agent et carnet d'idées.

Le document est autoportant : il peut être donné tel quel à un autre assistant pour porter la
fonctionnalité dans une autre application. Tout le code présenté est le code réellement en
production (extrait du repo, non réécrit).

**Hors périmètre volontaire** : l'onglet « Travaux récurrents » (checklist par période) a été
retiré partout, comme demandé. Les seules traces restantes sont signalées comme *seams* à
neutraliser (§9).

Stack d'origine : Node.js + Express + SQLite (better-sqlite3) au serveur, React + Vite au client,
WebSocket pour le temps réel, CLI `claude` (Claude Code) installé sur la même machine que le
serveur.

---

## 1. Ce que la fonctionnalité fait (vue utilisateur)

La page `/travaux` remplace le va-et-vient manuel « je colle un prompt dans le terminal →
j'attends → `/clear` → le suivant ». Trois onglets :

### 1.1 « Ma file de prompts » — le cœur

| Fonctionnalité | Comportement exact |
|---|---|
| Ajouter un prompt | Zone de texte + réglages. Titre facultatif (voir 1.2). Cases : *mode*, *préréglage*, *poursuit le contexte*, *mettre en priorité* (dépose en tête de file au lieu de la fin). |
| Exécution automatique | Le serveur pousse **un** item à la fois dans l'exécuteur ; chaque item part d'un **contexte Claude neuf**, sauf ceux marqués « poursuit le contexte » qui reprennent la session du précédent (`claude --resume <session_id>`). |
| Deux voies d'exécution | *Implémentation* : strictement **une à la fois** (elle édite l'arbre de travail réel, sans isolation). *Question* (lecture seule, outils `Read,Glob,Grep`) : jusqu'à **2 en parallèle**, y compris pendant une implémentation. |
| Préréglages modèle/effort | `fast` = haiku/low · `standard` = sonnet/medium · `deep` = modèle le plus fort/high (défaut de la file). |
| Statuts affichés | `En file` · `En attente` (remis à l'ordonnanceur, pas encore démarré — reste modifiable et déplaçable) · `En cours` (le process Claude tourne) · `À répondre` (l'agent attend une décision) · `De côté` · `Terminé` · `Bloqué`. Rang d'attente affiché (« 2e »), calculé **par voie**. |
| Chronomètre | Durée écoulée rafraîchie à la seconde tant que l'item tourne ; date de fin ensuite. |
| Réordonner | Glisser-déposer par poignée + flèches clavier, en optimiste. Deux groupes indépendants : « en file » et « de côté ». Un item « en attente » est **repris à l'ordonnanceur** puis rendu dans le nouvel ordre — un simple changement de priorité ne lance donc rien. |
| Modifier | Prompt, titre, préréglage, mode, « même contexte » : modifiables tant que l'exécution n'a **pas réellement démarré** (autosave, debounce 600 ms + flush au blur). Une retouche sur un item « en attente » est répercutée sur la tâche déjà remise à l'ordonnanceur. |
| Fil de discussion par item | Chaque item porte SA conversation (`work_prompt_messages`). Le compte-rendu de chaque exécution y est versé. Répondre **relance** la tâche : le fil complet est réinjecté en clair dans le nouveau prompt, et la session Claude est reprise si elle existe encore — la continuité ne dépend jamais de `--resume`. |
| Steering (parler pendant l'exécution) | Un message envoyé pendant que la tâche tourne est déposé dans une *inbox* fichier ; un hook Claude Code (`PostToolUse` + `Stop`) le livre à Claude après le prochain outil, sans rien interrompre. Si la tâche n'a pas encore démarré, le message est intégré à son brief. Si le message arrive trop tard pour être lu, il est posé sur la tâche (`missed_user_message`) et l'item est **relancé automatiquement** avec le fil en contexte. |
| Questions de l'agent à l'humain | Une exécution détachée n'a pas de terminal : elle ne peut pas demander « laquelle des deux ? ». Elle émet donc une section finale optionnelle `=== QUESTION UTILISATEUR ===` + un JSON `{question, options[]}`. La carte affiche la question avec ses boutons de choix ; un clic répond dans le fil et relance la tâche. L'item passe en tête de file avec le statut `À répondre`. |
| « Pause après celle-ci » | Frein posé sur un item précis : quand **celui-là** finit, la file se met en pause au lieu d'enchaîner (borne la consommation de jetons sans surveiller la page). Le drapeau est consommé après usage. |
| Pause / reprise de la file | Bouton global. Ne tue **jamais** l'exécution en cours : bloque seulement les départs, donc reprendre repart exactement où la file s'était arrêtée, sans rien refaire. |
| Recap Slack | À la fin de chaque item, **une seule ligne** en DM Slack : `✅ Tâche terminée — <titre> · Ouvrir` (ou `🙋 Question à répondre — … · Répondre`, ou `⚠️ Tâche bloquée`), + « · file en pause » le cas échéant. Volontairement une ligne : le compte-rendu se lit dans l'app, pas dans Slack. |
| Quotas Claude épuisés | Détecté dans le transcript (`rate_limit_event`, ou la phrase « hit your session limit »). Ce n'est **pas** un échec : (a) si seul le plafond du modèle préféré est atteint, la tâche repart aussitôt sur le modèle de repli ; (b) si c'est un plafond de compte, l'item **retourne en file** (pas de compte-rendu trompeur), l'ordonnanceur attend la réinitialisation et repart tout seul. Un seul avis Slack par fenêtre de quota. |
| Deux files sur la même table | `space = 'finance'` ou `'agent'` : deux pages, deux listes ordonnées indépendamment, **un seul exécuteur partagé**. |
| Robustesse redémarrage | Résultat d'exécution écrit dans des fichiers durables (`.log` / `.code`), process détaché par `setsid --fork` : un `pm2 restart` — y compris celui que l'agent déclenche lui-même après une modif serveur — ne perd ni ne tue l'exécution. Au boot, on se rattache à l'exécution orpheline ; un item « en cours » dont la tâche a disparu est réconcilié au lieu de geler la file. |
| Vue « Conversations » | Deuxième vue : ce qui a rendu la main, replié, paginé (15 par page), avec recherche plein texte sur titre/prompt/messages. |

### 1.2 Titre automatique (deux étages, jamais imposé)

1. **Heuristique** synchrone à la création (première phrase nettoyée) → jamais de carte sans titre.
2. **Titre modèle** quelques secondes plus tard (haiku, sans outils) qui nomme la nature de la tâche.
3. **Titre dynamique de projet** : re-déduit du *fil complet* à chaque fois que le projet bouge
   (réponse de l'humain, compte-rendu de l'agent, prompt réécrit) — le cap le plus récent gagne.

Dès que l'utilisateur écrit son propre titre, `title_auto = 0` et plus rien ne le réécrit ; vider
le champ ramène le mode automatique.

### 1.3 « Suggestions de Claude »

Liste séparée de la file humaine, alimentée par deux moteurs sans outils (le contexte — `git log`,
file récente, erreurs de sync, connecteurs OAuth, pages existantes — est **fourni** au modèle, il
n'explore pas le repo) :

- `chantier` : un travail à faire dans l'app telle qu'elle est ;
- `integration` : un logiciel / une API externe à brancher, et ce que ça débloquerait.

Déduplication par empreinte SHA-1 du titre normalisé (une reformulation cosmétique ne revient pas,
même après rejet). Rien ne s'exécute avant que l'utilisateur n'« Ajoute » la suggestion à sa file
(le prompt reste ajustable avant l'ajout).

### 1.4 « Idées »

Le seul onglet d'où **rien** ne peut partir en exécution : un carnet (titre, notes, thème,
réordonnable, autosave). « Passer à l'action » crée un item de file **mis de côté** (`paused`) —
jamais lancé d'office. Idempotent : une idée déjà promue renvoie son item existant.

---

## 2. Architecture

```
Navigateur (React)
  Travaux.jsx ──HTTP──> routes/travaux.js ──> services/promptQueue.js   (la FILE : ordre, états, fil, recap)
      ▲                                              │
      │ WebSocket (events)                           ▼
      └──────────────────────────── services/taskRunner.js  (L'EXÉCUTEUR : slot unique, spawn `claude`,
                                          │                  streaming, quotas, finalisation)
                                          ├──> agentModel.js    (modèle préféré + repli quand quota épuisé)
                                          ├──> promptTitle.js   (titres auto, appels sans outils)
                                          └──> scripts/agent-steer-hook.mjs  (hook Claude Code : steering)
   services/workSuggestions.js  (moteurs de suggestions)   services/workIdeas.js  (carnet)
```

### Séparation des responsabilités (essentiel pour porter la feature)

- **`promptQueue.js`** possède la file : ordre, statuts métier, fil de discussion, recap Slack,
  « qui part maintenant ». Il ne parle jamais à `claude` directement.
- **`taskRunner.js`** possède l'exécution : un slot global pour les écritures, une voie parallèle
  lecture seule, le spawn détaché, le streaming, la détection de quota, la finalisation. Il ne sait
  rien de la file — il rappelle `promptQueue.onAgentTaskFinalized(task)` par import dynamique
  (l'import statique serait circulaire).
- Les « tâches agent » vivent dans un **fichier JSON** (`agent-tasks.json`, écriture atomique
  tmp+rename), la file dans **SQLite**. Ce n'est pas idéal mais c'est volontaire : le runner
  préexistait à la file. Dans un portage, `agent-tasks.json` peut devenir une table.

### Cycle de vie d'un item

```
créé (queued)
  └─ advanceQueue() : rien ne tourne + agent activé + file non en pause
        └─ enqueueAgentTask() → tâche 'approved'      → item 'running' / run_state 'waiting'
              └─ kick() → executeTask() → tâche 'in_progress'  → run_state 'executing'
                    ├─ spawn détaché : setsid --fork bash -c 'claude -p --output-format stream-json …'
                    │     stdout → .agent-exec-<id>.log      exit code → .agent-exec-<id>.code
                    ├─ monitorExecution() poll 2 s : streame le log, tue à 30 min, finalise sur .code
                    └─ finalize() : extrait rapport, RÉSUMÉ UTILISATEUR, QUESTION UTILISATEUR,
                                    session_id, quota, message de steering non lu
                          └─ onAgentTaskFinalized() : réponse dans le fil → item done/blocked
                                → recap Slack → advanceQueue() (au suivant)
```

### Événements temps réel (WebSocket → `window.dispatchEvent`)

| Message serveur | Effet client |
|---|---|
| `travaux:prompts:updated` | recharge la file (et le bouton pause) |
| `travaux:suggestions:updated` et `travaux:ideas:updated` | recharge l'onglet concerné |
| `agent:task:updated` | recharge la file si `kind === 'queue'` (c'est ce qui fait passer « En attente » → « En cours ») |
| `agent:task:stream` | flux live d'une exécution (texte, outils, résultats) |
| `agent:limit` | quota épuisé / reprise |

Filets de sécurité côté client : sondage lent (20 s) en plus des événements, et **jamais de
rechargement pendant que l'utilisateur tape** dans une carte (le rechargement est marqué « dû » et
passé au blur — sinon les caractères tapés pendant l'aller-retour disparaissaient).

---

## 3. Prérequis techniques

- CLI `claude` installé et authentifié sur la machine du serveur (chemin en dur :
  `/home/ec2-user/.local/bin/claude`, `HOME` forcé).
- Un utilisateur système dont `HOME` porte la session Claude ; `cwd` = racine du repo à modifier.
- `setsid` (util-linux) pour détacher l'exécution du sous-arbre du serveur.
- SQLite (better-sqlite3), Express, `ws`, JWT pour l'auth.
- Webhook Slack (`SLACK_WEBHOOK_PERSO`) pour le recap — optionnel, absent = pas de recap.
- Variables : `APP_URL` (liens du recap), `AGENT_INTERNAL_SECRET` (sous-tâches créées par l'agent),
  `REALTIME_ENABLED=true`.
- Convention datetime du projet : **tout en ISO UTC avec `Z`**, en SQL
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, en Node `new Date().toISOString()`.
- Soft deletes : `deleted_at`, jamais de `DELETE`.

Variables d'environnement posées sur chaque spawn : `ERP_AGENT_RUN=1` (les hooks Slack de
`~/.claude/settings.json` sortent en silence quand elle est là — sinon chaque tâche envoyait un
doublon de notification) et `ERP_AGENT_TASK_ID=<id>` (rend le hook de steering actif ; sans elle il
est inerte, donc inoffensif dans les sessions interactives).

---

## 4. Schéma de base de données

Pattern additif et idempotent, exécuté à chaque démarrage (`CREATE TABLE IF NOT EXISTS` +
`ALTER TABLE` dans un `try/catch`).

### `server/src/db/schema.js` — extrait (tables de la fonctionnalité)

Placé dans la fonction d'initialisation du schéma. La table `recurring_tasks` qui suivait dans l'original est retirée.

```js
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_prompts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      -- 'queued' = en attente de son tour ; 'running' = tâche agent en cours ;
      -- 'done'/'blocked' recopient le sort de la tâche agent ; 'paused' = mise de
      -- côté par l'utilisateur (jamais ramassée par l'ordonnanceur).
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','running','done','blocked','paused','cancelled')),
      position REAL NOT NULL DEFAULT 0,
      -- Enchaîne dans la MÊME session Claude que l'item précédent (--resume) au
      -- lieu de repartir d'un contexte neuf : pour les prompts qui poursuivent le
      -- travail du précédent. Le défaut (0) = contexte remis à zéro.
      same_context INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'implement' CHECK(mode IN ('implement','question')),
      preset TEXT NOT NULL DEFAULT 'deep',
      agent_task_id TEXT,
      -- Session Claude de l'exécution, pour que l'item suivant puisse la reprendre.
      session_id TEXT,
      suggestion_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      started_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_prompts_status ON work_prompts(status, position)`) } catch {}
  // Titre géré par l'app (déduit du prompt puis du fil de discussion) plutôt que
  // saisi à la main. Passe à 0 dès que l'utilisateur écrit son propre titre — un
  // titre choisi n'est JAMAIS réécrit. Défaut 0 : les items d'avant la
  // fonctionnalité gardent le leur, seul un item créé sans titre devient dynamique.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Question posée par l'agent à la fin d'une exécution, en JSON : { question, options[] }.
  // Une tâche détachée n'a pas de terminal — elle ne peut pas demander « laquelle des
  // deux ? » et devinait. Elle écrit désormais sa question ici, la carte l'affiche avec
  // ses choix, et un clic répond via le fil (ce qui relance la tâche). NULL = rien à
  // répondre. Colonne plutôt qu'un statut : le CHECK ci-dessus ne se modifie pas sans
  // reconstruire la table, et « terminé + question en attente » est un état réel.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN pending_question TEXT`) } catch {}
  // « Arrête après celle-ci » : une fois cet item terminé, l'ordonnanceur se met en
  // pause au lieu d'enchaîner. Sert à borner la consommation de jetons Claude sans
  // avoir à surveiller la file (ex. la nuit, garder du quota pour l'équipe du matin).
  // 0 = enchaîne normalement.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN stop_after INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Deux files distinctes sur la même table : 'finance' (Espace finance → Travaux)
  // et 'agent' (section Agent → Travaux de l'agent). Chaque page ne montre que la
  // sienne ; l'exécuteur, lui, est partagé (une seule implémentation à la fois,
  // toutes files confondues).
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN space TEXT NOT NULL DEFAULT 'finance'`) } catch {}

  // Fil de discussion d'un item de la file : chaque tâche a SA conversation, qui
  // survit aux exécutions successives (une relance crée une nouvelle tâche agent,
  // pas un nouveau fil). C'est ce qui permet de répondre à une demande de précision
  // depuis l'ERP, et de garder la trace même quand la session Claude a été purgée —
  // le fil est alors réinjecté en résumé dans le prompt de la relance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_prompt_messages (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL REFERENCES work_prompts(id),
      role TEXT NOT NULL CHECK(role IN ('user','agent')),
      text TEXT NOT NULL,
      -- Tâche agent qui a produit le message (côté agent) ou qu'il a déclenchée
      -- (côté humain) : permet de relier un tour de conversation à son exécution.
      agent_task_id TEXT,
      author TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_prompt_msgs ON work_prompt_messages(prompt_id, created_at)`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_suggestions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rationale TEXT,
      prompt TEXT NOT NULL,
      area TEXT,
      -- 'chantier'    = un travail à faire dans l'ERP tel qu'il est ;
      -- 'integration' = un logiciel / une API externe à brancher (ce que ça
      --                 débloquerait). Deux moteurs distincts, une seule liste.
      kind TEXT NOT NULL DEFAULT 'chantier',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','accepted','dismissed')),
      -- Empreinte de déduplication : une même recommandation ne revient pas à
      -- chaque passage du moteur, même après avoir été rejetée.
      fingerprint TEXT NOT NULL,
      work_prompt_id TEXT,
      dismissed_reason TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`ALTER TABLE work_suggestions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chantier'`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_suggestions_fp ON work_suggestions(fingerprint)`) } catch {}

  // Idées (onglet « Idées ») : le carnet de l'utilisateur. Rien ne s'exécute
  // jamais depuis cette liste — une idée est là pour être gardée et relue, pas
  // pour être faite. Elle ne rejoint la file que par une promotion explicite,
  // et y arrive « de côté » (voir promoteIdea dans workIdeas.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      -- Développement libre de l'idée (le « pourquoi », les pistes…).
      notes TEXT,
      -- Thème libre saisi par l'utilisateur, purement pour regrouper l'œil.
      tag TEXT,
      -- Ordre du carnet, réordonnable à la main comme la file.
      position REAL NOT NULL DEFAULT 0,
      -- Item de file créé par une promotion, pour ne pas promouvoir deux fois.
      work_prompt_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_ideas_pos ON work_ideas(position)`) } catch {}
```

---

## 5. Backend — la file (`services/promptQueue.js`)

Le cœur métier : ordre, statuts, fil de discussion, steering, recap Slack, réconciliation. **837 lignes, complet.**

```js
// File de prompts (page /travaux, onglet « Ma file »).
//
// Remplace le va-et-vient manuel « je colle un prompt → j'attends → /clear → le
// suivant » : les prompts vivent en DB, le serveur en pousse UN à la fois dans
// l'ordonnanceur de l'agent (taskRunner), et chaque exécution part d'un contexte
// neuf — sauf les items marqués « même contexte », qui reprennent la session
// Claude du précédent via --resume. À la fin de chaque item, un recap part dans le
// DM Slack perso : c'est ce qui permet de ne plus surveiller le terminal.
//
// Un seul item « running » à la fois, garanti par advanceQueue() : l'agent n'a
// qu'un slot d'exécution (il édite l'arbre de travail réel, sans isolation).
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import {
  enqueueAgentTask, findAgentTask, getSettings, presetFor, getMaxParallelQuestions,
  generateUserSummary, isQueuePaused, setQueuePaused,
  updatePendingAgentTask, cancelPendingAgentTask, sendSteeringMessage,
} from './taskRunner.js'
import { heuristicTitle, refineTitle, refineProjectTitle } from './promptTitle.js'

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')

// Items dont l'exécution avec --resume a échoué et qui ont déjà été relancés à
// contexte neuf : évite une boucle si la reprise de session échoue en boucle.
// Volontairement en mémoire — un redémarrage remet le droit à un essai, ce qui
// est sans danger (au pire une exécution de plus, jamais une boucle infinie).
const _resumeRetried = new Set()

// Questions (lecture seule) exécutables en parallèle. Doit rester ≤ la limite du
// runner (getMaxParallelQuestions) : au-delà, les items partiraient côté file mais
// attendraient un slot côté runner, et la page afficherait « en cours » à tort.
const MAX_PARALLEL_QUESTION_PROMPTS = getMaxParallelQuestions()

const SELECT = 'SELECT * FROM work_prompts WHERE deleted_at IS NULL'

// Deux files distinctes sur la même table : celle de l'Espace finance et celle de
// la section Agent. Chaque page ne voit que la sienne ; l'exécuteur est partagé.
export const PROMPT_SPACES = ['finance', 'agent']

export function listPrompts({ space = null } = {}) {
  // Un item qui attend une réponse passe devant la file : c'est le seul état où RIEN
  // n'avance sans l'utilisateur. Il serait sinon rangé dans l'historique (terminé /
  // bloqué), là où on ne regarde plus.
  const where = space ? ` AND space=?` : ''
  return db.prepare(`${SELECT}${where} ORDER BY
    CASE WHEN pending_question IS NOT NULL AND status NOT IN ('running','cancelled') THEN 0
         ELSE CASE status WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END END,
    position, created_at`).all(...(space ? [space] : []))
}

export function getPrompt(id) {
  return db.prepare(`${SELECT} AND id=?`).get(id) || null
}

// Les positions vivent PAR FILE : chaque page réordonne la sienne sans bousculer
// l'autre. Entre files, l'ordonnanceur départage par position puis created_at.
function nextPosition(space) {
  const row = db.prepare(`SELECT MAX(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND space=?`).get(space)
  return (row?.m ?? 0) + 1
}

// « Prioritaire » coché à la création : l'item se dépose DEVANT la file, comme le
// bouton « Passer en premier » d'une carte existante. On calcule la position ici
// plutôt que d'appeler moveToFront après coup — celui-ci force le statut à
// 'queued', ce qui réveillerait un item déposé en pause (brouillon, item de test).
function frontPosition(space) {
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status='queued' AND space=?`).get(space)
  return (row?.m ?? 1) - 1
}

function broadcast() { broadcastAll({ type: 'travaux:prompts:updated' }) }

export function createPrompt({
  title = '', prompt, mode = 'implement', preset = 'deep',
  same_context = 0, created_by = null, suggestion_id = null, status = 'queued',
  priority = false, space = 'finance',
}) {
  const text = String(prompt || '').trim()
  if (!text) throw new Error('prompt requis')
  const id = randomUUID()
  // Titre absent = titre automatique : l'heuristique tout de suite (déterministe),
  // puis un titre modèle quelques secondes plus tard s'il tient la route. Un titre
  // saisi à la main n'est jamais touché.
  const given = String(title || '').trim()
  const label = given || heuristicTitle(text)
  // 'paused' à la création = déposé sans partir tout de suite (brouillon, ou item
  // de test qui ne doit jamais déclencher d'exécution réelle).
  const initial = status === 'paused' ? 'paused' : 'queued'
  const inSpace = PROMPT_SPACES.includes(space) ? space : 'finance'
  db.prepare(`
    INSERT INTO work_prompts (id, title, prompt, status, position, same_context, mode, preset, suggestion_id, created_by, title_auto, space)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, label, text, initial, priority ? frontPosition(inSpace) : nextPosition(inSpace), same_context ? 1 : 0,
    mode === 'question' ? 'question' : 'implement', preset, suggestion_id, created_by,
    given ? 0 : 1, inSpace)
  broadcast()
  if (!given) scheduleTitleRefine(id, text, label)
  return getPrompt(id)
}

/**
 * Deuxième étage du titre automatique. Volontairement hors du chemin de réponse :
 * l'ajout à la file reste instantané et la carte se renomme toute seule par la
 * diffusion temps réel. On n'écrase que si le titre est resté celui de
 * l'heuristique — une retouche manuelle entre-temps gagne toujours.
 */
function scheduleTitleRefine(id, text, provisional) {
  refineTitle(text)
    .then(better => {
      if (!better || better === provisional) return
      const row = getPrompt(id)
      if (!row || !row.title_auto || row.title !== provisional) return
      db.prepare(`UPDATE work_prompts SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(better, id)
      broadcast()
    })
    .catch(e => console.error('🤖 File de travaux: titre automatique —', e.message))
}

// ─── Titre dynamique du projet ────────────────────────────────────────────────
// Un item de la file EST un projet : sa demande d'origine plus le fil qui la
// précise. Le titre est donc re-déduit du fil à chaque fois que le projet bouge
// (réponse de l'humain, compte-rendu de l'agent, prompt réécrit) — mais seulement
// tant qu'il est automatique. Dès que l'utilisateur écrit son propre titre,
// title_auto passe à 0 et plus rien ne le touche ; vider le champ le rend au mode
// automatique.
const _refining = new Set()

function scheduleProjectTitleRefine(id) {
  if (_refining.has(id)) return              // un seul passage à la fois par projet
  const row = getPrompt(id)
  if (!row || !row.title_auto) return
  _refining.add(id)
  const before = row.title
  refineProjectTitle({ prompt: row.prompt, messages: listMessages(id), current: before })
    .then(better => {
      if (!better || better === before) return
      // Rien n'a bougé entre-temps ? (retouche manuelle, autre passage, suppression)
      const fresh = getPrompt(id)
      if (!fresh || !fresh.title_auto || fresh.title !== before) return
      db.prepare(`UPDATE work_prompts SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(better, id)
      broadcast()
    })
    .catch(e => console.error('🤖 File de travaux: titre dynamique —', e.message))
    .finally(() => _refining.delete(id))
}

const EDITABLE = ['title', 'prompt', 'mode', 'preset', 'same_context', 'status', 'position', 'stop_after']

// ─── Items « en attente » : remis à l'ordonnanceur, mais pas encore démarrés ───
//
// Un item passe « running » dès qu'il est confié au runner — or celui-ci ne démarre
// qu'une implémentation à la fois. Entre les deux, l'item ne fait RIEN : il attend
// son tour. Le figer (prompt en lecture seule, ordre verrouillé, impossible de le
// mettre de côté) n'avait donc aucune justification, et bloquait la file dès que
// deux items étaient poussés coup sur coup.
//
// Deux traitements, selon ce qu'on touche :
//   • du texte / des réglages → on retouche la tâche en place (pas de va-et-vient) ;
//   • l'ordre, le statut, la suppression → on la reprend à l'ordonnanceur, l'item
//     redevient « en file » et repartira par le chemin normal.
// Les deux refusent dès que l'exécution a réellement commencé.

/** Vrai si l'item est confié au runner mais n'a pas encore démarré. */
function isPending(row) {
  if (!row || row.status !== 'running' || !row.agent_task_id) return false
  const task = findAgentTask(row.agent_task_id)
  return !!task && task.status === 'approved'
}

/**
 * Reprend l'item à l'ordonnanceur et le remet « en file » à sa place.
 * Retourne la ligne à jour, ou `row` inchangée si l'exécution a déjà commencé.
 */
function reclaimPending(row) {
  if (!isPending(row)) return row
  if (!cancelPendingAgentTask(row.agent_task_id)) return row
  db.prepare(`
    UPDATE work_prompts
    SET status='queued', agent_task_id=NULL, started_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(row.id)
  return getPrompt(row.id)
}

/** Répercute une retouche de texte / réglages sur la tâche pas encore démarrée. */
function syncPendingTask(row) {
  if (!isPending(row)) return
  const { model, effort } = presetFor(row.preset)
  updatePendingAgentTask(row.agent_task_id, {
    title: row.title, description: row.prompt, mode: row.mode, model, effort,
  })
}

export function updatePrompt(id, patch) {
  let row = getPrompt(id)
  if (!row) return null
  // Mettre de côté / réordonner un item pas encore démarré : on le reprend d'abord,
  // sinon le garde-fou « les états d'exécution appartiennent au runner » l'en empêche.
  if (patch.status !== undefined || patch.position !== undefined) row = reclaimPending(row) || row
  const sets = []
  const vals = []
  // Champ titre vidé = « rends-le automatique » : on repose l'heuristique tout de
  // suite (jamais de carte sans titre) et le fil reprend la main juste après.
  let backToAuto = false
  let frozen = false
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k)) continue
    // Le statut n'est pilotable à la main que pour mettre de côté / remettre en
    // file : les états d'exécution appartiennent au runner.
    if (k === 'status' && !['queued', 'paused', 'cancelled'].includes(v)) continue
    if (k === 'status' && row.status === 'running') continue
    if (k === 'title') {
      const given = String(v ?? '').trim()
      backToAuto = !given
      frozen = !!given
      sets.push('title=?', 'title_auto=?')
      vals.push(given || heuristicTitle(patch.prompt ?? row.prompt), given ? 0 : 1)
      continue
    }
    sets.push(`${k}=?`)
    vals.push(['same_context', 'stop_after'].includes(k) ? (v ? 1 : 0) : v)
  }
  if (!sets.length) return row
  db.prepare(`UPDATE work_prompts SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...vals, id)
  broadcast()
  // Le prompt réécrit change la nature du projet → titre re-déduit, sauf s'il vient
  // d'être figé à la main dans le même PATCH.
  if (backToAuto || (!frozen && patch.prompt !== undefined)) scheduleProjectTitleRefine(id)
  const updated = getPrompt(id)
  // Item encore en attente : ce qu'on vient de réécrire doit être ce qui partira.
  syncPendingTask(updated)
  return updated
}

export function deletePrompt(id) {
  const row = getPrompt(id)
  if (!row) return false
  // Retirer un item pas encore démarré doit aussi le retirer de l'ordonnanceur,
  // sinon il partirait quand même une fois le poste libre.
  const wasPending = isPending(row)
  if (wasPending) reclaimPending(row)
  db.prepare(`UPDATE work_prompts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  broadcast()
  // Le poste qu'il occupait est libre : au suivant.
  if (wasPending) advanceQueue()
  return true
}

/** Réordonne la file : le tableau d'ids donne l'ordre voulu, les absents restent après. */
export function reorderPrompts(ids) {
  // Les items en attente reviennent en file avant d'être renumérotés : leur ordre de
  // départ redevient celui de la page (l'ordonnanceur, lui, sert premier arrivé).
  let reclaimed = false
  for (const id of ids) {
    const row = getPrompt(id)
    if (!isPending(row)) continue
    reclaimPending(row)
    reclaimed = true
  }
  const run = db.transaction(() => {
    ids.forEach((id, i) => {
      db.prepare(`UPDATE work_prompts SET position=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(i + 1, id)
    })
  })
  run()
  broadcast()
  // Rendre à l'ordonnanceur ce qu'on vient de lui reprendre, dans le nouvel ordre.
  // Uniquement dans ce cas : un simple changement de priorité ne doit RIEN lancer.
  if (reclaimed) advanceQueue()
  return listPrompts()
}

/** Remet un item en tête de file (bouton « Passer en premier »). */
export function moveToFront(id) {
  const target = getPrompt(id)
  if (!target) return null
  reclaimPending(target)
  // « Premier » = premier de SA file : l'autre file garde son ordre.
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status='queued' AND space=?`).get(target.space)
  db.prepare(`UPDATE work_prompts SET position=?, status='queued', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','paused')`)
    .run((row?.m ?? 1) - 1, id)
  broadcast()
  return getPrompt(id)
}

// ─── Ordonnancement ───────────────────────────────────────────────────────────

/**
 * État de la pause manuelle de la file, tel que rendu à la page.
 * `reason` porte le « pourquoi » quand la pause a été posée automatiquement par un
 * item marqué « arrêter après celle-ci ».
 */
export function getQueuePauseState() {
  const s = getSettings()
  return {
    paused: !!s.queuePaused,
    paused_at: s.queuePausedAt || null,
    reason: s.queuePausedReason || null,
  }
}

/**
 * Pause / reprise de la file. Aucune exécution n'est tuée : la pause empêche
 * seulement les DÉPARTS, donc reprendre relance simplement le prochain item — rien
 * n'a été refait, rien n'a été perdu.
 */
export function pauseQueue({ reason = null } = {}) {
  const state = setQueuePaused(true, { reason })
  broadcast()
  return { paused: state.paused, paused_at: state.pausedAt, reason: state.reason }
}

export function resumeQueue() {
  setQueuePaused(false)
  broadcast()
  const out = advanceQueue()
  return { ...getQueuePauseState(), started: out.started ? out.started.prompt : null, startedCount: out.startedCount }
}

/**
 * Démarre le prochain item si rien ne tourne. Retourne { started, reason } :
 * `reason` explique une non-exécution ('busy' | 'agent-disabled' | 'queue-paused' |
 * 'empty') pour que la page puisse le dire clairement au lieu de laisser croire à un
 * blocage.
 */
export function advanceQueue() {
  // 1. Réconciliation : un item resté « running » alors que sa tâche a disparu ou
  // s'est terminée (redémarrage serveur pendant l'exécution) ne doit pas geler la
  // file pour toujours. Vaut pour les deux voies.
  for (const running of db.prepare(`${SELECT} AND status='running' ORDER BY started_at`).all()) {
    const task = running.agent_task_id ? findAgentTask(running.agent_task_id) : null
    if (!task) {
      finishPrompt(running.id, { status: 'blocked', agent_result: '(tâche introuvable — exécution perdue)', user_summary: null, session_id: null })
    } else if (['done', 'blocked', 'cancelled'].includes(task.status)) {
      finishPrompt(running.id, task)
      // Clôture par réconciliation : onAgentTaskFinalized n'a pas tourné (redémarrage
      // en pleine exécution) → le fil n'a aucune réponse. On la verse a posteriori.
      setImmediate(() => { repairAgentReplies(running.id).catch(() => {}) })
    }
  }

  // 2. Pause posée à la main (ou par un item « arrêter après celle-ci ») : la
  // réconciliation ci-dessus a quand même tourné — un item fauché par un redémarrage
  // ne doit pas rester « en cours » pour l'éternité juste parce que la file dort.
  if (isQueuePaused()) return { started: null, startedCount: 0, reason: 'queue-paused' }

  if (!getSettings().enabled) return { started: null, startedCount: 0, reason: 'agent-disabled' }

  const runningRows = db.prepare(`${SELECT} AND status='running'`).all()
  const runningQuestions = runningRows.filter(r => r.mode === 'question').length
  const implRunning = runningRows.some(r => r.mode !== 'question')

  const started = []

  // 2. Questions : lecture seule → plusieurs à la fois, même pendant un chantier.
  // Un item marqué « même contexte » est volontairement exclu de la voie parallèle :
  // il doit reprendre la session de son prédécesseur, donc attendre son tour.
  const slots = MAX_PARALLEL_QUESTION_PROMPTS - runningQuestions
  if (slots > 0) {
    const questions = db.prepare(`${SELECT} AND status='queued' AND mode='question' AND same_context=0 ORDER BY position, created_at LIMIT ?`).all(slots)
    for (const q of questions) started.push(startPrompt(q))
  }

  // 3. Implémentation : une seule à la fois (elle édite l'arbre de travail réel).
  // Les positions vivent PAR FILE (finance / agent) : comparer les positions brutes
  // entre files n'aurait aucun sens. On prend donc le prochain candidat de CHAQUE
  // file selon son propre ordre, puis premier arrivé premier servi entre les files.
  if (!implRunning) {
    const next = PROMPT_SPACES
      .map(sp => db.prepare(`${SELECT} AND status='queued' AND space=? AND (mode!='question' OR same_context=1) ORDER BY position, created_at LIMIT 1`).get(sp))
      .filter(Boolean)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0]
    if (next) started.push(startPrompt(next))
  }

  if (!started.length) {
    const anyQueued = db.prepare(`SELECT 1 FROM work_prompts WHERE deleted_at IS NULL AND status='queued' LIMIT 1`).get()
    return { started: null, startedCount: 0, reason: anyQueued ? 'busy' : 'empty' }
  }
  return { started: started[0], startedCount: started.length, reason: null }
}

/**
 * Session Claude à reprendre pour un item « même contexte » : celle de l'item qui
 * le précède dans la file (par position). On ne prend PAS « le dernier terminé » :
 * avec la voie parallèle, une question terminée entre-temps volerait le contexte.
 */
function sessionOfPrevious(row) {
  // Scopé à la même file : un item « même contexte » de la file Agent ne doit
  // jamais reprendre la session d'un item de la file finance (et inversement).
  const prev = db.prepare(`
    SELECT session_id FROM work_prompts
    WHERE deleted_at IS NULL AND session_id IS NOT NULL AND space = ?
      AND (position < ? OR (position = ? AND created_at < ?))
    ORDER BY position DESC, created_at DESC LIMIT 1
  `).get(row.space, row.position, row.position, row.created_at)
  return prev?.session_id || null
}

function startPrompt(row, { forceFresh = false } = {}) {
  const { model, effort } = presetFor(row.preset)
  const resume = (!forceFresh && row.same_context) ? sessionOfPrevious(row) : null
  const task = enqueueAgentTask({
    title: row.title,
    description: row.prompt,
    kind: 'queue',
    mode: row.mode,
    model, effort,
    author: 'File de travaux',
    work_prompt_id: row.id,
    resume_session_id: resume,
  })
  db.prepare(`
    UPDATE work_prompts
    SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(task.id, row.id)
  broadcast()
  return { prompt: getPrompt(row.id), task }
}

function finishPrompt(id, task) {
  const status = task.status === 'done' ? 'done' : 'blocked'
  // La question éventuelle est posée sur l'item (pas sur la tâche agent, qui vit dans
  // agent-tasks.json et disparaît de la vue) : c'est la carte qui doit la montrer et
  // récolter le clic. Écrasée à chaque fin d'exécution — une exécution qui n'en pose
  // plus efface celle d'avant.
  const q = task.pending_question && task.pending_question.question
    ? JSON.stringify(task.pending_question)
    : null
  db.prepare(`
    UPDATE work_prompts
    SET status=?, session_id=COALESCE(?, session_id), pending_question=?,
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(status, task.session_id || null, q, id)
  broadcast()
  return getPrompt(id)
}

// ─── Fil de discussion par tâche ──────────────────────────────────────────────
// Chaque item de la file porte SA conversation. Elle survit aux exécutions
// successives et — surtout — au fait que la session Claude puisse avoir disparu :
// une relance réinjecte le fil en clair dans le prompt (voir buildFollowUpPrompt),
// donc la continuité ne dépend jamais de --resume.

export function listMessages(promptId) {
  return db.prepare(`
    SELECT m.*, u.name AS author_name
    FROM work_prompt_messages m
    LEFT JOIN users u ON u.id = m.author
    WHERE m.prompt_id=? ORDER BY m.created_at
  `).all(promptId)
}

function addMessage(promptId, { role, text, agentTaskId = null, author = null }) {
  const clean = String(text || '').trim()
  if (!clean) return null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_prompt_messages (id, prompt_id, role, text, agent_task_id, author)
    VALUES (?,?,?,?,?,?)
  `).run(id, promptId, role, clean, agentTaskId, author)
  broadcast()
  return db.prepare('SELECT * FROM work_prompt_messages WHERE id=?').get(id)
}

/**
 * Prompt d'une relance : la demande d'origine, ce que l'agent a répondu jusqu'ici,
 * et le fil complet. Volontairement autoportant — même si --resume échoue ou que la
 * session a été purgée, la relance sait de quoi on parle.
 */
export function buildFollowUpPrompt(row, messages) {
  const thread = messages
    .map(m => `${m.role === 'user' ? 'Humain' : 'Toi'} : ${m.text}`)
    .join('\n\n')
  return [
    'Suite d\'un échange sur une tâche de la file de travaux. Le contexte ci-dessous est ',
    'peut-être déjà dans ta session ; s\'il ne l\'est pas, il suffit à reprendre le travail.\n\n',
    `=== DEMANDE INITIALE ===\n${row.prompt}\n\n`,
    `=== ÉCHANGE ===\n${thread}\n\n`,
    '=== À FAIRE MAINTENANT ===\n',
    'Réponds au DERNIER message de l\'humain et poursuis la tâche en conséquence. ',
    'Si une information te manque encore, dis précisément laquelle plutôt que de deviner.',
  ].join('')
}

/**
 * Réponse de l'humain dans le fil → relance immédiate de la tâche avec ce
 * complément. La session précédente est reprise quand elle existe (contexte
 * intact) ; sinon le fil réinjecté fait office de mémoire.
 * Refusée pendant une exécution : le message serait perdu (l'exécution en cours ne
 * le lirait pas). L'appelant reçoit { error: 'running' } pour le dire clairement.
 */
export function replyToPrompt(id, { text, userId = null }) {
  const row = getPrompt(id)
  if (!row) return null
  if (row.status === 'running') return { error: 'running' }
  const clean = String(text || '').trim()
  if (!clean) return { error: 'empty' }

  addMessage(id, { role: 'user', text: clean, author: userId })
  const out = relaunchWithThread(row)
  // Le projet vient de bouger : c'est le moment le plus fort pour renommer, car la
  // réponse de l'humain donne le cap réel (élargissement, changement de direction).
  scheduleProjectTitleRefine(id)
  return out
}

/**
 * Relance un item avec son fil complet en contexte (le dernier message de l'humain
 * y est déjà). Chemin partagé par la réponse classique (replyToPrompt) et la
 * rattrapage d'un message de steering arrivé trop tard pour être lu en direct.
 */
function relaunchWithThread(row) {
  const messages = listMessages(row.id)
  const { model, effort } = presetFor(row.preset)
  const task = enqueueAgentTask({
    title: row.title,
    description: buildFollowUpPrompt(row, messages),
    kind: 'queue',
    mode: row.mode,
    model, effort,
    author: 'File de travaux (suite)',
    work_prompt_id: row.id,
    resume_session_id: row.session_id || null,
  })
  db.prepare(`
    UPDATE work_prompts
    SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at=NULL, pending_question=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(task.id, row.id)
  broadcast()
  return { prompt: getPrompt(row.id), task }
}

/**
 * Message envoyé PENDANT que la tâche tourne (steering, comme dans Claude Code).
 * Deux livraisons selon l'état réel de la tâche agent :
 *   • 'in_progress' → déposé dans l'inbox de l'exécution, le hook le glisse à
 *     Claude après le prochain outil ('live') ;
 *   • 'approved' (remise à l'ordonnanceur, pas démarrée) → ajouté au brief de la
 *     tâche, il partira avec elle ('queued').
 * Dans les deux cas le message entre au fil — il fait partie de la conversation.
 * Retour { error: 'not-running' } si la tâche a en fait rendu la main : c'est
 * replyToPrompt (relance) qui s'applique alors.
 */
export function steerPrompt(id, { text, userId = null }) {
  const row = getPrompt(id)
  if (!row) return null
  const clean = String(text || '').trim()
  if (!clean) return { error: 'empty' }
  if (row.status !== 'running' || !row.agent_task_id) return { error: 'not-running' }
  const task = findAgentTask(row.agent_task_id)
  if (!task) return { error: 'not-running' }

  // Livraison d'abord, trace au fil ensuite : si la tâche vient de rendre la main
  // entre le chargement de la page et l'envoi, rien n'est écrit et l'appelant
  // peut proposer « Répondre et relancer » à la place.
  if (task.status === 'in_progress' && sendSteeringMessage(row.agent_task_id, clean)) {
    addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
    return { prompt: getPrompt(id), delivered: 'live' }
  }
  if (task.status === 'approved') {
    const marked = `${task.description}\n\n=== MESSAGE DE L'UTILISATEUR (ajouté pendant l'attente, à prendre en compte) ===\n${clean}`
    if (updatePendingAgentTask(row.agent_task_id, { description: marked })) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
      return { prompt: getPrompt(id), delivered: 'queued' }
    }
    // La tâche a démarré entre les deux lectures : on retente la voie directe.
    if (sendSteeringMessage(row.agent_task_id, clean)) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
      return { prompt: getPrompt(id), delivered: 'live' }
    }
  }
  return { error: 'not-running' }
}

/**
 * Texte versé dans le fil (et repris dans le recap Slack) à la fin d'une exécution.
 *
 * Le compte-rendu vulgarisé arrive par deux chemins : la section « RÉSUMÉ UTILISATEUR »
 * du rapport (immédiate), ou la génération de secours quand le modèle l'a oubliée
 * (quelques secondes plus tard, en subprocess). Ce deuxième chemin étant asynchrone,
 * lire task.user_summary à chaud figeait un « (terminé sans compte-rendu) » dans le
 * fil alors que le vrai compte-rendu atterrissait juste après sur la tâche. On l'attend
 * donc ici, et à défaut on rend le rapport technique — jamais un placeholder nu.
 */
export async function resolveReply(task) {
  let summary = (task.user_summary || '').trim()
  if (!summary) {
    try { await generateUserSummary(task.id) } catch { /* le repli ci-dessous prend la main */ }
    summary = (findAgentTask(task.id)?.user_summary || '').trim()
  }
  if (summary) return summary

  // Aucun compte-rendu possible (rapport vide, ou génération de secours en échec) :
  // on rend ce qu'on a plutôt que rien — le rapport brut vaut mieux qu'un silence.
  const report = (task.agent_result || '').trim()
  const clean = report && report !== '(terminé sans rapport)' ? report : ''
  if (clean) {
    const excerpt = clean.length > 2500 ? `…${clean.slice(-2500)}` : clean
    const head = task.status === 'done'
      ? 'Compte-rendu vulgarisé indisponible — voici le rapport technique brut :'
      : 'Exécution interrompue, sans compte-rendu — voici le rapport technique brut :'
    return `${head}\n\n${excerpt}`
  }
  return task.status === 'done'
    ? 'Terminé, mais l\'agent n\'a produit aucun rapport (exécution sans sortie exploitable). À relancer si le résultat n\'est pas visible dans l\'app.'
    : 'Exécution interrompue avant toute sortie (délai dépassé, processus tué ou redémarrage). À relancer.'
}

/**
 * Appelé par taskRunner quand une exécution se termine. Quatre responsabilités :
 * verser la réponse dans le fil, clore l'item, envoyer le recap Slack, lancer le suivant.
 */
export async function onAgentTaskFinalized(task) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return
  const row = getPrompt(task.work_prompt_id)
  if (!row) return

  // Reprise de session impossible (session purgée) : le run meurt sans rien
  // produire. On relance UNE fois à contexte neuf plutôt que de marquer bloqué.
  const producedNothing = !(task.agent_result || '').trim() && !(task.user_summary || '').trim()
  if (task.resume_session_id && task.status !== 'done' && producedNothing && !_resumeRetried.has(row.id)) {
    _resumeRetried.add(row.id)
    console.log(`🤖 File de travaux: reprise de session impossible pour « ${row.title} » — relance à contexte neuf`)
    startPrompt(row, { forceFresh: true })
    return
  }

  // Le compte-rendu entre dans le fil : c'est lui qui reste lisible (et réinjectable)
  // quand la session Claude a disparu. Le rapport technique reste sur la tâche agent.
  let reply = await resolveReply(task)
  // La question entre AUSSI dans le fil : la colonne pending_question est vidée dès
  // qu'on répond, et sans cette trace le fil montrerait une réponse sans sa question.
  // La carte n'affiche donc que les boutons de choix, pas une seconde fois le texte.
  if (task.pending_question?.question) reply += `\n\n❓ ${task.pending_question.question}`
  addMessage(row.id, { role: 'agent', text: reply, agentTaskId: task.id })

  const finished = finishPrompt(row.id, task)
  // Le compte-rendu vient d'entrer dans le fil : sur un projet qui a déjà tourné
  // plusieurs fois, il précise souvent mieux la nature du travail que la demande
  // d'origine. En arrière-plan — le recap Slack qui suit peut donc encore porter le
  // titre précédent, la carte, elle, se renomme dès que le modèle répond.
  if (row.title_auto && listMessages(row.id).length > 1) scheduleProjectTitleRefine(row.id)

  // « Arrête après celle-ci » : on pose la pause AVANT le recap et l'advanceQueue,
  // sinon l'item suivant partirait dans le même tick. Le drapeau est consommé (remis
  // à 0) pour qu'une relance de cet item plus tard ne remette pas la file en pause
  // sans qu'on l'ait redemandé.
  const stopHere = !!finished.stop_after
  if (stopHere) {
    db.prepare(`UPDATE work_prompts SET stop_after=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id)
    pauseQueue({ reason: `Arrêt demandé après « ${finished.title} »` })
    console.log(`🤖 File de travaux: pause demandée après « ${finished.title} » — la file reprendra sur commande`)
  }

  // Message de steering arrivé dans les dernières secondes de l'exécution : il est
  // au fil, mais Claude ne l'a jamais lu. On relance tout de suite avec le fil en
  // contexte — comme si l'utilisateur avait répondu après coup. Pas de recap ici :
  // le travail n'est pas fini, il viendra à la fin de la relance. Une pause
  // demandée (« arrête après celle-ci ») garde le dernier mot : pas de relance.
  if (!stopHere && String(task.missed_user_message || '').trim()) {
    console.log(`🤖 File de travaux: message utilisateur non lu par l'exécution — relance de « ${finished.title} »`)
    relaunchWithThread(finished)
    return
  }

  try { await sendRecap(finished, task, { stopped: stopHere }) } catch (e) { console.error('🤖 File de travaux: recap Slack en échec —', e.message) }
  advanceQueue()
}

/**
 * Exécution avortée faute de quota Claude (« session limit »). L'item n'a pas échoué :
 * il n'a pas travaillé. Il retourne donc en file à sa place, sans réponse dans le fil
 * ni recap — le runner rallume tout à la réinitialisation. Un seul avis Slack par
 * fenêtre de quota, pour ne pas transformer une pause en pluie de notifications.
 */
export function onAgentTaskDeferred(task, { label = '' } = {}) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return
  const row = getPrompt(task.work_prompt_id)
  if (!row) return
  db.prepare(`
    UPDATE work_prompts
    SET status='queued', started_at=NULL, agent_task_id=NULL, completed_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(row.id)
  broadcast()
  notifyLimitOnce(label)
}

let _limitNotified = ''

async function notifyLimitOnce(label) {
  if (_limitNotified === label) return
  _limitNotified = label
  const url = process.env.SLACK_WEBHOOK_PERSO
  if (!url) return
  // Même règle que le recap : une ligne, rien à faire de plus que la lire.
  const text = `:hourglass_flowing_sand: *File de travaux en pause* — limite de session Claude atteinte, ` +
    `reprise à ${label || 'la réinitialisation du quota'}.`
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch (e) { console.error('🤖 File de travaux: avis de quota non envoyé —', e.message) }
}

// ─── Réparation des réponses manquantes ───────────────────────────────────────
// Deux dégâts possibles dans un fil : un placeholder figé (compte-rendu de secours
// arrivé après l'écriture du message — le bug d'origine) ou aucune réponse du tout
// (exécution close par réconciliation après un redémarrage). Les deux se réparent
// depuis la tâche agent, qui garde rapport et compte-rendu. Idempotent.
const PLACEHOLDERS = ['(terminé sans compte-rendu)', '(bloqué sans explication)']

// Sérialisé : plusieurs réconciliations peuvent la déclencher dans le même tick, et
// deux passages concurrents inséreraient deux fois la même réponse (chacun lisant le
// fil avant l'écriture de l'autre).
let _repairing = null

export function repairAgentReplies(promptId = null) {
  if (_repairing) return _repairing.then(() => runRepair(promptId))
  _repairing = runRepair(promptId).finally(() => { _repairing = null })
  return _repairing
}

async function runRepair(promptId = null) {
  let fixed = 0

  // 0. Doublons exacts (même tâche, même texte) : une réponse versée deux fois n'apporte
  // rien et brouille le fil. On garde la première.
  const dupes = db.prepare(`
    DELETE FROM work_prompt_messages WHERE id IN (
      SELECT m.id FROM work_prompt_messages m
      WHERE m.role='agent' AND m.agent_task_id IS NOT NULL AND m.created_at > (
        SELECT MIN(o.created_at) FROM work_prompt_messages o
        WHERE o.prompt_id=m.prompt_id AND o.agent_task_id=m.agent_task_id AND o.text=m.text
      )
    )
  `).run()
  if (dupes.changes) fixed += dupes.changes

  // 1. Placeholders figés — on part des MESSAGES (une même carte peut avoir plusieurs
  // exécutions, donc plusieurs réponses ; seule la dernière est pointée par la carte).
  const stuck = db.prepare(`
    SELECT m.id, m.agent_task_id FROM work_prompt_messages m
    WHERE m.role='agent' AND m.agent_task_id IS NOT NULL
      AND m.text IN (${PLACEHOLDERS.map(() => '?').join(',')})
      ${promptId ? 'AND m.prompt_id=?' : ''}
  `).all(...PLACEHOLDERS, ...(promptId ? [promptId] : []))
  for (const msg of stuck) {
    const task = findAgentTask(msg.agent_task_id)
    if (!task) continue
    const text = await resolveReply(task)
    if (!text || PLACEHOLDERS.includes(text)) continue
    db.prepare(`UPDATE work_prompt_messages SET text=? WHERE id=?`).run(text, msg.id)
    fixed++
  }

  // 2. Réponse absente : exécution close par réconciliation (redémarrage) — le fil n'a
  // rien reçu pour cette tâche.
  const rows = db.prepare(`${SELECT} AND status IN ('done','blocked') AND agent_task_id IS NOT NULL${promptId ? ' AND id=?' : ''}`)
    .all(...(promptId ? [promptId] : []))
  for (const row of rows) {
    const has = () => db.prepare(`SELECT 1 FROM work_prompt_messages WHERE prompt_id=? AND role='agent' AND agent_task_id=? LIMIT 1`)
      .get(row.id, row.agent_task_id)
    if (has()) continue
    const task = findAgentTask(row.agent_task_id)
    if (!task) continue
    const text = await resolveReply(task)
    if (!text || has()) continue        // re-vérifié après l'attente : anti-doublon
    addMessage(row.id, { role: 'agent', text, agentTaskId: row.agent_task_id })
    fixed++
  }

  if (fixed) {
    broadcast()
    console.log(`🤖 File de travaux: ${fixed} compte-rendu(s) de fil réparé(s)`)
  }
  return fixed
}

// ─── Recap Slack ──────────────────────────────────────────────────────────────

// UNE SEULE LIGNE, volontairement : le DM sert à savoir qu'une tâche est finie (ou
// qu'une question attend), pas à raconter le travail. Le compte-rendu vit dans le
// fil de la carte, dans l'ERP — c'est là qu'on le lit. Une version qui recopiait le
// compte-rendu complet a été essayée puis retirée (même raison que le hook
// ~/.claude/slack-notify.sh) : ne pas la réintroduire.
export function buildRecapMessage(prompt, task, { stopped = false } = {}) {
  const ok = prompt.status === 'done'
  // Une question en attente change la nature du message : ce n'est plus une fin à
  // constater, c'est une action à faire pour que le travail reprenne.
  const asking = !!task?.pending_question?.question
  const head = asking
    ? `:raised_hand: *Question à répondre* — ${prompt.title}`
    : `${ok ? ':white_check_mark:' : ':warning:'} *${ok ? 'Tâche terminée' : 'Tâche bloquée'}* — ${prompt.title}`
  const cta = asking ? 'Répondre' : 'Ouvrir'
  // Pause demandée sur cet item : sans ce mot, le silence de la file ressemble à
  // une panne. C'est le seul complément admis sur la ligne.
  const pause = stopped ? ' · file en pause' : ''
  return `${head} · <${APP_URL}/erp/travaux?onglet=file|${cta}>${pause}`
}

async function sendRecap(prompt, task, { stopped = false } = {}) {
  const url = process.env.SLACK_WEBHOOK_PERSO
  if (!url) {
    console.warn('🤖 File de travaux: SLACK_WEBHOOK_PERSO absent — recap non envoyé')
    return
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: buildRecapMessage(prompt, task, { stopped }) }),
  })
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`)
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
// Au boot, on réconcilie et on relance la file (un item « running » fauché par un
// redémarrage est clos par advanceQueue, puis le suivant démarre).
export function initPromptQueue() {
  const timer = setTimeout(() => {
    try { advanceQueue() } catch (e) { console.error('🤖 File de travaux: démarrage —', e.message) }
    repairAgentReplies().catch(e => console.error('🤖 File de travaux: réparation des compte-rendus —', e.message))
  }, 20_000)
  timer.unref?.()
}
```

---

## 6. Backend — l'exécuteur (`services/taskRunner.js`)

Slot d'exécution unique + voie parallèle lecture seule, spawn détaché du CLI `claude`, streaming, détection de quota et repli de modèle, extraction du rapport / du compte-rendu / de la question, reprise après redémarrage. **Complet** (contient aussi le circuit « bulle d'aide » — voir §10.6 pour ce qui est retirable).

```js
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { broadcastAll } from './realtime.js'
import { AGENT_INTERNAL_SECRET } from '../config/secrets.js'
import {
  AGENT_MODEL, KNOWN_MODELS, modelChain, resolveModel, chainAvailableAt,
  noteModelLimit, nextLimitExpiryAt, purgeExpiredLimits, fetchLimitScope,
  syncScopedModelLimit, agentModelState,
} from './agentModel.js'

// ─── Paths (must match what the running server already uses) ──────────────────
// Resolves to the repo root /home/ec2-user/erp/ (versioned + backed up by WIP snapshots).
const TASKS_FILE    = resolve(fileURLToPath(import.meta.url), '../../../../agent-tasks.json')
const TASKS_TMP     = TASKS_FILE + '.tmp'
const DATA_DIR      = dirname(TASKS_FILE)
const BACKLOG_FILE  = resolve(DATA_DIR, 'agent-backlog.json')
const SETTINGS_FILE = resolve(DATA_DIR, 'agent-settings.json')
const PID_FILE      = resolve(fileURLToPath(import.meta.url), '../../../../.agent-pid')
// Voie lecture seule : un fichier PID PAR tâche (plusieurs questions tournent en
// parallèle, un fichier unique serait écrasé et le suivi viserait le mauvais
// process). Volontairement distinct de .agent-pid, que deploy.sh surveille : une
// question ne modifie rien, elle ne doit pas retarder un déploiement.
const QPID_FILE     = id => resolve(fileURLToPath(import.meta.url), `../../../../.agent-qpid-${id}`)
const CLAUDE_BIN    = '/home/ec2-user/.local/bin/claude'
const CWD           = '/home/ec2-user/erp'

// Per-execution durable artifacts (ignored by git). The detached exec Claude writes
// its stream + exit code HERE, not to the parent's stdout pipe — so a `pm2 restart`
// (mandatory after server changes) can't lose the result or SIGPIPE-kill the child.
const EXEC_LOG    = id => resolve(DATA_DIR, `.agent-exec-${id}.log`)
const EXEC_CODE   = id => resolve(DATA_DIR, `.agent-exec-${id}.code`)
const EXEC_PROMPT = id => resolve(DATA_DIR, `.agent-exec-${id}.prompt`)
// Steering en cours de tâche : les messages envoyés depuis la carte /travaux
// PENDANT une exécution sont déposés ici (une ligne JSON par message), et le hook
// agent-steer-hook.mjs (PostToolUse/Stop, branché via --settings) les livre à
// Claude au fil de l'exécution — comme un message tapé en direct dans Claude Code.
const EXEC_INBOX  = id => resolve(DATA_DIR, `.agent-exec-${id}.inbox`)
const STEER_SETTINGS = resolve(fileURLToPath(import.meta.url), '../../../scripts/agent-steer-hooks.json')

// ─── Tunables (settled during the design grilling) ────────────────────────────
const EXEC_TIMEOUT_MS    = 30 * 60_000  // hard kill an execution after 30 min
const READONLY_TIMEOUT_MS = 8 * 60_000  // conversation read-only turns
const INSTANT_TIMEOUT_MS = 3 * 60_000   // proposition instantanée (sans outils, réponse courte)
const READONLY_TOOLS = 'Read,Glob,Grep' // truly read-only — no Bash/Write/Edit
const EXEC_TOOLS     = 'Bash,Read,Write,Edit,Glob,Grep'

// ─── Préréglages modèle / effort (choisis par l'utilisateur à la soumission) ──
// Appliqués à la proposition instantanée ET à l'exécution du correctif.
// « Approfondi » (le défaut de la file de travaux) tourne sur AGENT_MODEL = fable,
// avec repli automatique sur opus quand le quota hebdomadaire de fable est épuisé —
// voir agentModel.js. Le modèle inscrit sur la tâche reste le modèle SOUHAITÉ ; celui
// réellement utilisé est résolu au démarrage de l'exécution (champ `run_model`).
export const PRESETS = {
  fast:     { model: 'haiku',      effort: 'low',    label: 'Rapide' },
  standard: { model: 'sonnet',     effort: 'medium', label: 'Standard' },
  deep:     { model: AGENT_MODEL,  effort: 'high',   label: 'Approfondi' },
}
export function presetFor(key) { return PRESETS[key] || PRESETS.standard }

// Repli maximal par tâche : la longueur de la chaîne moins le modèle préféré. Garde-fou
// anti-boucle — une détection de quota qui se déclencherait à tort ne peut pas relancer
// la même tâche indéfiniment.
function maxFallbacksFor(model) { return Math.max(0, modelChain(model).length - 1) }

// ─── Prompt général (préambule système, éditable depuis la page Agent) ─────────
// Injecté en tête de CHAQUE activité (proposition instantanée / conversation / exécution).
// Surchargeable via agent-settings.json (clé `generalPrompt`) — voir getSettings().
export const DEFAULT_GENERAL_PROMPT =
  'Tu es un agent autonome d\'amélioration de l\'ERP Orisha (repo à /home/ec2-user/erp). ' +
  'L\'ERP est une app single-tenant qui couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards. ' +
  'Respecte toujours le CLAUDE.md à la racine du projet.'

function generalPrompt() {
  const p = getSettings().generalPrompt
  return (typeof p === 'string' && p.trim()) ? p.trim() : DEFAULT_GENERAL_PROMPT
}

// ─── Modèles de prompt par activité (éditables depuis la page Agent) ───────────
// Chaque modèle est le prompt COMPLET d'une activité (au-delà du préambule général).
// Les jetons {{placeholder}} sont remplacés au moment de l'exécution par renderTemplate().
// Surchargeables via agent-settings.json (clés instantPrompt / conversationPrompt /
// executionPrompt) — un champ vide retombe sur le défaut ci-dessous (voir promptTemplate()).
//
// Placeholders disponibles :
//   instantané    : {{general}} {{text}} {{context}}
//   conversation  : {{general}} {{proposal}} {{why}} {{zone}} {{thread}}
//   exécution     : {{general}} {{brief}} {{internalSecret}}

export const DEFAULT_INSTANT_PROMPT = [
  '{{general}}', '\n\n',
  'Un utilisateur vient de signaler un problème ou de suggérer une amélioration via la bulle d\'aide de l\'app. ',
  'Tu n\'as AUCUN outil : ne tente pas de lire le code, réponds uniquement à partir du signalement et de ta connaissance générale de l\'ERP.\n\n',
  'Signalement (depuis la page {{context}}):\n{{text}}\n\n',
  'Propose UN correctif concret et plausible : ce qui devrait changer dans l\'app, où (page/zone), et le comportement attendu après le correctif. ',
  'Écris en français, orienté utilisateur (pas de jargon technique ni de noms de fichiers), en 3 à 6 phrases maximum. ',
  'Si le signalement est trop vague pour proposer quoi que ce soit, dis-le et pose LA question qui débloquerait. ',
  'Ne produis que la proposition, sans préambule ni titre.',
].join('')

export const DEFAULT_CONVERSATION_PROMPT = [
  '{{general}}', '\n\n',
  'Tu DISCUTES d\'une proposition d\'amélioration avec l\'humain — tu ne codes PAS maintenant.\n',
  'Tu es en LECTURE SEULE: tu peux explorer le code (Read/Glob/Grep) pour répondre précisément, mais tu ne modifies RIEN.\n\n',
  'Proposition: {{proposal}}\n',
  '{{why}}',
  '{{zone}}',
  '\nFil de discussion:\n{{thread}}\n\n',
  'Réponds au DERNIER message de l\'humain de façon concise (max ~150 mots). ',
  'Tu peux raffiner l\'idée, clarifier la zone touchée ou le risque, ou proposer une variante. ',
  'Si l\'humain demande des changements, confirme-les: ils seront appliqués quand il cliquera « Approuver & coder ». ',
  'Ne produis que ta réponse, sans préambule.',
].join('')

// Consigne du compte-rendu utilisateur — garantie dans CHAQUE prompt d'exécution,
// même si l'utilisateur a personnalisé son modèle sans l'inclure (voir executeTask).
// Longueur proportionnelle à la complexité : quelques mots pour un petit correctif,
// quelques lignes pour un gros changement.
export const SUMMARY_SECTION_MARKER = '=== RÉSUMÉ UTILISATEUR ==='
export const SUMMARY_SECTION_INSTRUCTION = [
  'Puis termine IMPÉRATIVEMENT ta réponse par une section délimitée EXACTEMENT ainsi:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Suivie d\'un court compte-rendu en français destiné à l\'utilisateur qui a signalé le problème, SANS jargon technique ni noms de fichiers. ',
  'Adapte la longueur à la complexité du changement : quelques mots pour un petit correctif, 2 à 4 phrases pour un changement plus important. ',
  'Explique ce qui a changé dans l\'app, comment le constater, et tout commentaire pertinent (limite connue, comportement à surveiller…). ',
  'Si la tâche est bloquée, explique simplement pourquoi.',
].join('')

export const DEFAULT_EXECUTION_PROMPT = [
  '{{general}}', '\n\n',
  'Implémente UNIQUEMENT la tâche ci-dessous. ',
  'Ne lis pas agent-tasks.json ni les autres fichiers de gestion de tâches de l\'agent.\n\n',
  '{{brief}}',
  '\n\n=== RÈGLES IMPÉRATIVES (CLAUDE.md) ===\n',
  '- Respecte le CLAUDE.md à la racine du projet (lis-le si besoin).\n',
  '- Definition of Done frontend: toute modif dans client/src/ DOIT être suivie de `cd /home/ec2-user/erp/client && npm run build` PUIS d\'un test Playwright réel dans e2e/tests/ exécuté contre http://localhost:3004/erp.\n',
  '- Toute modif serveur (server/src/) DOIT être suivie de `pm2 restart erp-server`.\n',
  '- Si un test E2E échoue: corrige et relance. Au MAXIMUM 3 tentatives de correction. Si après 3 tentatives le test échoue encore, ARRÊTE, n\'invente rien, et explique clairement le blocage (ce sera marqué « bloqué »).\n',
  '- Nettoie tout record créé par tes tests E2E (hook after()), et restaure toute configuration existante que le test a écrasée — voir CLAUDE.md.\n\n',
  'Si tu as besoin d\'une approbation humaine pour une sous-étape, crée une sous-tâche:\n',
  'curl -s -X POST http://localhost:3004/api/agent/tasks/internal -H \'Content-Type: application/json\' -H \'X-Agent-Secret: {{internalSecret}}\' -d \'{"description":"...","priority":0}\'\n\n',
  'Termine par un rapport détaillé: ce que tu as changé, le résultat du build et des tests E2E (vert/rouge), ou la raison du blocage.\n',
  SUMMARY_SECTION_INSTRUCTION,
].join('')

// Consigne de la section réponse pour une QUESTION — même marqueur que le résumé
// d'implémentation (le pipeline monitorExecution/user_summary est partagé), mais la
// section contient la RÉPONSE, pas un compte-rendu de changements.
export const QUESTION_SUMMARY_INSTRUCTION = [
  'Termine IMPÉRATIVEMENT ta réponse par une section délimitée EXACTEMENT ainsi:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Suivie de la RÉPONSE à la question, en français, destinée à l\'utilisateur, SANS jargon technique ni noms de fichiers. ',
  'Adapte la longueur à la complexité de la question : une phrase pour une question simple, quelques paragraphes si nécessaire. ',
  'Si tu n\'as pas pu répondre, explique simplement pourquoi.',
].join('')

// ─── Question de l'agent à l'humain ──────────────────────────────────────────
// Une exécution tourne détachée, sans terminal : elle ne peut PAS afficher un
// choix et attendre. Avant, elle devinait (ou finissait « bloquée » avec la
// question noyée dans le compte-rendu). Elle émet donc une section finale
// optionnelle, lue par finalize() et posée sur l'item de file : la carte affiche
// la question avec ses choix, et un clic répond dans le fil — ce qui relance la
// tâche avec la réponse. Section OPTIONNELLE : ne rien émettre est le cas normal.
export const QUESTION_MARKER = '=== QUESTION UTILISATEUR ==='
export const ASK_USER_INSTRUCTION = [
  '\n\nEnfin, UNIQUEMENT si une décision ne t\'appartient pas et qu\'aucune hypothèse raisonnable ne permet de trancher ',
  '(deux comportements également défendables, une règle métier que seul l\'utilisateur connaît), ajoute TOUT À LA FIN ',
  'une dernière section délimitée EXACTEMENT ainsi:\n',
  QUESTION_MARKER, '\n',
  'Suivie d\'un objet JSON sur une seule ligne: {"question":"la question en français, sans jargon","options":["choix 1","choix 2"]}\n',
  'Deux à quatre options, chacune une réponse complète et actionnable (pas « oui »/« non » nus). ',
  'N\'émets cette section que si tu attends VRAIMENT une réponse : le travail est mis en attente de l\'utilisateur. ',
  'Si tu as pu trancher toi-même, n\'écris pas cette section du tout.',
].join('')

/**
 * Détache la section question du rapport. Renvoie { text, question } où `text` est
 * le rapport sans la section. Tolérant : si le JSON est mal formé, la question brute
 * est conservée sans options — mieux vaut une question sans boutons que rien.
 */
export function extractPendingQuestion(raw) {
  const text = String(raw || '')
  const idx = text.lastIndexOf(QUESTION_MARKER)
  if (idx === -1) return { text, question: null }
  const body = text.slice(idx + QUESTION_MARKER.length).trim()
  const head = text.slice(0, idx).trim()
  if (!body) return { text: head, question: null }

  // Le modèle enrobe parfois le JSON dans un bloc de code : on prend le premier
  // objet accoladé du corps, sinon on retombe sur le texte brut.
  const json = body.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      const parsed = JSON.parse(json[0])
      const q = String(parsed.question || '').trim()
      // JSON valide mais sans question : il n'y a rien à demander. Ne PAS retomber sur
      // le repli texte, qui afficherait le JSON brut à l'utilisateur comme question.
      if (!q) return { text: head, question: null }
      const options = Array.isArray(parsed.options)
        ? parsed.options.map(o => String(o).trim()).filter(Boolean).slice(0, 4)
        : []
      return { text: head, question: { question: q, options } }
    } catch { /* repli texte brut ci-dessous */ }
  }
  const plain = body.replace(/```\w*|```/g, '').trim()
  return { text: head, question: plain ? { question: plain, options: [] } : null }
}

// Prompt d'exécution d'une QUESTION (mode choisi par l'utilisateur à la soumission) :
// exploration en lecture seule, AUCUNE implémentation — la réponse part dans la
// section résumé et devient le compte-rendu de la carte.
export const DEFAULT_QUESTION_PROMPT = [
  '{{general}}', '\n\n',
  'La demande ci-dessous est une QUESTION de l\'utilisateur — PAS une demande d\'implémentation. ',
  'N\'implémente RIEN : tu es en LECTURE SEULE (Read/Glob/Grep uniquement), tu ne modifies aucun fichier, tu ne lances ni build, ni test, ni redémarrage. ',
  'Ne lis pas agent-tasks.json ni les autres fichiers de gestion de tâches de l\'agent.\n\n',
  '{{brief}}',
  '\n\nExplore le code autant que nécessaire pour répondre précisément et complètement à la question.\n',
  QUESTION_SUMMARY_INSTRUCTION,
].join('')

// Map clé de réglage → modèle par défaut. Source de vérité partagée avec la route
// GET /settings (qui renvoie ces défauts au front pour le bouton « Réinitialiser »).
export const PROMPT_TEMPLATE_DEFAULTS = {
  instantPrompt:      DEFAULT_INSTANT_PROMPT,
  conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
  executionPrompt:    DEFAULT_EXECUTION_PROMPT,
  questionPrompt:     DEFAULT_QUESTION_PROMPT,
}

// Récupère le modèle effectif d'une activité : override utilisateur si non vide, sinon défaut.
function promptTemplate(key) {
  const v = getSettings()[key]
  return (typeof v === 'string' && v.trim()) ? v : PROMPT_TEMPLATE_DEFAULTS[key]
}

// Remplace les jetons {{placeholder}} par leur valeur. N'affecte QUE les doubles accolades —
// les accolades simples du schéma JSON de sortie sont préservées telles quelles.
function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m))
}

// ERP_AGENT_RUN=1 est posé sur CHAQUE spawn de claude ci-dessous (voir les quatre
// sites `env:`). Les hooks Stop/Notification de ~/.claude/settings.json héritent de
// cet environnement : slack-notify.sh sort en silence quand la variable est là.
// Sans ce marqueur, une tâche lancée par n'importe quel utilisateur depuis la bulle
// d'aide envoyait « Tâche terminée » dans le DM Slack d'Antoine. Le recap des items
// de la file de prompts est envoyé par le serveur (voir promptQueue.js), pas par le hook.

// ─── Single global slot ───────────────────────────────────────────────────────
// Exactly ONE Claude activity runs at a time (execution / conversation / generation),
// because everything edits or reads the live working tree — no isolation.
// Priority: execution > conversation > generation.
let busy = false
let currentTaskId = null
let currentActivity = null     // 'execution' | 'conversation'
let _currentProc = null
const _replyQueue = []         // proposal ids awaiting a conversation reply

// ─── Voie lecture seule parallèle (tâches « question ») ───────────────────────
// Une question n'a que Read/Glob/Grep : elle ne peut modifier ni fichier, ni DB,
// ni redémarrer le serveur. Elle tourne donc HORS du slot global — jusqu'à
// MAX_PARALLEL_QUESTIONS en même temps, y compris pendant une implémentation, ce
// qui évite qu'une simple question attende la fin d'un chantier.
// Contrepartie assumée : une question lancée pendant une implémentation peut lire
// l'arbre à mi-chemin d'une modification. Acceptable pour une réponse en lecture
// seule ; c'est pourquoi l'implémentation, elle, reste strictement séquentielle.
const MAX_PARALLEL_QUESTIONS = 2
const _questionRuns = new Set()   // ids des tâches question en cours

// In-memory stream buffer per task: taskId -> chunk[]
const streamBuffers = new Map()

function appendStreamChunk(taskId, chunk) {
  if (!taskId) return
  if (!streamBuffers.has(taskId)) streamBuffers.set(taskId, [])
  const buf = streamBuffers.get(taskId)
  buf.push(chunk)
  if (buf.length > 500) buf.shift()
  broadcastAll({ type: 'agent:task:stream', taskId, chunk })
}

export function getStreamBuffer(taskId) {
  return streamBuffers.get(taskId) || []
}

// ─── Steering : message de l'utilisateur pendant une exécution ────────────────
// Dépose le message dans l'inbox de l'exécution ; le hook PostToolUse/Stop de la
// tâche le livrera à Claude après le prochain outil (ou juste avant la fin).
// Refuse si l'exécution ne tourne pas — un message déposé pour rien serait perdu.
export function sendSteeringMessage(taskId, text) {
  const clean = String(text || '').trim()
  if (!clean) return false
  const task = readTasks().find(t => t.id === taskId)
  if (!task || task.status !== 'in_progress') return false
  appendFileSync(EXEC_INBOX(taskId), JSON.stringify({ text: clean, at: new Date().toISOString() }) + '\n', 'utf8')
  // Le message apparaît aussi dans le flux live de la tâche : celui qui regarde
  // l'exécution voit ce qui vient d'être glissé à Claude.
  appendStreamChunk(taskId, { kind: 'user', text: clean })
  return true
}

// Parse ONE line of Claude's stream-json output and push UI chunks (no-op if taskId null).
function streamLine(taskId, line) {
  if (!taskId || !line.trim()) return
  try {
    const evt = JSON.parse(line)
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          appendStreamChunk(taskId, { kind: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
          const inp = block.input
          const preview = inp?.command || inp?.file_path || inp?.pattern ||
            (typeof inp === 'object' ? String(Object.values(inp)[0] ?? '').slice(0, 120) : '')
          appendStreamChunk(taskId, { kind: 'tool', name: block.name, input: preview })
        }
      }
    } else if (evt.type === 'user' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_result') {
          let content = ''
          if (typeof block.content === 'string') content = block.content
          else if (Array.isArray(block.content)) content = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          const trimmed = content.trim()
          if (trimmed) appendStreamChunk(taskId, { kind: 'result', content: trimmed.slice(0, 400) })
        }
      }
    }
  } catch {}
}

// Concatenate the assistant's final text blocks from a full stream-json transcript.
function extractAssistantText(transcript) {
  let text = ''
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text') text += block.text
        }
      }
    } catch {}
  }
  return text
}

// Message FINAL de l'exécution, tel que Claude le rend dans l'événement `result` du
// stream-json. C'est là que vit la section « RÉSUMÉ UTILISATEUR » : sur les longues
// exécutions, les événements `assistant` intermédiaires peuvent ne pas la contenir
// (dernier tour rendu uniquement dans le result), d'où un compte-rendu introuvable.
function extractResultText(transcript) {
  let last = ''
  for (const line of transcript.split('\n')) {
    if (!line.includes('"result"')) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'result' && typeof evt.result === 'string' && evt.result.trim()) last = evt.result
    } catch {}
  }
  return last
}

// Identifiant de session Claude d'une exécution, lu dans le transcript stream-json
// (chaque événement le porte). Conservé sur la tâche pour qu'un item de la file
// marqué « même contexte » puisse reprendre la session avec --resume.
function extractSessionId(transcript) {
  for (const line of transcript.split('\n')) {
    if (!line.includes('session_id')) continue
    try {
      const evt = JSON.parse(line)
      if (evt.session_id) return evt.session_id
    } catch {}
  }
  return null
}

// ─── File-backed stores (atomic write) ────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function readTasks() { return readJson(TASKS_FILE, []) }
function writeTasks(tasks) {
  writeFileSync(TASKS_TMP, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  renameSync(TASKS_TMP, TASKS_FILE)
}

export function getSettings() {
  return {
    enabled: false,
    autoApprove: true,
    // Pause de la file de travaux (page /travaux) — distincte de `enabled`, qui coupe
    // TOUT l'agent (y compris les signalements de la bulle d'aide). En pause, aucune
    // nouvelle exécution de la file ne démarre ; celle qui tourne va au bout.
    queuePaused: false,
    queuePausedAt: null,
    queuePausedReason: null,
    generalPrompt: DEFAULT_GENERAL_PROMPT,
    instantPrompt: DEFAULT_INSTANT_PROMPT,
    conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
    executionPrompt: DEFAULT_EXECUTION_PROMPT,
    questionPrompt: DEFAULT_QUESTION_PROMPT,
    ...readJson(SETTINGS_FILE, {}),
  }
}
export function setSettings(patch) {
  const next = { ...getSettings(), ...patch }
  writeJson(SETTINGS_FILE, next)
  broadcastAll({ type: 'agent:settings:updated', settings: next })
  // Turning the agent ON may unblock queued work.
  if (next.enabled) setImmediate(kick)
  return next
}

// ─── Pause de la file de travaux ──────────────────────────────────────────────
// Bouton « Pause » de la page /travaux : rien de nouveau ne part, l'exécution en
// cours finit normalement (donc aucun travail perdu, aucun jeton gaspillé à
// refaire ce qui était commencé). La reprise redémarre exactement là où la file
// s'était arrêtée — l'item suivant n'a jamais été lancé, il n'a rien à rattraper.
export function isQueuePaused() { return !!getSettings().queuePaused }

export function setQueuePaused(paused, { reason = null } = {}) {
  const next = setSettings({
    queuePaused: !!paused,
    queuePausedAt: paused ? new Date().toISOString() : null,
    queuePausedReason: paused ? (reason || null) : null,
  })
  if (!paused) setImmediate(kick)
  return {
    paused: !!next.queuePaused,
    pausedAt: next.queuePausedAt || null,
    reason: next.queuePausedReason || null,
  }
}

export function readBacklog() { return readJson(BACKLOG_FILE, []) }
function writeBacklog(items) { writeJson(BACKLOG_FILE, items); broadcastAll({ type: 'agent:backlog:updated' }) }

// Une « suggestion » : signalement utilisateur (bulle d'aide ou page agent) qui
// porte sa proposition instantanée puis le lien vers la tâche d'implémentation.
export function addBacklogItem(text, { context = '', author = '', preset = 'standard', mode = 'implement' } = {}) {
  const item = {
    id: randomUUID(),
    text,
    context,                       // route de la page d'où vient le signalement
    author,                        // nom de l'utilisateur qui signale
    mode: mode === 'question' ? 'question' : 'implement', // question = répondre sans rien implémenter
    preset: PRESETS[preset] ? preset : 'standard',
    instant_status: 'generating',  // 'generating' | 'ready' | 'error'
    instant_proposal: null,        // correctif proposé (LLM sans outils)
    task_id: null,                 // tâche d'implémentation une fois approuvée
    processed: false,
    created_at: new Date().toISOString(),
  }
  const items = readBacklog()
  items.push(item)
  writeBacklog(items)
  return item
}
export function updateBacklogItem(id, updates) {
  const items = readBacklog()
  const idx = items.findIndex(i => i.id === id)
  if (idx === -1) return null
  items[idx] = { ...items[idx], ...updates }
  writeBacklog(items)
  return items[idx]
}
export function deleteBacklogItem(id) {
  writeBacklog(readBacklog().filter(i => i.id !== id))
}

// ─── Proposition instantanée (sans outils, hors slot global) ──────────────────
// Tourne en PARALLÈLE de tout le reste : aucun outil autorisé → aucune interaction
// avec l'arbre de travail, donc pas besoin du slot global ni du toggle enabled.
export function generateInstantProposal(itemId) {
  const item = readBacklog().find(i => i.id === itemId)
  if (!item) return
  const { model: wanted, effort } = presetFor(item.preset)
  const model = resolveModel(wanted) || wanted
  const prompt = renderTemplate(promptTemplate('instantPrompt'), {
    general: generalPrompt(),
    text: item.text,
    context: item.context || '(inconnue)',
  })

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  const proc = spawn(CLAUDE_BIN, [
    '-p', '--model', model, '--effort', effort, '--tools', '',
  ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

  proc.stdin.write(prompt)
  proc.stdin.end()

  let output = ''
  let settled = false
  const timer = setTimeout(() => { if (!settled) { try { proc.kill('SIGKILL') } catch {} } }, INSTANT_TIMEOUT_MS)

  proc.stdout.on('data', chunk => { output += chunk.toString() })
  proc.stderr.on('data', () => {})
  proc.on('error', () => {})
  proc.on('close', (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const text = output.trim()
    const ok = code === 0 && text
    updateBacklogItem(itemId, ok
      ? { instant_status: 'ready', instant_proposal: text }
      : { instant_status: 'error', instant_proposal: null })
    if (!ok) console.error(`🤖 Agent: proposition instantanée en échec (item ${itemId}, exit ${code})`)
  })
}

// ─── Appel Claude sans outils (hors slot global) ──────────────────────────────
// Aucun outil autorisé → aucune interaction avec l'arbre de travail : ces appels
// tournent en parallèle d'une exécution sans risque de lire un fichier à moitié
// écrit. Utilisé par le moteur de suggestions, qui reçoit son contexte tout cuit
// (git log, journaux) plutôt que d'explorer le repo lui-même.
export function runToollessClaude({ prompt, model: wanted = 'sonnet', effort = 'medium', timeoutMs = 4 * 60_000 }) {
  return new Promise((resolveP) => {
    // Même résolution que les exécutions : un quota de modèle épuisé emprunte le repli
    // au lieu de faire échouer l'appel.
    const model = resolveModel(wanted) || wanted
    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--model', model, '--effort', effort, '--tools', '',
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let settled = false
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolveP(v) } }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)

    proc.stdout.on('data', c => { output += c.toString() })
    proc.stderr.on('data', () => {})
    proc.on('error', () => settle({ code: -1, text: '' }))
    proc.on('close', (code) => settle({ code, text: output.trim() }))
  })
}

// ─── Compte-rendu utilisateur de secours (a posteriori, sans outils) ───────────
// Deux cas alimentent ce chemin : une exécution dont le modèle a oublié la section
// « RÉSUMÉ UTILISATEUR », et les tâches terminées AVANT l'ajout du compte-rendu
// (rattrapage au démarrage — voir backfillUserSummaries). Aucun outil autorisé →
// tourne hors slot global, en parallèle de tout le reste, comme la proposition
// instantanée.
const SUMMARY_TIMEOUT_MS = 3 * 60_000
const _summarizing = new Map()

/**
 * Compte-rendu de secours, déduplicé : plusieurs appelants peuvent l'attendre en
 * même temps (le finalize de la tâche ET la file de travaux, qui refuse de figer un
 * placeholder dans son fil) — ils partagent la MÊME exécution et la même promesse.
 */
export function generateUserSummary(taskId) {
  const inflight = _summarizing.get(taskId)
  if (inflight) return inflight
  const p = runUserSummary(taskId).finally(() => _summarizing.delete(taskId))
  _summarizing.set(taskId, p)
  return p
}

function runUserSummary(taskId) {
  return new Promise((resolveP) => {
    const task = readTasks().find(t => t.id === taskId)
    if (!task || task.user_summary || !['done', 'blocked'].includes(task.status)) return resolveP(false)
    const report = (task.agent_result || '').trim()
    if (!report || report === '(terminé sans rapport)') return resolveP(false)

    // Une tâche « question » n'a rien changé dans l'app : le compte-rendu de secours
    // est la RÉPONSE tirée du rapport, pas un récit de modifications.
    const isQuestion = task.mode === 'question'
    const prompt = isQuestion ? [
      'Un agent autonome vient d\'explorer l\'ERP Orisha (en lecture seule) pour répondre à la question d\'un utilisateur. ',
      'Rédige la RÉPONSE destinée à l\'utilisateur, en français, SANS jargon technique ni noms de fichiers, à partir du rapport ci-dessous. ',
      'Adapte la longueur à la complexité de la question. ',
      task.status === 'blocked'
        ? 'L\'agent n\'a PAS pu répondre : explique simplement pourquoi, sans détails techniques. '
        : '',
      // Même garde-fou que pour les implémentations : pas de réponse inventée à partir
      // d'un rapport coupé net.
      'INTERDIT d\'inventer : n\'affirme que ce que le rapport établit. ',
      'Si le rapport ne contient pas la réponse (exploration interrompue), dis simplement que la recherche n\'a pas abouti et qu\'il faut relancer. ',
      'Ne produis QUE la réponse, sans préambule ni titre.\n\n',
      `Question de l'utilisateur:\n${task.description || task.title || '(inconnue)'}\n\n`,
      `Rapport de l'exploration:\n${report.slice(-12000)}`,
    ].join('') : [
      'Un agent autonome vient d\'intervenir sur l\'ERP Orisha suite à un signalement utilisateur. ',
      'Rédige le compte-rendu destiné à l\'utilisateur, en français, SANS jargon technique ni noms de fichiers. ',
      'Adapte la longueur à la complexité : quelques mots pour un petit correctif, 2 à 4 phrases pour un changement plus important. ',
      'Explique ce qui a changé dans l\'app, comment le constater, et tout commentaire pertinent. ',
      task.status === 'blocked'
        ? 'L\'intervention a été BLOQUÉE : explique simplement pourquoi, sans détails techniques. '
        : '',
      // Garde-fou anti-fabulation : un rapport coupé net (quota épuisé, process tué) ne
      // montre que le début de l'investigation. Sans cette consigne, le modèle
      // extrapolait un « c'est intégré, allez voir » pour du travail jamais terminé.
      'INTERDIT d\'inventer ou de supposer : n\'affirme un changement que si le rapport le montre explicitement. ',
      'Si le rapport ne montre que le début du travail (exploration, intention, aucune modification confirmée), dis-le franchement : ',
      'que le travail a été interrompu avant d\'aboutir, que rien ne garantit qu\'il soit fait, et qu\'il faut le relancer. ',
      'Ne produis QUE le compte-rendu, sans préambule ni titre.\n\n',
      `Signalement initial:\n${task.description || task.title || '(inconnu)'}\n\n`,
      // Fin du rapport = conclusion de l'agent (le début est du récit d'exécution).
      `Rapport technique de l'intervention:\n${report.slice(-12000)}`,
    ].join('')

    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--model', 'haiku', '--effort', 'low', '--tools', '',
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let settled = false
    const settle = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveP(ok)
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, SUMMARY_TIMEOUT_MS)

    proc.stdout.on('data', chunk => { output += chunk.toString() })
    proc.stderr.on('data', () => {})
    proc.on('error', () => settle(false))
    proc.on('close', (code) => {
      const text = output.trim()
      if (code === 0 && text) {
        const updated = updateTask(taskId, { user_summary: text })
        if (updated) broadcastTask(updated)
        settle(true)
      } else {
        console.error(`🤖 Agent: génération du compte-rendu en échec (tâche ${taskId}, exit ${code})`)
        settle(false)
      }
    })
  })
}

// Rattrapage : compte-rendus manquants sur les implémentations déjà terminées
// (tâches d'avant la fonctionnalité, ou prompt personnalisé sans la section).
// Séquentiel pour ne pas empiler les subprocess ; idempotent (le résumé persisté
// n'est jamais régénéré) ; relancé au prochain démarrage en cas d'échec ponctuel.
let _backfillStarted = false
async function backfillUserSummaries() {
  if (_backfillStarted) return
  _backfillStarted = true
  const ids = readTasks()
    .filter(t => ['done', 'blocked'].includes(t.status) && !t.user_summary && (t.agent_result || '').trim())
    .map(t => t.id)
  if (!ids.length) return
  console.log(`🤖 Agent: rattrapage des compte-rendus manquants (${ids.length} tâche(s))…`)
  for (const id of ids) {
    try { await generateUserSummary(id) } catch {}
  }
  console.log('🤖 Agent: rattrapage des compte-rendus terminé')
}

// ─── Approbation d'une suggestion → tâche d'implémentation ────────────────────
export function approveBacklogItem(id, { comment = '' } = {}) {
  const item = readBacklog().find(i => i.id === id)
  if (!item) return null
  if (item.task_id) return { item, task: readTasks().find(t => t.id === item.task_id) || null }
  const { model, effort } = presetFor(item.preset)
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(),
    kind: 'suggestion',
    mode: item.mode === 'question' ? 'question' : 'implement',
    backlog_id: item.id,
    title: item.text.length > 140 ? item.text.slice(0, 140) + '…' : item.text,
    description: item.text,
    context: item.context || '',
    author: item.author || '',
    model, effort,
    status: 'approved',
    priority: 0,
    messages: [],
    user_comment: comment || null,
    agent_result: null,
    user_summary: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  const updatedItem = updateBacklogItem(id, { task_id: task.id, processed: true })
  broadcastTask(task)
  setImmediate(kick)
  return { item: updatedItem, task }
}

function updateTask(id, updates) {
  const tasks = readTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx === -1) return null
  const task = { ...tasks[idx], ...updates, updated_at: new Date().toISOString() }
  tasks[idx] = task
  writeTasks(tasks)
  return task
}

function broadcastTask(task) { broadcastAll({ type: 'agent:task:updated', task }) }

export function isRunnerBusy() { return busy }
/** Nombre de questions en cours dans la voie lecture seule (0 à MAX_PARALLEL_QUESTIONS). */
export function getRunningQuestionCount() { return _questionRuns.size }
export function getMaxParallelQuestions() { return MAX_PARALLEL_QUESTIONS }
export function getCurrentTaskId() { return currentTaskId }
export function getCurrentActivity() { return currentActivity }

// ─── Quotas Claude épuisés ────────────────────────────────────────────────────
// « You've hit your session limit · resets 3:40am (UTC) » : ce n'est PAS un échec de
// la tâche, c'est un quota épuisé. Le marquer « bloqué » brûlait toute la file en
// quelques secondes (chaque item repartait, mourait aussitôt, et affichait un message
// d'erreur trompeur).
//
// Deux réactions selon le plafond touché (attribution dans handleLimitHit, registre
// par modèle dans agentModel.js) :
//   • plafond propre au modèle (le hebdo de fable) → la tâche repart aussitôt sur le
//     modèle de repli (opus). Rien ne s'arrête, et fable reprend la main à sa réinit.
//   • plafond de compte (fenêtre de 5 h, hebdo tous modèles) → l'item retourne en file,
//     l'ordonnanceur se met en pause, et tout repart tout seul à l'heure dite.
const LIMIT_RE = /(?:hit your (?:session|usage|weekly) limit|usage limit reached|limit will reset)/i
const RESET_RE = /reset(?:s)?(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:\(([^)]{1,20})\))?/i

let _limitTimer = null

/**
 * Instant de reprise quand l'ordonnanceur est VRAIMENT à l'arrêt, c'est-à-dire quand
 * même le modèle de repli est à sec (0 sinon). Le plafond hebdomadaire de fable seul ne
 * compte pas : le travail continue sur opus, la file n'est pas en pause.
 */
export function getSessionLimitResetAt() { return chainAvailableAt(AGENT_MODEL) }

/** État du modèle de l'agent (préféré / actif / quotas épuisés) — exposé par /agent/usage. */
export function getAgentModelState() { return agentModelState(AGENT_MODEL) }

/**
 * Reconnaît le message de quota dans la sortie d'une exécution et en déduit l'heure de
 * reprise. Heure lue en UTC (c'est ce que le CLI imprime) ; à défaut d'heure lisible on
 * repousse d'une heure — jamais de reprise immédiate, qui rebrûlerait la file.
 */
/**
 * Signal structuré du stream : chaque exécution émet des `rate_limit_event` portant
 * `rate_limit_info.status` et `resetsAt` (epoch secondes). Bien plus fiable que la
 * phrase d'erreur — on le lit en priorité, et seul un statut non-« allowed » compte.
 */
export function detectRateLimitEvent(transcript, now = Date.now()) {
  let hit = null
  for (const line of String(transcript || '').split('\n')) {
    if (!line.includes('rate_limit_info')) continue
    try {
      const info = JSON.parse(line)?.rate_limit_info
      if (!info?.status) continue
      // Le DERNIER état connu gagne : un refus suivi d'un retour à « allowed » (fenêtre
      // réinitialisée en cours d'exécution) ne doit pas mettre l'ordonnanceur en pause.
      if (info.status === 'allowed' || info.status === 'allowed_warning') { hit = null; continue }
      const resetAt = Number(info.resetsAt) > 0 ? Number(info.resetsAt) * 1000 : now + 60 * 60_000
      hit = { resetAt, label: `${new Date(resetAt).toISOString().slice(11, 16)} UTC` }
    } catch {}
  }
  return hit
}

export function detectSessionLimit(text, now = Date.now()) {
  const s = String(text || '')
  if (!LIMIT_RE.test(s)) return null
  const m = RESET_RE.exec(s)
  if (!m) return { resetAt: now + 60 * 60_000, label: 'dans une heure' }
  let h = parseInt(m[1], 10) % 12
  const min = parseInt(m[2], 10)
  if ((m[3] || '').toLowerCase() === 'pm') h += 12
  if (!m[3] && parseInt(m[1], 10) === 12) h = 12          // « 12:30 » sans am/pm = midi
  const d = new Date(now)
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0, 0)
  const resetAt = at > now ? at : at + 24 * 3600_000       // heure déjà passée → demain
  return { resetAt, label: `${String(h).padStart(2, '0')}:${m[2]} UTC` }
}

/**
 * Enregistre un quota épuisé. `models` = le seul modèle concerné (plafond propre au
 * modèle → le repli prend la suite) ou tous (plafond de compte → plus rien ne passe).
 */
function noteLimit(models, { resetAt, label }, { source = 'run' } = {}) {
  const changed = noteModelLimit(models, { resetAt, label, source })
  if (!changed) return
  const stalled = chainAvailableAt(AGENT_MODEL)
  if (stalled) {
    const mins = Math.round((stalled - Date.now()) / 60_000)
    console.warn(`🤖 Agent: quotas Claude épuisés (${[].concat(models).join(', ')}) — ordonnanceur en pause ${mins} min (reprise ${label})`)
  } else {
    console.warn(`🤖 Agent: quota ${[].concat(models).join(', ')} épuisé jusqu'à ${label} — bascule sur le modèle de repli`)
  }
  broadcastAll({
    type: 'agent:limit',
    resetAt: stalled ? new Date(stalled).toISOString() : null,
    model: getAgentModelState(),
  })
  rearmLimitTimer()
}

/**
 * Un seul minuteur pour tous les quotas : il se réarme sur la PROCHAINE
 * réinitialisation connue. À son déclenchement, les marques périmées tombent et la file
 * repart — que ce soit fable qui revienne (retour au modèle préféré) ou le dernier
 * repli (sortie de pause).
 */
function rearmLimitTimer() {
  if (_limitTimer) { clearTimeout(_limitTimer); _limitTimer = null }
  const at = nextLimitExpiryAt()
  if (!at) return
  _limitTimer = setTimeout(() => {
    _limitTimer = null
    purgeExpiredLimits()
    console.log('🤖 Agent: quota Claude réinitialisé — reprise de la file')
    kick()
    import('./promptQueue.js').then(m => m.advanceQueue()).catch(() => {})
    rearmLimitTimer()
  }, Math.max(1000, at - Date.now() + 30_000))
  _limitTimer.unref?.()
}

/**
 * Exécution avortée faute de quota. Deux issues :
 *
 *   • le plafond ne visait QUE le modèle utilisé (typiquement le hebdo de fable) et un
 *     repli reste disponible → la tâche repart TOUT DE SUITE sur le modèle suivant. Rien
 *     n'attend, l'utilisateur voit juste le travail reprendre sur opus.
 *   • plus aucun modèle n'a de quota → ancien comportement : la tâche retourne en file,
 *     l'ordonnanceur se met en pause jusqu'à la réinitialisation, aucun compte-rendu
 *     trompeur n'est écrit.
 */
async function handleLimitHit(taskId, limit, sessionId) {
  const task = readTasks().find(t => t.id === taskId) || {}
  const wanted = task.model || AGENT_MODEL
  const ranModel = task.run_model || wanted
  const scope = await fetchLimitScope()
  noteLimit(scope === 'account' ? KNOWN_MODELS : [ranModel], limit)

  const hops = task.model_fallbacks || 0
  const fallback = resolveModel(wanted)
  if (scope === 'model' && fallback && fallback !== ranModel && hops < maxFallbacksFor(wanted)) {
    // Repli immédiat : la tâche redevient « approved » et kick() la relance aussitôt
    // (releaseSlot enchaîne). Le modèle SOUHAITÉ reste inscrit tel quel — c'est
    // resolveModel qui choisit au démarrage, donc fable reprend la main dès son retour.
    const retried = updateTask(taskId, {
      status: 'approved',
      agent_result: `(quota ${ranModel} épuisé jusqu'à ${limit.label} — reprise immédiate sur ${fallback})`,
      user_summary: null,
      run_model: null,
      model_fallbacks: hops + 1,
      session_id: sessionId || null,
      completed_at: null,
    })
    console.warn(`🤖 Agent: tâche ${taskId} relancée sur ${fallback} (quota ${ranModel} épuisé jusqu'à ${limit.label})`)
    if (retried) broadcastTask(retried)
    return
  }

  const isQueue = task.kind === 'queue'
  const deferred = updateTask(taskId, {
    // Item de file : c'est la file qui le relancera (nouvelle tâche) → celle-ci sort
    // du jeu. Suggestion/backlog : le runner la reprendra lui-même.
    status: isQueue ? 'cancelled' : 'approved',
    agent_result: `(limite de session Claude atteinte — reprise automatique à ${limit.label})`,
    user_summary: null,
    run_model: null,
    session_id: sessionId || null,
    completed_at: null,
  })
  if (deferred) {
    broadcastTask(deferred)
    setImmediate(() => {
      import('./promptQueue.js')
        .then(m => m.onAgentTaskDeferred(deferred, limit))
        .catch(e => console.error('🤖 File de travaux: report impossible —', e.message))
    })
  }
}

// ─── Public scheduling API ────────────────────────────────────────────────────
export function requestReply(taskId) {
  if (!_replyQueue.includes(taskId)) _replyQueue.push(taskId)
  setImmediate(kick)
}

// runNextTask kept as a public alias for back-compat (routes call it after approve).
export function runNextTask() { kick() }

// ─── The scheduler heart: pick the next activity by priority ───────────────────
function kick() {
  if (!getSettings().enabled) return

  // File de travaux en pause : ses tâches restent « approved » sans démarrer. Le reste
  // de l'agent (signalements de la bulle d'aide, réponses de conversation) continue —
  // la pause vise la consommation de jetons des chantiers, pas l'app entière.
  const tasks = readTasks().filter(t => !(isQueuePaused() && t.kind === 'queue'))
  const byPriority = (a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at)
  // Quota épuisé : une tâche n'attend QUE si son modèle et tous ses replis sont à sec
  // (un timer relance kick à la réinitialisation). Le plafond hebdomadaire de fable
  // laisse donc la file tourner sur opus.
  const hasModel = t => !!resolveModel(t.model || AGENT_MODEL)

  // 1. Voie lecture seule : les questions démarrent même si une implémentation
  // tourne, jusqu'à MAX_PARALLEL_QUESTIONS simultanées.
  for (const q of tasks.filter(t => t.status === 'approved' && t.mode === 'question' && hasModel(t)).sort(byPriority)) {
    if (_questionRuns.size >= MAX_PARALLEL_QUESTIONS) break
    executeTask(q, { lane: 'question' })
  }

  if (busy) return

  // 2. Implémentation : une seule à la fois, elle édite l'arbre de travail réel.
  const nextExec = tasks
    .filter(t => t.status === 'approved' && t.mode !== 'question' && hasModel(t))
    .sort(byPriority)[0]
  if (nextExec) { executeTask(nextExec); return }

  // 2. Conversation replies (the user is waiting live).
  while (_replyQueue.length) {
    const id = _replyQueue.shift()
    const t = readTasks().find(x => x.id === id)
    if (t && (t.status === 'pending' || t.status === 'in_discussion')) { conversationReply(t); return }
  }
}

function releaseSlot() {
  busy = false
  currentTaskId = null
  currentActivity = null
  _currentProc = null
  setImmediate(kick)
}

// ─── Read-only Claude spawn helper (conversation / generation) ─────────────────
// Pipe-based & in-process. Resolves with { code, text, timedOut }. NOT for execution:
// these turns are short, read-only, and never restart the server, so the in-process
// completion handler is safe here. Execution uses runDetachedExecution() instead.
function spawnClaude({ prompt, allowedTools, streamTaskId = null, timeoutMs }) {
  return new Promise((resolveP) => {
    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--allowedTools', allowedTools,
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

    _currentProc = proc

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let lineBuffer = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      try { proc.kill('SIGKILL') } catch {}
    }, timeoutMs)

    proc.stdout.on('data', rawChunk => {
      const str = rawChunk.toString()
      output += str
      lineBuffer += str
      const parts = lineBuffer.split('\n')
      lineBuffer = parts.pop()
      for (const line of parts) streamLine(streamTaskId, line)
    })
    proc.stderr.on('data', () => {})

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const timedOut = code === null || code === 137 // SIGKILL
      resolveP({ code, text: extractAssistantText(output), timedOut })
    })
  })
}

// ─── Detached execution — durable result (survives `pm2 restart erp-server`) ────
// The exec Claude runs inside a detached bash wrapper that redirects its stream to a
// log file and writes the exit code to a sibling file when done. Because nothing reads
// the child's stdout pipe, a parent restart neither loses the result nor SIGPIPE-kills
// the child. monitorExecution() tails the log to stream live and finalizes the task off
// the .code file — the same path used to reconnect after a restart. (taskId, optional pid
// when reconnecting to an already-running orphan.)
// `lane` : 'exec' (slot global, fichier PID unique) ou 'question' (voie parallèle
// lecture seule, un fichier PID par tâche — voir QPID_FILE).
export function monitorExecution(taskId, knownPid = null, { lane = 'exec' } = {}) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : PID_FILE
  const startedAt = Date.now()
  let offset = 0
  let lineBuffer = ''
  let finished = false

  function drainLog() {
    try {
      if (!existsSync(LOG)) return
      const buf = readFileSync(LOG)
      if (buf.length <= offset) return
      const chunk = buf.slice(offset).toString('utf8')
      offset = buf.length
      lineBuffer += chunk
      const parts = lineBuffer.split('\n')
      lineBuffer = parts.pop()
      for (const line of parts) streamLine(taskId, line)
    } catch {}
  }

  function finalize({ killedTimeout = false } = {}) {
    if (finished) return
    finished = true
    clearInterval(poll)
    drainLog()

    let code = null
    try { if (existsSync(CODE)) code = parseInt(readFileSync(CODE, 'utf8').trim(), 10) } catch {}
    let raw = ''
    try { if (existsSync(LOG)) raw = readFileSync(LOG, 'utf8') } catch {}
    const text = extractAssistantText(raw)
    const sessionId = extractSessionId(raw)

    let status, agent_result
    if (killedTimeout) {
      status = 'blocked'
      agent_result = `(interrompu: dépassement du délai de ${Math.round(EXEC_TIMEOUT_MS / 60000)} min)\n\n${text}`
    } else if (code === 0) {
      status = 'done'
      agent_result = text || '(terminé sans rapport)'
    } else if (code === null) {
      status = 'blocked'
      agent_result = (text ? text + '\n\n' : '') + '(process interrompu sans code de sortie — relancer manuellement si besoin)'
    } else {
      status = 'blocked'
      agent_result = (text ? text + '\n\n' : '') + `(exit code: ${code})`
    }

    // Quota Claude épuisé : la tâche n'a pas échoué, elle n'a pas pu travailler. On la
    // remet en file, on met l'ordonnanceur en pause jusqu'à la réinitialisation, et on
    // n'écrit NI compte-rendu trompeur NI message d'erreur.
    const limit = detectRateLimitEvent(raw) || detectSessionLimit(agent_result)
    if (limit) {
      // Attribution asynchrone (quotas de l'abonnement) → repli sur un autre modèle ou
      // report. Le slot reste tenu le temps de trancher, puis cleanup() le libère.
      handleLimitHit(taskId, limit, sessionId).catch(e => {
        console.error('🤖 Agent: traitement du quota en échec —', e.message)
      }).finally(cleanup)
      return
    }

    // Question à l'humain : détachée AVANT le résumé. La section question vient après
    // celle du résumé dans le rapport ; l'extraction du résumé prenant tout jusqu'à la
    // fin, la laisser en place la collerait dans le compte-rendu au lieu de la poser
    // comme question à répondre.
    let pending_question = null
    {
      const cut = extractPendingQuestion(agent_result)
      agent_result = cut.text
      pending_question = cut.question
    }

    // Résumé vulgarisé : section finale demandée par le prompt d'exécution, affichée
    // en clair sur la fiche de la suggestion (le rapport technique reste en dépli).
    let user_summary = null
    const summaryIdx = agent_result.lastIndexOf(SUMMARY_SECTION_MARKER)
    if (summaryIdx !== -1) {
      user_summary = agent_result.slice(summaryIdx + SUMMARY_SECTION_MARKER.length).trim() || null
      agent_result = agent_result.slice(0, summaryIdx).trim()
    } else {
      // Section absente du récit concaténé : on la cherche dans le message final du
      // stream (événement `result`), qui la porte quand les événements `assistant`
      // ne l'ont pas véhiculée. Évite un compte-rendu « manquant » alors que le
      // modèle l'avait bien écrit.
      const cutResult = extractPendingQuestion(extractResultText(raw))
      const resultText = cutResult.text
      if (!pending_question) pending_question = cutResult.question
      const i = resultText.lastIndexOf(SUMMARY_SECTION_MARKER)
      if (i !== -1) {
        user_summary = resultText.slice(i + SUMMARY_SECTION_MARKER.length).trim() || null
        const head = resultText.slice(0, i).trim()
        if (head && !agent_result.includes(head)) {
          agent_result = agent_result === '(terminé sans rapport)' ? head : `${agent_result}\n\n${head}`
        }
      }
    }

    // Message de steering jamais consommé (envoyé dans les toutes dernières secondes,
    // ou pendant une exécution morte) : Claude ne l'a pas vu. On le pose sur la tâche
    // pour que la file de travaux relance immédiatement avec ce complément.
    let missed_user_message = null
    try {
      if (existsSync(EXEC_INBOX(taskId))) {
        missed_user_message = readFileSync(EXEC_INBOX(taskId), 'utf8')
          .split('\n').filter(l => l.trim())
          .map(l => { try { return String(JSON.parse(l).text || '').trim() } catch { return l.trim() } })
          .filter(Boolean).join('\n') || null
      }
    } catch {}

    const finalTask = updateTask(taskId, {
      status, agent_result, user_summary,
      pending_question,
      missed_user_message,
      session_id: sessionId || null,
      completed_at: new Date().toISOString(),
    })
    if (finalTask) broadcastTask(finalTask)

    // File de prompts : l'item passe à done/blocked, le recap part dans le DM Slack
    // et l'item suivant est mis en route. Import dynamique — promptQueue crée des
    // tâches via ce module, l'import statique serait circulaire.
    if (finalTask) {
      setImmediate(() => {
        import('./promptQueue.js')
          .then(m => m.onAgentTaskFinalized(finalTask))
          .catch(e => console.error('🤖 File de prompts: suite impossible —', e.message))
      })
    }

    // Section résumé absente du rapport (modèle qui a oublié la consigne) →
    // compte-rendu de secours généré a posteriori, hors slot (sans outils).
    if (!user_summary) setImmediate(() => generateUserSummary(taskId).catch(() => {}))

    cleanup()
  }

  // Artefacts de l'exécution + libération du slot. Partagé par les deux sorties de
  // finalize (tâche terminée, ou reportée pour quota épuisé).
  function cleanup() {
    try { unlinkSync(LOG) } catch {}
    try { unlinkSync(CODE) } catch {}
    try { unlinkSync(EXEC_PROMPT(taskId)) } catch {}
    try { unlinkSync(EXEC_INBOX(taskId)) } catch {}
    try { unlinkSync(pidFile) } catch {}
    setTimeout(() => streamBuffers.delete(taskId), 120_000).unref?.()
    if (lane === 'question') {
      // Voie parallèle : rien à libérer côté slot global, on rend juste sa place
      // dans la voie lecture seule et on regarde s'il y a une autre question.
      _questionRuns.delete(taskId)
      setImmediate(kick)
    } else {
      releaseSlot()
    }
  }

  function currentPid() {
    if (knownPid) return knownPid
    try { return parseInt(readFileSync(pidFile, 'utf8').trim().split('\n')[0], 10) } catch { return null }
  }

  const poll = setInterval(() => {
    drainLog()
    // Primary signal: the wrapper wrote the exit code → done/blocked by code.
    if (existsSync(CODE)) { finalize(); return }
    // Hard timeout: kill the whole detached group, mark blocked.
    if (Date.now() - startedAt > EXEC_TIMEOUT_MS) {
      const pid = currentPid()
      if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
      finalize({ killedTimeout: true })
      return
    }
    // Process vanished without a code file (crash / SIGKILL) — give the FS a beat to
    // flush a possible last-moment .code, then finalize as blocked.
    const pid = currentPid()
    if (pid && !isProcessAlive(pid) && Date.now() - startedAt > 6000) {
      drainLog()
      finalize() // code stays null unless a .code appeared → blocked
    }
  }, 2000)

  drainLog()
}

function runDetachedExecution(taskId, prompt, {
  model = null, effort = null, tools = EXEC_TOOLS, resumeSessionId = null, lane = 'exec',
} = {}) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const PROMPT = EXEC_PROMPT(taskId)

  // Clear any stale artifacts from a previous run of the same id.
  for (const f of [LOG, CODE, EXEC_INBOX(taskId)]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
  writeFileSync(PROMPT, prompt, 'utf8')

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  // Modèle/effort issus du préréglage choisi par l'utilisateur à la soumission.
  const modelFlags = (model ? ` --model "${model}"` : '') + (effort ? ` --effort "${effort}"` : '')
  // --resume : l'item de file marqué « même contexte » poursuit la session Claude de
  // l'item précédent au lieu de repartir à zéro. Une session introuvable (purgée,
  // machine redémarrée) fait échouer le démarrage → l'item repart proprement d'un
  // contexte neuf, voir le repli dans promptQueue.startPrompt().
  const resumeFlag = resumeSessionId ? ` --resume "${resumeSessionId}"` : ''
  // Voie question : fichier PID par tâche ; voie exec : le fichier PID unique, celui
  // que deploy.sh consulte pour attendre la fin d'une exécution.
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : PID_FILE

  // ⚠️ `setsid --fork` n'est PAS cosmétique : pm2 tourne en `treekill: true` (défaut) et
  // tue TOUT le sous-arbre du serveur à chaque `pm2 restart erp-server`. Sans la coupure
  // de lignée, chaque exécution mourait au premier redémarrage — y compris celui que
  // l'agent lance lui-même après une modif serveur (CLAUDE.md l'exige), donc il se
  // décapitait au moment de valider son propre travail : rapport tronqué à la première
  // phrase, et compte-rendu inventé par-dessus. setsid meurt aussitôt, le wrapper est
  // réadopté par init (ppid 1) et devient invisible pour treekill.
  //
  // Corollaire : le pid renvoyé par spawn() est celui de setsid, éphémère et inutile.
  // C'est donc le wrapper qui écrit SON pid dans le fichier PID, dès sa première ligne.
  // claude reads the prompt from stdin (PROMPT file); stream-json → LOG; exit code → CODE.
  // --settings : branche le hook de steering (voir EXEC_INBOX) sur CETTE exécution.
  // Le hook est inerte sans ERP_AGENT_TASK_ID, donc sans effet ailleurs.
  const cmd = `printf '%s\\n%s\\n' "$$" "${taskId}" > "${pidFile}"; ` +
    `"${CLAUDE_BIN}" -p --output-format stream-json --verbose${modelFlags}${resumeFlag} ` +
    `--settings "${STEER_SETTINGS}" ` +
    `--allowedTools "${tools}" < "${PROMPT}" > "${LOG}" 2>&1; echo $? > "${CODE}"`

  const proc = spawn('setsid', ['--fork', 'bash', '-c', cmd], {
    cwd: CWD,
    env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1', ERP_AGENT_TASK_ID: taskId },
    detached: true,
    stdio: 'ignore', // nobody reads the child's stdout → restart can't SIGPIPE it
  })
  proc.unref()

  // knownPid volontairement absent : le vrai pid arrive par le fichier, quelques
  // millisecondes plus tard (currentPid() le relit à chaque tour de poll).
  monitorExecution(taskId, null, { lane })
}

// ─── Execution ────────────────────────────────────────────────────────────────
// lane 'exec' : read-write, prend le slot global (une seule à la fois).
// lane 'question' : lecture seule, hors slot, jusqu'à MAX_PARALLEL_QUESTIONS.
function executeTask(next, { lane = 'exec' } = {}) {
  if (lane === 'question') {
    _questionRuns.add(next.id)
  } else {
    busy = true
    currentTaskId = next.id
    currentActivity = 'execution'
  }

  // Modèle réellement utilisable : le modèle souhaité s'il a du quota, sinon son repli
  // (fable → opus). `run_model` garde la trace de ce qui a VRAIMENT tourné — c'est lui
  // qu'on attribue si l'exécution se heurte à un plafond.
  const wanted = next.model || AGENT_MODEL
  const runModel = resolveModel(wanted) || wanted
  if (runModel !== wanted) {
    console.log(`🤖 Agent: tâche ${next.id} lancée sur ${runModel} (quota ${wanted} épuisé)`)
  }

  // started_at : horodate le passage en in_progress pour alimenter le compteur de
  // temps écoulé côté UI (timer live pendant l'exécution, durée totale une fois terminée).
  const task = updateTask(next.id, {
    status: 'in_progress', started_at: new Date().toISOString(), run_model: runModel,
  })
  broadcastTask(task)

  const internalSecret = AGENT_INTERNAL_SECRET || ''
  // Question : l'utilisateur veut une réponse, pas un correctif — prompt lecture
  // seule dédié (questionPrompt) + outils read-only, la réponse part dans la
  // section résumé (compte-rendu de la carte).
  const isQuestion = next.mode === 'question'

  let brief
  if (next.kind === 'suggestion') {
    // Suggestion utilisateur (bulle d'aide) : signalement + correctif instantané approuvé.
    const item = readBacklog().find(i => i.id === next.backlog_id)
    brief = [
      `${isQuestion ? 'Question' : 'Signalement'} utilisateur${next.author ? ` (par ${next.author})` : ''}${next.context ? ` depuis la page ${next.context}` : ''}:\n${next.description}`,
      !isQuestion && item?.instant_proposal ? `\n\nCorrectif proposé et APPROUVÉ par l'utilisateur (implémente dans cet esprit):\n${item.instant_proposal}` : '',
      next.user_comment ? `\n\nCommentaire de l'utilisateur à l'approbation: ${next.user_comment}` : '',
    ].join('')
  } else if (next.kind === 'proposal') {
    const thread = (next.messages || [])
      .map(m => `${m.role === 'user' ? 'Humain' : 'Agent'}: ${m.text}`)
      .join('\n')
    brief = [
      `Titre: ${next.title || next.description}`,
      next.why ? `\nPourquoi: ${next.why}` : '',
      next.zone ? `\nZone visée: ${next.zone}` : '',
      next.user_comment ? `\nCommentaire humain: ${next.user_comment}` : '',
      thread ? `\n\nFil de discussion (raffinements convenus):\n${thread}` : '',
    ].join('')
  } else {
    brief = `Description:\n${next.description}${next.user_comment ? `\n\nCommentaire humain: ${next.user_comment}` : ''}`
  }

  let prompt = renderTemplate(promptTemplate(isQuestion ? 'questionPrompt' : 'executionPrompt'), {
    general: generalPrompt(),
    brief,
    internalSecret,
  })
  // Filet : un prompt personnalisé qui omet la section résumé priverait les cartes
  // terminées de leur compte-rendu (ou de la réponse) — on ré-injecte la consigne.
  if (!prompt.includes(SUMMARY_SECTION_MARKER)) {
    prompt += '\n\n' + (isQuestion ? QUESTION_SUMMARY_INSTRUCTION : SUMMARY_SECTION_INSTRUCTION)
  }
  // Droit de poser une question — réservé aux items de la file de travaux : ce sont
  // les seuls dont la carte sait afficher la question et récolter la réponse. Une
  // tâche de la bulle d'aide qui la poserait parlerait dans le vide.
  if (next.work_prompt_id) prompt += ASK_USER_INSTRUCTION

  // Detached + durable: the result is recorded off a .code file, so a `pm2 restart`
  // triggered by the implementation itself can't lose the success and leave the task
  // wrongly "blocked". monitorExecution() handles streaming + finalization.
  // Question → outils lecture seule : l'agent ne peut physiquement rien implémenter.
  runDetachedExecution(next.id, prompt, {
    model: runModel, effort: next.effort,
    tools: isQuestion ? READONLY_TOOLS : EXEC_TOOLS,
    resumeSessionId: next.resume_session_id || null,
    lane,
  })
}

// ─── Création d'une tâche prête à exécuter (file de prompts) ───────────────────
// La file de travaux passe par ici plutôt que d'écrire dans agent-tasks.json
// elle-même : l'ordonnanceur, la diffusion temps réel et le format de tâche
// restent la propriété de ce module.
export function enqueueAgentTask({
  title, description, kind = 'queue', mode = 'implement', model = AGENT_MODEL,
  effort = 'high', priority = 0, author = '', work_prompt_id = null,
  resume_session_id = null,
}) {
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(),
    kind,
    mode: mode === 'question' ? 'question' : 'implement',
    title: title || (description || '').slice(0, 140),
    description: description || '',
    context: '',
    author,
    model, effort,
    status: 'approved',
    priority,
    messages: [],
    user_comment: null,
    agent_result: null,
    user_summary: null,
    work_prompt_id,
    resume_session_id,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  broadcastTask(task)
  setImmediate(kick)
  return task
}

export function findAgentTask(id) { return readTasks().find(t => t.id === id) || null }

/**
 * Retouche d'une tâche remise à l'ordonnanceur mais PAS ENCORE démarrée : c'est ce
 * qui rend le prompt d'un item « en attente » réellement modifiable. Refuse dès que
 * la tâche a quitté l'état « approved » — une exécution lancée lit son prompt une
 * fois pour toutes, la retoucher donnerait une carte qui ment.
 *
 * Pas de course possible : executeTask() passe la tâche à `in_progress` de façon
 * synchrone AVANT de lancer le process, donc `status === 'approved'` garantit ici
 * qu'aucun Claude ne tourne pour elle.
 */
export function updatePendingAgentTask(id, patch = {}) {
  if (!id) return false
  const task = readTasks().find(t => t.id === id)
  if (!task || task.status !== 'approved') return false
  const allowed = ['title', 'description', 'model', 'effort', 'mode']
  const updates = {}
  for (const k of allowed) if (patch[k] !== undefined) updates[k] = patch[k]
  if (!Object.keys(updates).length) return true
  const updated = updateTask(id, updates)
  if (updated) broadcastTask(updated)
  return true
}

/**
 * Reprise d'une tâche jamais démarrée : la file de travaux la retire de
 * l'ordonnanceur pour redonner la main à l'utilisateur (réordonner, mettre de côté,
 * supprimer). Même garantie que ci-dessus : refuse si l'exécution a commencé.
 */
export function cancelPendingAgentTask(id) {
  if (!id) return false
  const task = readTasks().find(t => t.id === id)
  if (!task || task.status !== 'approved') return false
  const updated = updateTask(id, {
    status: 'cancelled',
    completed_at: new Date().toISOString(),
    agent_result: '(reprise dans la file avant tout démarrage)',
  })
  if (updated) broadcastTask(updated)
  return true
}

// ─── Conversation reply (read-only) ───────────────────────────────────────────
function conversationReply(task) {
  busy = true
  currentTaskId = task.id
  currentActivity = 'conversation'

  const thread = (task.messages || [])
    .map(m => `${m.role === 'user' ? 'Humain' : 'Agent'}: ${m.text}`)
    .join('\n')

  const prompt = renderTemplate(promptTemplate('conversationPrompt'), {
    general: generalPrompt(),
    proposal: task.title || task.description,
    why: task.why ? `Pourquoi: ${task.why}\n` : '',
    zone: task.zone ? `Zone visée: ${task.zone}\n` : '',
    thread,
  })

  spawnClaude({ prompt, allowedTools: READONLY_TOOLS, timeoutMs: READONLY_TIMEOUT_MS })
    .then(({ text }) => {
      const reply = (text || '').trim() || '(pas de réponse)'
      const fresh = readTasks().find(t => t.id === task.id)
      if (fresh) {
        const messages = [...(fresh.messages || []), { role: 'agent', text: reply, at: new Date().toISOString() }]
        const updated = updateTask(task.id, { messages, status: fresh.status === 'pending' ? 'in_discussion' : fresh.status })
        if (updated) broadcastTask(updated)
      }
      releaseSlot()
    })
}

// ─── Orphan / lifecycle (preserved from the original runner) ──────────────────
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function initTaskRunner() {
  // Reconnect to an orphaned execution Claude from a previous server instance.
  // monitorExecution() finalizes off the durable .code file, so an exec that finished
  // successfully WHILE the server was restarting (e.g. it ran `pm2 restart erp-server`
  // itself) is correctly marked DONE — not blocked. If the child already finished, the
  // first poll detects the .code file immediately; if it's still running, we tail it; if
  // it crashed without a .code file, it's marked blocked.
  // Les tâches dont on a repris le suivi ne doivent PAS être marquées bloquées
  // plus bas — elles tournent encore (ou viennent de finir, le .code fait foi).
  const reconnected = new Set()

  if (existsSync(PID_FILE)) {
    try {
      const [pidStr, taskId] = readFileSync(PID_FILE, 'utf8').trim().split('\n')
      const pid = parseInt(pidStr, 10)
      const t = taskId && readTasks().find(x => x.id === taskId)
      if (t && t.status === 'in_progress') {
        console.log(`🤖 Agent: exécution orpheline détectée (PID ${pid}, tâche ${taskId}) — reprise du suivi…`)
        busy = true
        currentTaskId = taskId
        currentActivity = 'execution'
        reconnected.add(taskId)
        monitorExecution(taskId, pid || null)
      }
    } catch {}
    if (!reconnected.size) {
      // Stale PID file (task already finalized / gone) → clean up its artifacts.
      try {
        const taskId = readFileSync(PID_FILE, 'utf8').trim().split('\n')[1]
        if (taskId) { for (const f of [EXEC_LOG(taskId), EXEC_CODE(taskId), EXEC_PROMPT(taskId), EXEC_INBOX(taskId)]) { try { unlinkSync(f) } catch {} } }
      } catch {}
      try { unlinkSync(PID_FILE) } catch {}
    }
  }

  // Même reprise pour la voie lecture seule, mais un fichier PID par tâche : une
  // question orpheline se rattache indépendamment de l'implémentation en cours.
  for (const f of (() => { try { return readdirSync(DATA_DIR) } catch { return [] } })()) {
    const m = f.match(/^\.agent-qpid-(.+)$/)
    if (!m) continue
    const taskId = m[1]
    const full = resolve(DATA_DIR, f)
    let pid = null
    try { pid = parseInt(readFileSync(full, 'utf8').trim().split('\n')[0], 10) } catch {}
    const t = readTasks().find(x => x.id === taskId)
    if (t && t.status === 'in_progress') {
      console.log(`🤖 Agent: question orpheline détectée (PID ${pid}, tâche ${taskId}) — reprise du suivi…`)
      _questionRuns.add(taskId)
      reconnected.add(taskId)
      monitorExecution(taskId, pid || null, { lane: 'question' })
    } else {
      try { unlinkSync(full) } catch {}
      for (const g of [EXEC_LOG(taskId), EXEC_CODE(taskId), EXEC_PROMPT(taskId), EXEC_INBOX(taskId)]) { try { unlinkSync(g) } catch {} }
    }
  }

  // An execution interrupted by a server restart is marked BLOCKED (needs a human),
  // never silently re-approved. Re-approving created a runaway: an execution that
  // ran `pm2 restart erp-server` would be re-queued on every boot and loop forever.
  const tasks = readTasks()
  let changed = false
  for (const t of tasks) {
    if (t.status === 'in_progress' && !reconnected.has(t.id)) {
      t.status = 'blocked'
      t.agent_result = (t.agent_result ? t.agent_result + '\n' : '') +
        '(exécution interrompue par un redémarrage serveur — relancer manuellement si besoin)'
      t.updated_at = new Date().toISOString()
      changed = true
    }
  }
  if (changed) writeTasks(tasks)

  // Rattrapage différé des compte-rendus manquants sur les cartes déjà terminées
  // (laisse le serveur finir de démarrer avant de spawner des subprocess).
  const backfillTimer = setTimeout(() => { backfillUserSummaries().catch(() => {}) }, 15_000)
  backfillTimer.unref?.()

  // Quota hebdomadaire propre au modèle (fable) : lu directement dans les quotas de
  // l'abonnement pour basculer sur le repli AVANT de jeter une exécution dans le mur —
  // et pour revenir à fable dès que son plafond est réinitialisé. Toutes les 5 min ;
  // la lecture est mise en cache 60 s côté claudeUsage, donc le coût est négligeable.
  const syncLimits = () => syncScopedModelLimit()
    .then(changed => { if (changed) { rearmLimitTimer(); kick() } })
    .catch(() => {})
  setTimeout(syncLimits, 5_000).unref?.()
  setInterval(syncLimits, 5 * 60_000).unref?.()

  setImmediate(kick)
}

export function shutdownTaskRunner() {
  // Execution Claude is detached and finishes as an orphan; PID file persists for reconnect.
}
```

---

## 7. Backend — modules satellites


### `services/agentModel.js` — modèle préféré et repli quand son quota est épuisé

```js
// ─── Modèle de l'agent autonome + repli quand SON quota est épuisé ─────────────
//
// L'agent tourne sur `fable` (le modèle le plus capable de l'abonnement). Or
// l'abonnement porte un plafond hebdomadaire PROPRE à ce modèle — la limite
// `weekly_scoped` de /api/oauth/usage, cf. claudeUsage.js : Fable peut refuser de
// travailler alors que la fenêtre de 5 h et le total hebdomadaire (tous modèles) sont
// encore au vert. Avant, ce refus mettait toute la file en pause pendant des jours,
// jusqu'à la réinitialisation hebdomadaire.
//
// Ce module tient donc un registre des quotas épuisés PAR MODÈLE et résout, à chaque
// démarrage d'exécution, le modèle réellement utilisable :
//
//     fable épuisé  →  opus  (le travail continue)
//     les deux épuisés  →  plus rien ne démarre, l'ordonnanceur attend la réinit.
//
// Deux sources alimentent le registre :
//   1. RÉACTIVE  — une exécution s'est heurtée au mur (`rate_limit_event` dans son
//      transcript). On demande alors aux quotas de l'abonnement si c'est le plafond
//      DU MODÈLE (→ repli) ou un plafond de compte (→ tout est bloqué, on attend).
//   2. PROACTIVE — lecture périodique des quotas : quand le plafond Fable est déjà à
//      100 %, on bascule sur Opus AVANT de brûler une exécution dans le mur.
//
// Volontairement sans état persistant : un redémarrage relit les quotas (source 2) en
// quelques secondes, et une mauvaise attribution s'auto-corrige au passage suivant.

import { getClaudeUsage } from './claudeUsage.js'

/** Modèle préféré de l'agent — tout ce qui n'est pas explicitement bridé passe par lui. */
export const AGENT_MODEL = 'fable'

/** Chaîne de repli : modèle → modèle à emprunter quand son quota est épuisé. */
export const MODEL_FALLBACK = Object.freeze({ fable: 'opus' })

/** Modèles que l'agent sait utiliser (un plafond de COMPTE les bloque tous). */
export const KNOWN_MODELS = Object.freeze(['fable', 'opus', 'sonnet', 'haiku'])

// modèle → { resetAt: epoch ms, label: '01:59 UTC', source: 'run' | 'usage' }
const _limits = new Map()

/** Modèles empruntables pour ce travail, du préféré au dernier repli. */
export function modelChain(model = AGENT_MODEL) {
  const chain = []
  let m = model || AGENT_MODEL
  while (m && !chain.includes(m)) {
    chain.push(m)
    m = MODEL_FALLBACK[m]
  }
  return chain
}

/** Purge les quotas dont l'heure de réinitialisation est passée. Renvoie true si ça a bougé. */
export function purgeExpiredLimits(now = Date.now()) {
  let changed = false
  for (const [model, entry] of _limits) {
    if (!entry?.resetAt || entry.resetAt <= now) { _limits.delete(model); changed = true }
  }
  return changed
}

export function isModelLimited(model, now = Date.now()) {
  const entry = _limits.get(model)
  if (!entry) return false
  if (entry.resetAt <= now) { _limits.delete(model); return false }
  return true
}

/**
 * Modèle réellement utilisable pour ce travail : le préféré s'il a encore du quota,
 * sinon son repli. `null` = toute la chaîne est à sec → rien ne peut démarrer.
 */
export function resolveModel(model = AGENT_MODEL, now = Date.now()) {
  for (const m of modelChain(model)) if (!isModelLimited(m, now)) return m
  return null
}

/**
 * Instant où cette chaîne redevient utilisable — 0 si elle l'est déjà. C'est ce que
 * l'ordonnanceur affiche comme « pause forcée » : tant que le repli tient, la file
 * n'est PAS à l'arrêt et on ne raconte donc pas qu'elle l'est.
 */
export function chainAvailableAt(model = AGENT_MODEL, now = Date.now()) {
  const chain = modelChain(model)
  if (chain.some(m => !isModelLimited(m, now))) return 0
  return Math.min(...chain.map(m => _limits.get(m)?.resetAt || 0))
}

/** Prochaine réinitialisation connue, tous modèles confondus (0 = aucun quota épuisé). */
export function nextLimitExpiryAt() {
  let at = 0
  for (const entry of _limits.values()) {
    if (!entry?.resetAt) continue
    if (!at || entry.resetAt < at) at = entry.resetAt
  }
  return at
}

/**
 * Marque un (ou plusieurs) modèle(s) sans quota jusqu'à `resetAt`. Une marque plus
 * lointaine ne recule jamais : deux signaux pour la même fenêtre ne se contredisent pas.
 */
export function noteModelLimit(models, { resetAt, label = '', source = 'run' } = {}, now = Date.now()) {
  const safe = resetAt > now ? resetAt : now + 15 * 60_000
  let changed = false
  for (const model of [].concat(models)) {
    if (!model) continue
    const prev = _limits.get(model)
    if (prev && prev.resetAt >= safe) continue
    _limits.set(model, { resetAt: safe, label: label || '', source })
    changed = true
  }
  return changed
}

/** Lève la marque d'un modèle (quota revenu, ou attribution corrigée par les quotas réels). */
export function clearModelLimit(model) {
  return _limits.delete(model)
}

/** Vide le registre — réservé aux tests. */
export function resetModelLimits() { _limits.clear() }

/** État lisible pour l'UI : modèle préféré, modèle réellement actif, quotas épuisés. */
export function agentModelState(model = AGENT_MODEL, now = Date.now()) {
  const active = resolveModel(model, now)
  const preferredEntry = _limits.get(model)
  return {
    preferred: model,
    active,                                   // null = toute la chaîne est à sec
    fallback: MODEL_FALLBACK[model] || null,
    fallbackActive: !!active && active !== model,
    preferredResetAt: preferredEntry ? new Date(preferredEntry.resetAt).toISOString() : null,
    limited: [..._limits.entries()].map(([m, e]) => ({
      model: m,
      resetAt: new Date(e.resetAt).toISOString(),
      source: e.source,
    })),
  }
}

// ─── Attribution d'un refus : plafond du modèle, ou plafond du compte ? ────────
//
// Le `rate_limit_event` du transcript ne dit PAS quel plafond a sauté. Les quotas de
// l'abonnement, eux, le disent : si la fenêtre de 5 h ou le total hebdomadaire est à
// 100 %, aucun modèle ne passera — inutile de tenter le repli. Sinon, le refus vient
// du plafond propre au modèle et le repli a toutes ses chances.
//
// Quotas illisibles (token expiré, hors-ligne) → on privilégie la CONTINUITÉ : on
// tente le repli. S'il se heurte au même mur, sa propre marque épuise la chaîne et
// l'ordonnanceur s'arrête au tour suivant — un aller-retour perdu, pas une file morte.
export function attributeLimitScope(usage) {
  const pct = b => (Number.isFinite(b?.utilizationPct) ? b.utilizationPct : null)
  const exhausted = v => v != null && v >= 100
  if (!usage) return 'model'
  // Crédits de dépassement actifs = le plafond n'arrête rien ; on ne conclut pas au
  // blocage de compte sur cette seule base.
  if (usage.extraUsageEnabled) return 'model'
  if (exhausted(pct(usage.session)) || exhausted(pct(usage.week))) return 'account'
  return 'model'
}

export async function fetchLimitScope() {
  try { return attributeLimitScope(await getClaudeUsage()) } catch { return 'model' }
}

// ─── Lecture proactive du plafond par modèle ───────────────────────────────────

/**
 * Traduit la limite `weekly_scoped` des quotas en verdict sur UN modèle.
 * `null` = les quotas ne disent rien d'exploitable (pas de plafond par modèle, libellé
 * inconnu, crédits de dépassement actifs).
 */
export function scopedLimitFromUsage(usage, now = Date.now()) {
  const scoped = usage?.weekScoped
  if (!scoped || usage.extraUsageEnabled) return null
  const label = String(scoped.label || '').toLowerCase()
  const model = KNOWN_MODELS.find(m => label.includes(m))
  if (!model) return null
  const pct = Number.isFinite(scoped.utilizationPct) ? scoped.utilizationPct : null
  const resetAt = Date.parse(scoped.resetsAt || '') || 0
  if (pct == null || pct < 100 || !resetAt || resetAt <= now) return { model, limited: false }
  return {
    model,
    limited: true,
    resetAt,
    label: new Date(resetAt).toISOString().slice(11, 16) + ' UTC',
  }
}

/**
 * Aligne le registre sur les quotas réels de l'abonnement. Renvoie true si l'état a
 * changé (l'ordonnanceur en profite pour relancer la file).
 *
 * Le nettoyage compte autant que la pose : quand les quotas montrent le plafond du
 * modèle au vert ET aucun plafond de compte atteint, une marque qui traîne (refus
 * ponctuel attribué au modèle par défaut) est fausse — on la lève, sinon l'agent
 * resterait sur son repli pendant des heures sans raison.
 */
export async function syncScopedModelLimit() {
  let usage
  try { usage = await getClaudeUsage() } catch { return false }
  const verdict = scopedLimitFromUsage(usage)
  if (!verdict) return purgeExpiredLimits()
  if (verdict.limited) {
    return noteModelLimit([verdict.model], {
      resetAt: verdict.resetAt, label: verdict.label, source: 'usage',
    })
  }
  const accountBlocked = attributeLimitScope(usage) === 'account'
  if (!accountBlocked && _limits.has(verdict.model)) return clearModelLimit(verdict.model)
  return purgeExpiredLimits()
}
```

### `services/promptTitle.js` — titres automatiques (heuristique + modèle + titre de projet)

```js
// Titre automatique d'un prompt de la file de travaux.
//
// L'utilisateur écrit (souvent dicte) son prompt comme il l'écrirait dans le
// terminal : plusieurs phrases, du remplissage oral, aucun titre. Jusqu'ici la
// carte affichait les 120 premiers caractères du texte brut — illisible dans la
// file comme dans le recap Slack. Deux étages :
//
//   1. `heuristicTitle()` — synchrone et déterministe : la première phrase
//      nettoyée. Posé à la création, donc jamais de carte sans titre lisible même
//      si le modèle est indisponible.
//   2. `refineTitle()` — un passage modèle sans outils (haiku, effort bas) qui
//      nomme la NATURE de la tâche en une ligne. Best-effort : au moindre doute
//      sur la réponse, on retourne null et l'heuristique reste en place.
//
// Le titre n'est jamais généré quand l'utilisateur en a saisi un (voir
// promptQueue.createPrompt), et une retouche manuelle n'est jamais écrasée.
import { runToollessClaude } from './taskRunner.js'

export const MAX_TITLE_LEN = 80

const TITLE_TIMEOUT_MS = 90_000

/** Coupe au dernier mot entier avant `max`, avec points de suspension. */
function truncateWords(s, max = MAX_TITLE_LEN) {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, '') + '…'
}

function capitalize(s) {
  return s ? s[0].toLocaleUpperCase('fr-CA') + s.slice(1) : s
}

/**
 * Titre déterministe tiré du prompt : première ligne non vide, débarrassée de sa
 * puce / numérotation, réduite à sa première phrase si elle est longue.
 */
export function heuristicTitle(prompt) {
  const line = String(prompt || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l) || ''

  let t = line
    .replace(/^[-*•>#]+\s*/, '')        // puce ou citation markdown
    .replace(/^\d+[.)]\s+/, '')         // « 1. » / « 2) »
    .replace(/\*\*/g, '')               // gras markdown
    .replace(/\s+/g, ' ')
    .trim()

  // Trop long pour tenir : on garde la première phrase si elle suffit.
  if (t.length > MAX_TITLE_LEN) {
    const m = /[.!?](\s|$)/.exec(t)
    if (m && m.index > 15 && m.index <= MAX_TITLE_LEN) t = t.slice(0, m.index)
  }

  t = truncateWords(t.replace(/[.\s]+$/, ''))
  return capitalize(t) || 'Sans titre'
}

/**
 * Nettoie la réponse du modèle. Retourne null si elle ne ressemble pas à un
 * titre (préambule, refus, JSON, paragraphe) — mieux vaut garder l'heuristique
 * qu'afficher une phrase de conversation en titre de carte.
 */
export function sanitizeModelTitle(text) {
  const first = String(text || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l) || ''

  let t = first
    .replace(/^```.*$/, '')
    .replace(/^(?:titre|title)\s*[:—-]\s*/i, '')
    .replace(/^[«"'`*\s]+|[»"'`*\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/, '')
    .trim()

  if (t.length < 3) return null
  if (t.length > 140) return null                       // paragraphe, pas un titre
  if (/^[[{]/.test(t)) return null                      // JSON
  if (/\b(je ne peux|désolé|voici (le|un) titre|as an ai)\b/i.test(t)) return null

  return capitalize(truncateWords(t))
}

const TITLE_PROMPT = (prompt) => [
  'Tu nommes une tâche dans la file de travaux d\'un ERP (ventes, logistique, assemblage, comptabilité, RH). ',
  'À partir de la demande ci-dessous, écris UN titre court en français qui reflète la nature de la tâche ',
  '(ce qui va changer et où), au maximum 8 mots. ',
  'Commence par un verbe à l\'infinitif ou un groupe nominal, sans point final, sans guillemets, sans préambule. ',
  'La demande est souvent dictée à la voix : ignore le remplissage oral (« tu comprends », « merci », « dans le fond ») ',
  'et garde uniquement l\'intention.\n\n',
  'Exemples de bons titres : « Titre automatique des prompts de la file », « Corriger l\'erreur à l\'ouverture de la fin de mois », ',
  '« Adapter le formulaire de paiement selon le moyen ».\n\n',
  'Ne réponds QUE par le titre, sur une seule ligne.\n\n',
  '--- Demande ---\n',
  String(prompt || '').slice(0, 4000),
].join('')

/**
 * Titre proposé par le modèle, ou null (échec, timeout, réponse douteuse).
 * Ne lève jamais : l'appelant garde son titre heuristique.
 */
export async function refineTitle(prompt) {
  const text = String(prompt || '').trim()
  if (!text) return null
  try {
    const { text: out } = await runToollessClaude({
      prompt: TITLE_PROMPT(text),
      model: 'haiku',
      effort: 'low',
      timeoutMs: TITLE_TIMEOUT_MS,
    })
    return sanitizeModelTitle(out)
  } catch {
    return null
  }
}

// ─── Titre dynamique : le fil de discussion est le projet ─────────────────────
// Un item de la file n'est pas figé à sa première phrase : l'humain répond, la
// demande se précise ou change de cap, l'agent rend compte. Le titre suit donc le
// FIL et pas seulement le prompt d'origine.

const MSG_MAX_CHARS = 600
const DIGEST_MAX_CHARS = 6000
const MAX_MESSAGES = 12

/**
 * Résumé lisible du fil pour le modèle : la demande d'origine puis les derniers
 * tours dans l'ordre. On garde la FIN du fil (le cap le plus récent l'emporte) et
 * chaque message est écourté — un titre n'a pas besoin des détails.
 */
export function buildThreadDigest(prompt, messages = []) {
  const clip = s => {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    return t.length > MSG_MAX_CHARS ? t.slice(0, MSG_MAX_CHARS) + '…' : t
  }
  const turns = (Array.isArray(messages) ? messages : [])
    .slice(-MAX_MESSAGES)
    .map(m => `${m.role === 'agent' ? 'Claude' : 'Humain'} : ${clip(m.text)}`)
    .filter(l => l.length > 12)

  const head = `Demande d'origine : ${clip(prompt)}`
  const digest = [head, ...turns].join('\n')
  return digest.length > DIGEST_MAX_CHARS ? '…' + digest.slice(-DIGEST_MAX_CHARS) : digest
}

const PROJECT_TITLE_PROMPT = ({ digest, current }) => [
  'Tu nommes un PROJET dans la file de travaux d\'un ERP (ventes, logistique, assemblage, comptabilité, RH). ',
  'Un projet, ici, c\'est un fil de discussion : une demande d\'origine puis des échanges qui la précisent ',
  'ou la font évoluer.\n\n',
  'Écris le titre qui reflète la nature du projet TEL QU\'IL EST MAINTENANT, au maximum 8 mots, en français. ',
  'Le cap le plus récent de l\'humain compte plus que la formulation d\'origine : si l\'échange a élargi ou ',
  'déplacé la demande, le titre doit le montrer. ',
  'Les messages sont souvent dictés à la voix : ignore le remplissage oral (« tu comprends », « merci », ',
  '« dans le fond ») et garde l\'intention.\n\n',
  current
    ? `Titre actuel : « ${current} ». S'il décrit encore correctement le projet, réponds-le mot pour mot au lieu d'en inventer un autre.\n\n`
    : '',
  'Sans point final, sans guillemets, sans préambule. Ne réponds QUE par le titre, sur une seule ligne.\n\n',
  '--- Fil ---\n',
  digest,
].join('')

/**
 * Titre du projet déduit du fil complet, ou null si le modèle échoue / répond
 * autre chose qu'un titre. Ne lève jamais.
 */
export async function refineProjectTitle({ prompt, messages = [], current = '' }) {
  const digest = buildThreadDigest(prompt, messages)
  if (!digest.trim()) return null
  try {
    const { text: out } = await runToollessClaude({
      prompt: PROJECT_TITLE_PROMPT({ digest, current: String(current || '').trim() }),
      model: 'haiku',
      effort: 'low',
      timeoutMs: TITLE_TIMEOUT_MS,
    })
    return sanitizeModelTitle(out)
  } catch {
    return null
  }
}
```

### `services/workSuggestions.js` — moteurs de suggestions (chantiers + intégrations)

⚠️ Importe `listRecurringTasks` de `recurringWork.js` (module exclu) : stub `() => []`, voir §10.2.

```js
// Moteur de recommandations (page /travaux, onglet « Suggestions de Claude »).
//
// Liste SÉPARÉE de la file humaine : l'agent y dépose des prompts qu'il juge
// pertinents, l'utilisateur les promeut (ou les rejette) — rien ne s'exécute sans
// promotion. Le signal le plus fort vient des travaux récurrents encore faits à la
// main : chaque ligne cochée chaque semaine est un candidat à l'automatisation.
//
// Le modèle n'explore PAS le repo : le contexte lui est fourni ici (git log,
// travaux récurrents, file récente, erreurs de sync). Il tourne donc sans outils,
// en parallèle d'une exécution, sans jamais lire un fichier à moitié écrit.
import { randomUUID, createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import { runToollessClaude } from './taskRunner.js'
import { AGENT_MODEL } from './agentModel.js'
import { createPrompt } from './promptQueue.js'
import { listRecurringTasks } from './recurringWork.js'

const REPO = '/home/ec2-user/erp'
const MAX_NEW_PER_RUN = 5
const MAX_NEW_INTEGRATIONS_PER_RUN = 3

// Deux natures de suggestions dans la même liste :
//   'chantier'    — un travail à faire dans l'ERP tel qu'il est aujourd'hui ;
//   'integration' — un logiciel / une API externe à brancher, et ce que ça
//                   débloquerait une fois branché.
export const SUGGESTION_KINDS = ['chantier', 'integration']

export function normalizeKind(kind) {
  return SUGGESTION_KINDS.includes(kind) ? kind : 'chantier'
}

function broadcast() { broadcastAll({ type: 'travaux:suggestions:updated' }) }

// Empreinte de déduplication : titre normalisé (accents, ponctuation et casse
// écartés). Une reformulation cosmétique de la même idée ne revient donc pas.
export function fingerprintOf(title) {
  const norm = String(title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return createHash('sha1').update(norm).digest('hex')
}

export function listSuggestions({ status = null, kind = null } = {}) {
  const where = ['deleted_at IS NULL']
  const params = []
  if (status) { where.push('status=?'); params.push(status) }
  if (kind) { where.push('kind=?'); params.push(kind) }
  return db.prepare(`SELECT * FROM work_suggestions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...params)
}

/** Insère une suggestion ; retourne null si l'empreinte existe déjà (doublon). */
export function addSuggestion({ title, rationale = null, prompt, area = null, kind = 'chantier' }) {
  const t = String(title || '').trim()
  const p = String(prompt || '').trim()
  if (!t || !p) return null
  const fp = fingerprintOf(t)
  const exists = db.prepare('SELECT id FROM work_suggestions WHERE fingerprint=?').get(fp)
  if (exists) return null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_suggestions (id, title, rationale, prompt, area, kind, fingerprint)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, t, rationale, p, area, normalizeKind(kind), fp)
  broadcast()
  return db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id)
}

/** Promeut une suggestion dans la file de prompts de l'utilisateur. */
export function acceptSuggestion(id, { userId = null, overridePrompt = null, space = 'finance' } = {}) {
  const s = db.prepare('SELECT * FROM work_suggestions WHERE id=? AND deleted_at IS NULL').get(id)
  if (!s) return null
  if (s.status === 'accepted' && s.work_prompt_id) return { suggestion: s, prompt_id: s.work_prompt_id }
  const created = createPrompt({
    title: s.title,
    prompt: String(overridePrompt || s.prompt),
    created_by: userId,
    suggestion_id: s.id,
    // La suggestion rejoint la file de la section d'où on l'accepte (finance/agent).
    space,
  })
  db.prepare(`UPDATE work_suggestions SET status='accepted', work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(created.id, id)
  broadcast()
  return { suggestion: db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id), prompt_id: created.id }
}

export function dismissSuggestion(id, reason = null) {
  const s = db.prepare('SELECT id FROM work_suggestions WHERE id=? AND deleted_at IS NULL').get(id)
  if (!s) return null
  // Le rejet conserve la ligne (et donc l'empreinte) : la même idée ne sera pas
  // resuggérée au prochain passage du moteur.
  db.prepare(`UPDATE work_suggestions SET status='dismissed', dismissed_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(reason, id)
  broadcast()
  return db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id)
}

export function deleteSuggestion(id) {
  db.prepare(`UPDATE work_suggestions SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  broadcast()
  return true
}

// ─── Contexte fourni au modèle ────────────────────────────────────────────────

function gitLog(n = 40) {
  try {
    return execFileSync('git', ['log', `-${n}`, '--pretty=format:%ad %s', '--date=short'], { cwd: REPO, encoding: 'utf8' })
  } catch { return '' }
}

export function buildContextDigest() {
  const recurring = listRecurringTasks()
    .map(t => `- [${t.cadence}${t.owner ? '/' + t.owner : ''}] ${t.label}${t.notes ? ` (${t.notes})` : ''}`)
    .join('\n')

  const recentPrompts = db.prepare(`
    SELECT title, status FROM work_prompts WHERE deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 25
  `).all().map(p => `- (${p.status}) ${p.title}`).join('\n')

  const known = db.prepare(`
    SELECT title, status FROM work_suggestions WHERE deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 60
  `).all().map(s => `- ${s.title}`).join('\n')

  let syncErrors = ''
  try {
    syncErrors = db.prepare(`
      SELECT module, error_message FROM sync_log
      WHERE status='error' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')
      ORDER BY created_at DESC LIMIT 15
    `).all().map(r => `- ${r.module}: ${String(r.error_message || '').slice(0, 160)}`).join('\n')
  } catch {}

  return { recurring, recentPrompts, known, gitLog: gitLog(), syncErrors }
}

const SUGGESTION_PROMPT = ({ recurring, recentPrompts, known, gitLog: log, syncErrors }) => [
  'Tu observes l\'évolution de l\'ERP Orisha (app single-tenant : ventes, logistique, assemblage, comptabilité, RH). ',
  'Ton rôle ici est de RECOMMANDER des prochains chantiers, pas de coder.\n\n',
  'Signal le plus important — les travaux que l\'utilisateur fait ENCORE À LA MAIN chaque semaine/mois/trimestre :\n',
  recurring || '(aucun)', '\n\n',
  'Chantiers récents (commits) :\n', log || '(aucun)', '\n\n',
  'Prompts récents de l\'utilisateur (sa direction actuelle) :\n', recentPrompts || '(aucun)', '\n\n',
  syncErrors ? `Erreurs de synchronisation des 14 derniers jours :\n${syncErrors}\n\n` : '',
  'Suggestions DÉJÀ proposées (ne les répète pas, même reformulées) :\n', known || '(aucune)', '\n\n',
  `Propose au maximum ${MAX_NEW_PER_RUN} nouveaux chantiers, classés du plus utile au moins utile. `,
  'Privilégie : automatiser un travail manuel récurrent listé plus haut, fermer une boucle laissée ouverte par un chantier récent, ',
  'ou supprimer une source d\'erreur récurrente. Chaque suggestion doit être réalisable en une seule séance de travail.\n\n',
  'Réponds UNIQUEMENT par un tableau JSON, sans texte autour, de la forme :\n',
  '[{"title":"titre court","area":"comptabilité|ventes|logistique|RH|technique","rationale":"pourquoi maintenant, 1-2 phrases",',
  '"prompt":"le prompt complet à donner à un agent qui implémentera le chantier, en français, précis sur le comportement attendu"}]\n',
  'Si tu n\'as rien de solide à proposer, réponds [].',
].join('')

/** Extrait le tableau JSON de la réponse, tolérant à un éventuel enrobage. */
export function parseSuggestionsJson(text) {
  const raw = String(text || '').trim()
  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1])
  const bracket = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
  if (bracket) candidates.push(bracket)
  candidates.push(raw)
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (Array.isArray(parsed)) return parsed
    } catch {}
  }
  return []
}

/**
 * Un passage du moteur : demande des recommandations et insère les nouvelles.
 * Idempotent par empreinte de titre — repasser deux fois n'empile pas de doublons.
 */
export async function generateSuggestions() {
  const digest = buildContextDigest()
  const { text } = await runToollessClaude({
    prompt: SUGGESTION_PROMPT(digest),
    model: AGENT_MODEL,
    effort: 'high',
    timeoutMs: 6 * 60_000,
  })
  const items = parseSuggestionsJson(text).slice(0, MAX_NEW_PER_RUN)
  let added = 0
  for (const it of items) {
    if (addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area })) added++
  }
  console.log(`🤖 Suggestions de travaux : ${items.length} proposée(s), ${added} nouvelle(s)`)
  return { proposed: items.length, added }
}

// ─── Second moteur : logiciels / API à brancher ───────────────────────────────
//
// Même liste, autre question : « qu'est-ce qu'on gagnerait à connecter un outil
// externe de plus ? ». Le modèle a besoin de savoir ce qui est DÉJÀ branché,
// sinon il repropose Stripe et QuickBooks — d'où l'inventaire ci-dessous, monté
// depuis les connexions OAuth réelles et les clés d'API présentes (jamais leur
// valeur, seulement leur présence).

// Vendeurs dont une clé en environnement vaut « déjà intégré ». Liste explicite :
// on n'énumère pas process.env à l'aveugle.
const ENV_VENDORS = [
  ['Stripe', 'STRIPE_SECRET_KEY'],
  ['QuickBooks', 'QB_CLIENT_ID'],
  ['Airtable', 'AIRTABLE_CLIENT_ID'],
  ['Google (Gmail/Drive/Sheets)', 'GOOGLE_CLIENT_ID'],
  ['HubSpot', 'HUBSPOT_CLIENT_ID'],
  ['Postmark (envoi de courriels)', 'POSTMARK_API_KEY'],
  ['OpenAI', 'OPENAI_API_KEY'],
  ['Novoxpress (transporteurs)', 'NOVOXPRESS_API_KEY'],
  ['Twilio', 'TWILIO_AUTH_TOKEN'],
  ['Amazon Business', 'AMAZON_CLIENT_ID'],
  ['Slack (webhook entrant)', 'SLACK_WEBHOOK_PERSO'],
  ['Ingestion FTP (Cube ARC, étiquettes)', 'FTP_INGEST_SECRET'],
]

/** Inventaire des outils externes déjà branchés, pour ne pas les reproposer. */
export function buildIntegrationDigest() {
  let oauth = ''
  try {
    oauth = db.prepare(`
      SELECT connector, account_email FROM connector_oauth ORDER BY connector
    `).all().map(r => `- ${r.connector}${r.account_email ? ` (${r.account_email})` : ''}`).join('\n')
  } catch {}

  const envTools = ENV_VENDORS
    .filter(([, key]) => String(process.env[key] || '').trim())
    .map(([label]) => `- ${label}`).join('\n')

  // Périmètre fonctionnel couvert : les pages de l'app suffisent à situer ce que
  // l'ERP fait déjà, sans faire lire le code au modèle.
  let pages = ''
  try {
    pages = readdirSync(`${REPO}/client/src/pages`)
      .filter(f => f.endsWith('.jsx'))
      .map(f => f.replace(/\.jsx$/, ''))
      .join(', ')
  } catch {}

  const recurring = listRecurringTasks()
    .map(t => `- [${t.cadence}${t.owner ? '/' + t.owner : ''}] ${t.label}`)
    .join('\n')

  const known = db.prepare(`
    SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND kind='integration'
    ORDER BY created_at DESC LIMIT 60
  `).all().map(s => `- ${s.title}`).join('\n')

  return { oauth, envTools, pages, recurring, known }
}

const INTEGRATION_PROMPT = ({ oauth, envTools, pages, recurring, known }) => [
  'Orisha conçoit, fabrique et vend en direct des produits IoT de contrôle climatique pour serres (Québec, clients CA/US). ',
  'Son ERP interne single-tenant couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards.\n\n',
  'Ta mission ici : proposer des LOGICIELS ou des API EXTERNES à brancher à cet ERP, et ce que chaque branchement débloquerait concrètement. ',
  'Tu ne codes pas, tu recommandes.\n\n',
  'Déjà branché — connexions OAuth actives :\n', oauth || '(aucune)', '\n\n',
  'Déjà branché — clés d\'API présentes :\n', envTools || '(aucune)', '\n\n',
  'Périmètre fonctionnel actuel (pages de l\'ERP) :\n', pages || '(inconnu)', '\n\n',
  'Travaux encore faits À LA MAIN chaque semaine/mois (souvent le meilleur candidat à un branchement) :\n',
  recurring || '(aucun)', '\n\n',
  'Intégrations DÉJÀ proposées (ne les répète pas, même reformulées) :\n', known || '(aucune)', '\n\n',
  `Propose au maximum ${MAX_NEW_INTEGRATIONS_PER_RUN} intégrations, de la plus utile à la moins utile. Règles :\n`,
  '- Ne propose JAMAIS un outil déjà branché ci-dessus (Stripe, QuickBooks, Airtable, Google, HubSpot, Postmark, OpenAI, Novoxpress… selon les listes).\n',
  '- L\'outil doit avoir une API publique documentée et un intérêt réel pour une PME manufacturière IoT de cette taille — pas de suite entreprise hors de prix, pas de gadget.\n',
  '- Dis ce que ça remplace ou automatise pour Orisha, pas ce que l\'outil fait en général.\n',
  '- Chaque intégration doit tenir dans une seule séance de travail pour une première version utile (un flux, une direction), pas un chantier de six mois.\n\n',
  'Réponds UNIQUEMENT par un tableau JSON, sans texte autour, de la forme :\n',
  '[{"title":"Connecter <outil> — <ce que ça débloque>","area":"comptabilité|ventes|logistique|RH|support|technique",',
  '"rationale":"ce que ça remplace/automatise chez Orisha et pourquoi maintenant, 1-3 phrases, en mentionnant le coût et le type d\'authentification (OAuth, clé d\'API) si tu le sais",',
  '"prompt":"le prompt complet à donner à un agent qui implémentera une première version utile : quel flux, dans quel sens, quelles pages/tables de l\'ERP touchées, quel comportement attendu"}]\n',
  'Si tu n\'as rien de solide à proposer, réponds [].',
].join('')

/** Un passage du moteur « intégrations ». Même déduplication par empreinte. */
export async function generateIntegrationSuggestions() {
  const digest = buildIntegrationDigest()
  const { text } = await runToollessClaude({
    prompt: INTEGRATION_PROMPT(digest),
    model: AGENT_MODEL,
    effort: 'high',
    timeoutMs: 6 * 60_000,
  })
  const items = parseSuggestionsJson(text).slice(0, MAX_NEW_INTEGRATIONS_PER_RUN)
  let added = 0
  for (const it of items) {
    if (addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area, kind: 'integration' })) added++
  }
  console.log(`🔌 Suggestions d'intégrations : ${items.length} proposée(s), ${added} nouvelle(s)`)
  return { proposed: items.length, added }
}

/**
 * Passage complet : les deux moteurs, en séquence (un seul appel modèle à la
 * fois — `runToollessClaude` démarre un vrai process). `kind` restreint à un
 * moteur ; sans `kind`, les deux tournent.
 */
export async function runSuggestionEngines({ kind = null } = {}) {
  const out = {}
  if (kind !== 'integration') out.chantiers = await generateSuggestions()
  if (kind !== 'chantier') out.integrations = await generateIntegrationSuggestions()
  return out
}
```

### `services/workIdeas.js` — carnet d'idées

```js
// Carnet d'idées (page /travaux, onglet « Idées »).
//
// Une idée n'est PAS une tâche : « The Future of ERP Systems » n'a rien à faire
// dans la file de prompts, où tout est destiné à partir en exécution. Cet onglet
// est le seul endroit de la page où rien ne s'exécute jamais — on y dépose ce
// qu'on veut garder et relire. Le passage à l'action est explicite (promoteIdea),
// et l'item créé arrive « de côté » dans la file : même promue, une idée ne
// déclenche pas d'exécution sans un geste de plus.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import { createPrompt } from './promptQueue.js'

const SELECT = 'SELECT * FROM work_ideas WHERE deleted_at IS NULL'

function broadcast() { broadcastAll({ type: 'travaux:ideas:updated' }) }

export function listIdeas() {
  return db.prepare(`${SELECT} ORDER BY position, created_at`).all()
}

export function getIdea(id) {
  return db.prepare(`${SELECT} AND id=?`).get(id) || null
}

function nextPosition() {
  return (db.prepare('SELECT MAX(position) AS m FROM work_ideas WHERE deleted_at IS NULL').get()?.m ?? 0) + 1
}

export function createIdea({ title, notes = null, tag = null, created_by = null }) {
  const text = String(title || '').trim()
  if (!text) throw new Error('title requis')
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_ideas (id, title, notes, tag, position, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(id, text, notes || null, tag || null, nextPosition(), created_by)
  broadcast()
  return getIdea(id)
}

const EDITABLE = ['title', 'notes', 'tag']

export function updateIdea(id, patch) {
  const row = getIdea(id)
  if (!row) return null
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(patch || {})) {
    if (!EDITABLE.includes(k)) continue
    // Le titre est la seule chose qui identifie une idée : on refuse de le vider.
    if (k === 'title' && !String(v || '').trim()) continue
    sets.push(`${k}=?`)
    vals.push(k === 'title' ? String(v).trim() : (v === '' ? null : v))
  }
  if (!sets.length) return row
  db.prepare(`UPDATE work_ideas SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...vals, id)
  broadcast()
  return getIdea(id)
}

export function deleteIdea(id) {
  const row = getIdea(id)
  if (!row) return false
  db.prepare(`UPDATE work_ideas SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  broadcast()
  return true
}

/** Réordonne le carnet dans l'ordre exact des ids reçus (les absents suivent). */
export function reorderIdeas(ids) {
  const upd = db.prepare('UPDATE work_ideas SET position=? WHERE id=? AND deleted_at IS NULL')
  db.transaction(() => { ids.forEach((id, i) => upd.run(i + 1, id)) })()
  broadcast()
  return listIdeas()
}

/**
 * Promotion en item de file. Volontairement créé en `paused` : une idée est floue
 * par nature, la promouvoir sert à la sortir du carnet, pas à lancer Claude dessus
 * séance tenante. L'utilisateur ajuste le prompt puis appuie sur ▶.
 * Idempotent : une idée déjà promue renvoie son item existant.
 */
export function promoteIdea(id, { userId = null, prompt = null, space = 'finance' } = {}) {
  const idea = getIdea(id)
  if (!idea) return null
  if (idea.work_prompt_id) {
    const existing = db.prepare('SELECT * FROM work_prompts WHERE id=? AND deleted_at IS NULL').get(idea.work_prompt_id)
    if (existing) return { idea, prompt: existing, already: true }
  }
  const body = String(prompt || '').trim()
    || [idea.title, idea.notes].filter(Boolean).join('\n\n')
  const created = createPrompt({
    title: idea.title,
    prompt: body,
    status: 'paused',
    created_by: userId,
    // L'item de file naît dans la section d'où l'idée est promue (finance/agent).
    space,
  })
  db.prepare(`UPDATE work_ideas SET work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(created.id, id)
  broadcast()
  return { idea: getIdea(id), prompt: created, already: false }
}
```

### `scripts/agent-steer-hook.mjs` — hook Claude Code qui livre les messages en cours de tâche

```mjs
#!/usr/bin/env node
// Hook Claude Code (PostToolUse + Stop) des exécutions détachées de l'agent :
// livre à Claude les messages que l'utilisateur envoie PENDANT la tâche depuis la
// carte /travaux (steering, comme dans l'interface de Claude Code).
//
// Fonctionnement : la route POST /travaux/prompts/:id/message dépose le message
// dans un fichier « inbox » (.agent-exec-<taskId>.inbox, racine du repo, ignoré
// par git). Ce hook, déclenché après CHAQUE outil (PostToolUse) et au moment de
// terminer (Stop), réclame l'inbox de façon atomique (rename) et ressort le
// message en `{"decision":"block","reason":…}` — Claude Code réinjecte la raison
// dans la conversation, donc Claude prend le message en compte et continue.
//
// Silencieux (exit 0 sans sortie) dans tous les autres cas : pas de tâche agent
// (ERP_AGENT_TASK_ID absent — sessions interactives), pas d'inbox, inbox vide,
// ou déjà réclamée par un déclenchement concurrent.
import { readFileSync, renameSync, unlinkSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const taskId = process.env.ERP_AGENT_TASK_ID || ''
// Id = UUID de la tâche : tout autre contenu (vide, chemin…) est ignoré — le hook
// tourne aussi dans les sessions Claude interactives sur ce repo via --settings,
// il ne doit JAMAIS y faire quoi que ce soit.
if (!/^[A-Za-z0-9-]{6,64}$/.test(taskId)) process.exit(0)

// Racine du repo (le script vit dans server/scripts/) — même dossier que les
// autres artefacts d'exécution .agent-exec-<id>.{log,code,prompt}.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const INBOX = resolve(ROOT, `.agent-exec-${taskId}.inbox`)
if (!existsSync(INBOX)) process.exit(0)

// L'événement (Stop vs PostToolUse) adapte la consigne. stdin peut être vide ou
// illisible — on dégrade sans bruit.
let event = ''
try { event = JSON.parse(readFileSync(0, 'utf8'))?.hook_event_name || '' } catch {}

// Réclamation atomique : rename puis lecture. Deux déclenchements concurrents
// (PostToolUse et Stop) ne livreront jamais le même message deux fois — le
// second rename échoue et sort en silence.
const claimed = `${INBOX}.claimed-${process.pid}`
let raw = ''
try {
  renameSync(INBOX, claimed)
  raw = readFileSync(claimed, 'utf8')
  unlinkSync(claimed)
} catch { process.exit(0) }

// Une ligne JSON { text, at } par message (plusieurs si l'utilisateur a écrit
// plusieurs fois entre deux outils). Ligne illisible = texte brut, on livre quand même.
const texts = raw.split('\n').filter(l => l.trim()).map(l => {
  try { return String(JSON.parse(l).text || '').trim() } catch { return l.trim() }
}).filter(Boolean)
if (!texts.length) process.exit(0)

const body = texts.length === 1 ? texts[0] : texts.map(t => `— ${t}`).join('\n')
const reason = [
  '📨 MESSAGE DE L\'UTILISATEUR reçu en plein milieu de la tâche (envoyé depuis la carte /travaux) :\n\n',
  body,
  '\n\nCe n\'est PAS une erreur d\'outil. ',
  event === 'Stop'
    ? 'Prends ce message en compte AVANT de terminer, puis termine normalement (avec les sections finales demandées par ta consigne, ex. RÉSUMÉ UTILISATEUR).'
    : 'Prends ce message en compte dès maintenant et poursuis la tâche en l\'intégrant.',
].join('')

process.stdout.write(JSON.stringify({ decision: 'block', reason }))
```

### `scripts/agent-steer-hooks.json` — settings passés à `claude --settings`

```json
{
  "//": "Settings additionnels passés via --settings aux exécutions détachées de l'agent (taskRunner.runDetachedExecution). Branche le hook de steering : les messages envoyés depuis la carte /travaux pendant la tâche sont livrés à Claude après le prochain outil (PostToolUse) ou juste avant la fin (Stop). Le script sort en silence quand ERP_AGENT_TASK_ID est absent.",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/ec2-user/erp/server/scripts/agent-steer-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /home/ec2-user/erp/server/scripts/agent-steer-hook.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### `server/src/routes/travaux.js` — routes HTTP (section « récurrents » retirée)

```js
// Routes de la page /travaux : file de prompts, suggestions de l'agent, carnet
// d'idées. Validation manuelle, erreurs uniformes { error }.
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  listPrompts, getPrompt, createPrompt, updatePrompt, deletePrompt,
  reorderPrompts, moveToFront, advanceQueue, listMessages, replyToPrompt,
  steerPrompt, getQueuePauseState, pauseQueue, resumeQueue, PROMPT_SPACES,
} from '../services/promptQueue.js'
import {
  listSuggestions, acceptSuggestion, dismissSuggestion, deleteSuggestion,
  addSuggestion, runSuggestionEngines, SUGGESTION_KINDS,
} from '../services/workSuggestions.js'
import {
  listIdeas, createIdea, updateIdea, deleteIdea, reorderIdeas, promoteIdea,
} from '../services/workIdeas.js'
import {
  getSettings, isRunnerBusy, findAgentTask,
  getRunningQuestionCount, getMaxParallelQuestions,
} from '../services/taskRunner.js'

const router = Router()
router.use(requireAuth)

// ─── File de prompts ──────────────────────────────────────────────────────────

/**
 * « running » côté file ne veut PAS dire « Claude travaille dessus » : l'item a été
 * remis à l'ordonnanceur, qui ne démarre qu'une implémentation à la fois (et au plus
 * getMaxParallelQuestions() questions). Deux réponses envoyées coup sur coup dans
 * deux fils différents donnaient donc deux cartes « en cours » alors qu'une seule
 * avançait. On distingue l'état réel de la tâche agent :
 *   'executing' → le process Claude tourne pour cet item
 *   'waiting'   → dans la file de l'ordonnanceur, en attente d'un poste libre
 */
function runState(p, task) {
  if (p.status !== 'running') return null
  // Tâche introuvable = exécution perdue : advanceQueue la réconciliera au prochain
  // passage. En attendant, ne pas prétendre que ça tourne.
  if (!task) return 'waiting'
  return task.status === 'in_progress' ? 'executing' : 'waiting'
}

/** Voie d'exécution d'un item : les questions ont leur propre file (parallèle). */
function laneOf(p) {
  return (p.mode === 'question' && !p.same_context) ? 'question' : 'exec'
}

/**
 * Question en attente : stockée en JSON sur la colonne, rendue au front en objet
 * { question, options[] }. Un JSON illisible (écriture d'une version antérieure)
 * dégrade en question sans choix plutôt que de casser la page.
 */
function parseQuestion(raw) {
  if (!raw) return null
  try {
    const q = JSON.parse(raw)
    if (!q?.question) return null
    return { question: String(q.question), options: Array.isArray(q.options) ? q.options.map(String) : [] }
  } catch {
    return { question: String(raw), options: [] }
  }
}

// Le compte-rendu vit sur la tâche agent : on le rapatrie sur l'item pour que la
// page n'ait pas à croiser deux sources (et reste lisible après un /clear).
function withResult(p) {
  const task = p.agent_task_id ? findAgentTask(p.agent_task_id) : null
  return {
    ...p,
    pending_question: parseQuestion(p.pending_question),
    user_summary: task?.user_summary || null,
    agent_status: task?.status || null,
    run_state: runState(p, task),
    lane: laneOf(p),
    // Le fil est joint à la liste : quelques messages courts par tâche, ça évite un
    // aller-retour par carte pour l'afficher.
    messages: listMessages(p.id),
  }
}

/**
 * Rang d'attente affiché sur les cartes (« 2e à partir »), calculé par voie : un item
 * ne se compare qu'à ceux qui lui disputent le même poste. Les items déjà remis à
 * l'ordonnanceur passent avant ceux encore en file côté page.
 */
function withWaitRank(rows) {
  const counters = { exec: 0, question: 0 }
  const waiting = rows
    .filter(p => p.run_state === 'waiting' || p.status === 'queued')
    .sort((a, b) => {
      const ai = a.run_state === 'waiting' ? 0 : 1
      const bi = b.run_state === 'waiting' ? 0 : 1
      if (ai !== bi) return ai - bi
      // Déjà remis à l'ordonnanceur : l'ordre est celui de la remise (started_at est
      // horodaté au moment où l'item lui est passé), pas la position dans la page.
      if (!ai) return String(a.started_at || '').localeCompare(String(b.started_at || ''))
      return (a.position - b.position) || a.created_at.localeCompare(b.created_at)
    })
  const ranks = new Map()
  for (const p of waiting) ranks.set(p.id, ++counters[p.lane])
  return rows.map(p => ({ ...p, wait_rank: ranks.get(p.id) || null }))
}

router.get('/prompts', (req, res) => {
  const space = req.query.space || null
  if (space && !PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  // Les rangs d'attente se calculent sur TOUTES les files (l'exécuteur est partagé :
  // « 2e à partir » doit compter les items de l'autre file aussi), puis on ne rend
  // que la file demandée. Sans `space`, tout (rétro-compatible).
  const prompts = withWaitRank(listPrompts().map(withResult))
    .filter(p => !space || p.space === space)
  const pause = getQueuePauseState()
  res.json({
    prompts,
    agent_enabled: !!getSettings().enabled,
    // Pause manuelle de la file : rien ne démarre tant qu'elle tient.
    queue_paused: pause.paused,
    queue_paused_at: pause.paused_at,
    queue_paused_reason: pause.reason,
    runner_busy: isRunnerBusy(),
    // Voie lecture seule : les questions tournent en parallèle d'un chantier.
    running_questions: getRunningQuestionCount(),
    max_parallel_questions: getMaxParallelQuestions(),
  })
})

router.post('/prompts', (req, res) => {
  const { title, prompt, mode, preset, same_context, status, priority, space } = req.body || {}
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt requis' })
  if (mode && !['implement', 'question'].includes(mode)) return res.status(400).json({ error: 'mode invalide' })
  if (status && !['queued', 'paused'].includes(status)) return res.status(400).json({ error: 'status invalide' })
  if (space && !PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  const created = createPrompt({
    title, prompt, mode, preset, same_context, status, space,
    // Coché à la création : l'item passe devant la file (même effet que le bouton
    // « Passer en premier », sans avoir à le cliquer après coup).
    priority: !!priority,
    created_by: req.user?.id || null,
  })
  // Rien ne tourne → l'item part tout de suite ; sinon il attend son tour.
  advanceQueue()
  res.status(201).json(withResult(getPrompt(created.id)))
})

router.patch('/prompts/:id', (req, res) => {
  const updated = updatePrompt(req.params.id, req.body || {})
  if (!updated) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(withResult(updated))
})

router.delete('/prompts/:id', (req, res) => {
  if (!deletePrompt(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ ok: true })
})

router.post('/prompts/reorder', (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' })
  // reorderPrompts se charge lui-même de rendre à l'ordonnanceur les items qu'il lui
  // a repris ; un simple changement de priorité ne déclenche donc rien.
  res.json({ prompts: withWaitRank(reorderPrompts(ids).map(withResult)) })
})

router.post('/prompts/:id/first', (req, res) => {
  const p = moveToFront(req.params.id)
  if (!p) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(withResult(p))
})

// Fil de discussion d'une tâche.
router.get('/prompts/:id/messages', (req, res) => {
  if (!getPrompt(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ messages: listMessages(req.params.id) })
})

// Réponse de l'humain → relance immédiate de la tâche avec ce complément.
router.post('/prompts/:id/reply', (req, res) => {
  const { text } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' })
  const out = replyToPrompt(req.params.id, { text, userId: req.user?.id || null })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.error === 'running') {
    return res.status(409).json({ error: 'la tâche est en cours d\'exécution — réponds quand elle a rendu la main' })
  }
  if (out.error) return res.status(400).json({ error: 'réponse vide' })
  res.status(201).json(withResult(out.prompt))
})

// Message envoyé PENDANT l'exécution (steering, comme dans Claude Code) : livré à
// Claude en cours de tâche sans l'interrompre. `delivered` dit par quelle voie :
// 'live' (l'exécution tourne, le hook le glisse au prochain outil) ou 'queued'
// (la tâche attend son tour, le message est intégré au brief avant le départ).
router.post('/prompts/:id/message', (req, res) => {
  const { text } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' })
  const out = steerPrompt(req.params.id, { text, userId: req.user?.id || null })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.error === 'not-running') {
    return res.status(409).json({ error: 'la tâche a rendu la main — utilise « Répondre et relancer »' })
  }
  if (out.error) return res.status(400).json({ error: 'message vide' })
  res.status(201).json({ ...withResult(out.prompt), delivered: out.delivered })
})

// Relance manuelle de l'ordonnanceur (bouton « Lancer la file »). `reason` dit
// pourquoi rien n'a démarré : file vide, agent désactivé, ou exécution en cours.
router.post('/prompts/advance', (req, res) => {
  const { started, startedCount, reason } = advanceQueue()
  res.json({ started: started ? withResult(started.prompt) : null, startedCount, reason })
})

// ─── Pause de la file ─────────────────────────────────────────────────────────
// Bouton assumé (pas d'autosave) : mettre la file en pause / la reprendre est une
// action à effet réel — elle décide si des exécutions Claude démarrent ou non.
// La pause n'interrompt JAMAIS l'exécution en cours : elle bloque seulement les
// départs, donc reprendre repart exactement où la file s'était arrêtée.

router.get('/queue/pause', (req, res) => {
  res.json(getQueuePauseState())
})

router.post('/queue/pause', (req, res) => {
  const { paused, reason } = req.body || {}
  if (typeof paused !== 'boolean') return res.status(400).json({ error: 'paused (booléen) requis' })
  res.json(paused ? pauseQueue({ reason: reason || null }) : resumeQueue())
})

// ─── Suggestions de l'agent ───────────────────────────────────────────────────

router.get('/suggestions', (req, res) => {
  const status = req.query.status || null
  const kind = req.query.kind || null
  if (status && !['new', 'accepted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status invalide' })
  }
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  res.json({ suggestions: listSuggestions({ status, kind }) })
})

router.post('/suggestions', (req, res) => {
  const { title, prompt, rationale, area, kind } = req.body || {}
  if (!title || !prompt) return res.status(400).json({ error: 'title et prompt requis' })
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  const created = addSuggestion({ title, prompt, rationale, area, kind })
  if (!created) return res.status(409).json({ error: 'suggestion déjà présente' })
  res.status(201).json(created)
})

router.post('/suggestions/:id/accept', (req, res) => {
  const space = req.body?.space || 'finance'
  if (!PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  const out = acceptSuggestion(req.params.id, {
    userId: req.user?.id || null,
    overridePrompt: req.body?.prompt || null,
    // La suggestion rejoint la file de la section d'où elle est acceptée.
    space,
  })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(out)
})

router.post('/suggestions/:id/dismiss', (req, res) => {
  const s = dismissSuggestion(req.params.id, req.body?.reason || null)
  if (!s) return res.status(404).json({ error: 'introuvable' })
  res.json(s)
})

router.delete('/suggestions/:id', (req, res) => {
  deleteSuggestion(req.params.id)
  res.json({ ok: true })
})

// Passage manuel du moteur. Long (appel modèle) → on répond tout de suite et la
// page se met à jour par la diffusion temps réel quand les suggestions arrivent.
// `kind` restreint à un moteur (chantiers ou intégrations) ; sans lui, les deux.
router.post('/suggestions/generate', (req, res) => {
  const kind = req.body?.kind || null
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  runSuggestionEngines({ kind }).catch(e => console.error('🤖 Suggestions de travaux:', e.message))
  res.status(202).json({ ok: true })
})

// ─── Carnet d'idées ───────────────────────────────────────────────────────────
// Aucune route de cette section ne déclenche d'exécution : la seule qui touche à
// l'agent (promote) dépose l'item « de côté ».

router.get('/ideas', (req, res) => {
  res.json({ ideas: listIdeas() })
})

router.post('/ideas', (req, res) => {
  const { title, notes, tag } = req.body || {}
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title requis' })
  res.status(201).json(createIdea({ title, notes, tag, created_by: req.user?.id || null }))
})

router.patch('/ideas/:id', (req, res) => {
  const updated = updateIdea(req.params.id, req.body || {})
  if (!updated) return res.status(404).json({ error: 'introuvable' })
  res.json(updated)
})

router.delete('/ideas/:id', (req, res) => {
  if (!deleteIdea(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ ok: true })
})

router.post('/ideas/reorder', (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' })
  res.json({ ideas: reorderIdeas(ids) })
})

// Passage à l'action : crée un item de file « de côté » (jamais lancé d'office).
router.post('/ideas/:id/promote', (req, res) => {
  const space = req.body?.space || 'finance'
  if (!PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  const out = promoteIdea(req.params.id, { userId: req.user?.id || null, prompt: req.body?.prompt || null, space })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  res.status(out.already ? 200 : 201).json(out)
})


export default router
```

---

## 8. Frontend


### `client/src/pages/Travaux.jsx` — la page (onglet « récurrents » retiré)

```jsx
// Travaux — trois listes, réunies sur une page.
//
// 1. « Ma file » remplace le Google Doc de prompts : on empile ses demandes, le
//    serveur en exécute UNE à la fois via l'agent (contexte neuf par item, sauf
//    ceux marqués « poursuit le contexte »), et un recap part dans le DM Slack à
//    chaque fin — plus besoin de surveiller le terminal.
// 2. « Suggestions » est la liste que l'agent alimente lui-même — des chantiers,
//    et des intégrations (outils/API externes à brancher) ; rien ne part en
//    exécution avant d'avoir été promu dans la file.
// 3. « Idées » est un carnet, pas une file : rien ne s'exécute de là. On y garde
//    ce qui mérite d'être relu plutôt que fait tout de suite ; un bouton crée un
//    item de file (mis de côté) le jour où l'idée devient un chantier.
//
// Autosave partout (blur / debounce 500 ms) ; les seuls boutons sont les créations
// et les actions à effet réel (lancer la file, promouvoir, générer).
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Play, Pause, Trash2, ChevronUp, ChevronsUp, Plus, Sparkles, Check, X, Loader2,
  ListOrdered, Link2, CheckCircle2, AlertTriangle, ChevronDown, Send,
  Hourglass, GripVertical, Plug, HelpCircle, CircleStop, PauseCircle, PlayCircle,
  Lightbulb, MessageSquare, Pencil,
} from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { ClaudeUsageStrip } from '../components/ClaudeUsage.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

const inputCls = 'px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
const btnCls = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50'
const btnPrimary = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50'

const PRESETS = [
  { value: 'fast', label: 'Rapide' },
  { value: 'standard', label: 'Standard' },
  { value: 'deep', label: 'Approfondi' },
]

const STATUS_STYLES = {
  asking: 'bg-violet-50 text-violet-700',
  running: 'bg-brand-50 text-brand-700',
  waiting: 'bg-amber-50 text-amber-700',
  queued: 'bg-slate-100 text-slate-600',
  paused: 'bg-amber-50 text-amber-700',
  done: 'bg-emerald-50 text-emerald-700',
  blocked: 'bg-rose-50 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-500',
}
const STATUS_LABELS = {
  asking: 'À répondre',
  running: 'En cours', waiting: 'En attente', queued: 'En file', paused: 'De côté',
  done: 'Terminé', blocked: 'Bloqué', cancelled: 'Annulé',
}

/** L'agent attend une réponse : rien n'avancera sans un clic de l'utilisateur. */
function isAsking(p) {
  return !!p.pending_question?.question && ['done', 'blocked'].includes(p.status)
}

/**
 * Un item remis à l'agent n'est pas forcément en train de tourner : une seule
 * implémentation avance à la fois. `run_state` (serveur) tranche entre les deux —
 * sans lui, deux réponses envoyées coup sur coup affichaient deux « En cours ».
 */
function pillStateOf(p) {
  if (p.status === 'running') return p.run_state === 'executing' ? 'running' : 'waiting'
  // « Terminé » serait faux : la tâche a rendu la main faute d'une décision qui
  // n'appartenait qu'à l'utilisateur, et reprendra dès qu'il aura répondu.
  if (isAsking(p)) return 'asking'
  return p.status
}

function ordinal(n) { return n === 1 ? '1er' : `${n}e` }

function StatusPill({ p }) {
  const state = pillStateOf(p)
  const rank = p.wait_rank
  const suffix = (state === 'waiting' || state === 'queued') && rank ? ` · ${ordinal(rank)}` : ''
  const title = state === 'waiting'
    ? "Remis à l'agent, mais son tour n'est pas venu : une seule implémentation tourne à la fois."
    : state === 'running' ? "Claude travaille sur cette tâche en ce moment."
      : state === 'asking' ? "Claude attend ta réponse : le travail reprend dès que tu choisis."
        : state === 'queued' ? "Dans la file : partira quand le poste sera libre." : undefined
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_STYLES[state] || 'bg-slate-100 text-slate-600'}`} title={title}>
      {state === 'running' && <Loader2 size={11} className="inline animate-spin mr-1" />}
      {state === 'waiting' && <Hourglass size={11} className="inline mr-1" />}
      {state === 'asking' && <HelpCircle size={11} className="inline mr-1" />}
      {STATUS_LABELS[state] || state}{suffix}
    </span>
  )
}

/** Durée écoulée lisible, rafraîchie chaque seconde tant que l'item tourne. */
function useElapsed(startedAt, live) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  if (!startedAt) return null
  const secs = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000))
  const m = Math.floor(secs / 60)
  return m ? `${m} min ${String(secs % 60).padStart(2, '0')} s` : `${secs} s`
}

/** Champ texte en autosave : debounce 500 ms + sauvegarde immédiate au blur. */
function useAutosave(save) {
  const timer = useRef(null)
  const pending = useRef(null)
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (pending.current) { const p = pending.current; pending.current = null; save(p) }
  }, [save])
  const queue = useCallback((patch) => {
    pending.current = { ...(pending.current || {}), ...patch }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 500)
  }, [flush])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { queue, flush }
}

/**
 * Champs texte d'une carte de la file, en autosave, SANS interruption de frappe.
 *
 * Le piège corrigé ici : la liste se recharge en permanence (temps réel, sondage,
 * et après chaque sauvegarde). L'ancienne version réinjectait alors la valeur du
 * serveur dans le champ — les caractères tapés pendant l'aller-retour
 * disparaissaient et le curseur sautait à la fin. Désormais la valeur du serveur
 * n'est reprise que pour les champs dont on n'attend plus rien : tant qu'une
 * frappe n'est pas revenue confirmée, c'est l'écran qui fait foi.
 *
 * `save` doit renvoyer la ligne serveur (ou null) : elle sert à accepter une
 * normalisation côté serveur (titre vidé → titre automatique) sans écraser une
 * frappe arrivée entre-temps.
 */
function usePromptDraft(p, save) {
  const [draft, setDraft] = useState({ title: p.title || '', prompt: p.prompt || '' })
  const awaiting = useRef({})   // champ → dernière valeur envoyée, pas encore confirmée
  const timer = useRef(null)

  useEffect(() => {
    const server = { title: p.title || '', prompt: p.prompt || '' }
    setDraft(prev => {
      let next = prev
      for (const k of ['title', 'prompt']) {
        if (awaiting.current[k] === undefined) {
          if (prev[k] !== server[k]) next = { ...next, [k]: server[k] }
        } else if (awaiting.current[k] === server[k]) {
          delete awaiting.current[k]      // notre frappe est revenue : le champ est à jour
        }
      }
      return next
    })
  }, [p.title, p.prompt])

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const patch = { ...awaiting.current }
    if (!Object.keys(patch).length) return
    const row = await save(patch)
    for (const [k, sent] of Object.entries(patch)) {
      // Tapé depuis l'envoi ? On laisse la frappe en cours gagner.
      if (awaiting.current[k] !== sent) continue
      delete awaiting.current[k]
      const got = row?.[k] ?? null
      if (got !== null && got !== sent) setDraft(d => ({ ...d, [k]: got }))
    }
  }, [save])

  const edit = useCallback((k, v) => {
    setDraft(d => ({ ...d, [k]: v }))
    awaiting.current[k] = v
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { flush() }, 600)
  }, [flush])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { draft, edit, flush }
}

// ─── Onglet 1 : ma file de prompts ────────────────────────────────────────────
//
// Deux vues plutôt qu'une seule liste à dérouler : « File » (ce qui tourne ou va
// tourner) et « Conversations » (ce qui a rendu la main et attend éventuellement
// une réponse). Chaque item tient sur une ligne repliée — le fil, le prompt et les
// réglages ne s'ouvrent qu'à la demande. Avant, il fallait dérouler des
// conversations entières pour atteindre le bas de la file, et bien plus loin
// encore pour répondre à Claude.

/** Première ligne utile d'un texte, pour les aperçus repliés. */
function firstLine(text, max = 170) {
  const t = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Date courte et lisible d'un item terminé (« 4 août, 14:07 »). */
function shortDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * Zone de réponse d'un fil. Bouton assumé (pas d'autosave) : envoyer RELANCE
 * l'exécution de la tâche — action à effet réel, elle ne doit pas partir d'un blur.
 */
function ReplyBox({ onSend, autoFocus }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      await onSend(text.trim())
      setText('')
    } finally { setSending(false) }
  }
  return (
    <div>
      <textarea
        ref={ref}
        className={`${inputCls} w-full`}
        rows={2}
        placeholder="Répondre à Claude — ta réponse relance la tâche…"
        value={text}
        onChange={e => setText(e.target.value)}
        // Cmd/Ctrl+Entrée envoie : Entrée seule sert aux retours à la ligne.
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
      />
      <div className="flex items-center gap-2 mt-1.5">
        <button className={btnPrimary} onClick={send} disabled={sending || !text.trim()}>
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Répondre et relancer
        </button>
        <span className="text-xs text-slate-400">⌘/Ctrl + Entrée</span>
      </div>
    </div>
  )
}

/**
 * Message à Claude PENDANT que la tâche tourne (steering, comme dans Claude Code) :
 * livré en cours d'exécution sans rien interrompre ni relancer. Bouton assumé (pas
 * d'autosave) : envoyer parle à un agent en plein travail — ça ne part pas d'un blur.
 */
function SteerBox({ onSend, executing, autoFocus }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      await onSend(text.trim())
      setText('')
    } finally { setSending(false) }
  }
  return (
    <div>
      <textarea
        ref={ref}
        data-testid="travaux-steer-input"
        className={`${inputCls} w-full`}
        rows={2}
        placeholder="Dire quelque chose à Claude pendant qu'il travaille…"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
      />
      <div className="flex items-center gap-2 mt-1.5">
        <button className={btnPrimary} data-testid="travaux-steer-send" onClick={send} disabled={sending || !text.trim()}>
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Envoyer en cours de tâche
        </button>
        <span className="text-xs text-slate-400">
          {executing
            ? 'Claude le prendra en compte sans interrompre le travail.'
            : 'Pas encore démarrée — le message sera intégré au brief au départ.'}
        </span>
      </div>
    </div>
  )
}

/**
 * Poignée de priorité d'un item pas encore parti : glisser la carte, ou monter /
 * descendre d'un cran au clic. Le clavier passe par les deux boutons — un drag
 * seul laisserait la file inaccessible sans souris.
 */
function ReorderRail({ p, dnd }) {
  const arrow = 'p-0.5 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <div className="flex flex-col items-center shrink-0 w-4">
      <button
        className={arrow} data-testid="travaux-move-up" title="Monter d'un cran" aria-label="Monter d'un cran"
        disabled={dnd.isFirst(p.id)} onClick={() => dnd.move(p.id, -1)}
      ><ChevronUp size={13} /></button>
      <span
        draggable
        onDragStart={e => dnd.dragStart(e, p.id)}
        onDragEnd={dnd.dragEnd}
        className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500"
        title="Glisser pour changer la priorité"
        data-testid="travaux-drag-handle"
      ><GripVertical size={13} /></span>
      <button
        className={arrow} data-testid="travaux-move-down" title="Descendre d'un cran" aria-label="Descendre d'un cran"
        disabled={dnd.isLast(p.id)} onClick={() => dnd.move(p.id, 1)}
      ><ChevronDown size={13} /></button>
    </div>
  )
}

/** Un message du fil. */
function ThreadMessage({ m }) {
  return (
    <div className={`text-sm whitespace-pre-wrap rounded-lg px-3 py-2 ${
      m.role === 'agent' ? 'bg-slate-50 text-slate-700' : 'bg-brand-50 text-brand-900'
    }`}>
      <div className="text-[11px] uppercase tracking-wide opacity-60 mb-0.5">
        {m.role === 'agent' ? 'Claude' : (m.author_name || 'Toi')}
      </div>
      {m.text}
    </div>
  )
}

// Fil replié par défaut au-delà de ce nombre de messages : une conversation de
// vingt échanges ne doit pas repousser le reste de la file hors de l'écran.
const THREAD_TAIL = 3

function PromptRow({ p, onPatch, onDelete, onFirst, onReply, onSteer, dnd }) {
  const state = pillStateOf(p)
  const asking = state === 'asking'
  const executing = state === 'running'
  const waiting = state === 'waiting'
  const finished = ['done', 'blocked', 'cancelled'].includes(p.status)
  // Un item « en attente » a été remis à l'ordonnanceur mais n'a RIEN commencé :
  // il reste donc modifiable et déplaçable, le serveur le reprend au premier
  // changement. Seule une exécution réellement en cours est figée.
  const editable = ['queued', 'paused'].includes(p.status) || waiting

  const [open, setOpen] = useState(asking)
  const [focusReply, setFocusReply] = useState(0)
  const [showWholeThread, setShowWholeThread] = useState(false)
  const [answering, setAnswering] = useState(false)
  const cardRef = useRef(null)
  const promptRef = useRef(null)
  // Le chrono ne vaut que pendant l'exécution : `started_at` survit à la tâche, et
  // l'afficher sur un item terminé ou remis en file donnait des « 1044 min » absurdes.
  const running = p.status === 'running'
  const elapsed = useElapsed(running ? p.started_at : null, running)

  const save = useCallback(patch => onPatch(p.id, patch), [onPatch, p.id])
  const { draft, edit, flush } = usePromptDraft(p, save)

  // Une question ouverte force l'ouverture : c'est le seul état où rien n'avance
  // sans un geste de l'utilisateur.
  useEffect(() => { if (asking) setOpen(true) }, [asking])

  const movable = !!dnd && editable && dnd.canMove(p.id)
  const dropSide = (movable && dnd.dragOverId === p.id && dnd.dragId && dnd.dragId !== p.id) ? dnd.dragOverSide : null

  const messages = p.messages || []
  const lastAgent = [...messages].reverse().find(m => m.role === 'agent')
  const preview = firstLine((finished || asking) ? (lastAgent?.text || p.user_summary || p.prompt) : p.prompt)
  const hidden = showWholeThread ? 0 : Math.max(0, messages.length - THREAD_TAIL)
  const shownMessages = hidden ? messages.slice(-THREAD_TAIL) : messages

  const openPrompt = () => {
    setOpen(true)
    setTimeout(() => { promptRef.current?.focus() }, 30)
  }

  const iconBtn = 'p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-40'

  return (
    <div
      ref={cardRef}
      data-prompt-id={p.id}
      data-prompt-status={p.status}
      data-prompt-open={open ? '1' : '0'}
      onDragOver={movable ? e => dnd.dragOver(e, p.id) : undefined}
      onDrop={movable ? e => dnd.drop(e, p.id) : undefined}
      className={`relative rounded-xl border bg-white transition ${
        executing ? 'border-brand-300 ring-1 ring-brand-100'
          : asking ? 'border-violet-300 ring-1 ring-violet-100' : 'border-slate-200 hover:border-slate-300'
      } ${dnd?.dragId === p.id ? 'opacity-50' : ''}`}
    >
      {dropSide && (
        <span className={`absolute left-2 right-2 h-0.5 bg-brand-500 rounded pointer-events-none ${dropSide === 'before' ? '-top-1' : '-bottom-1'}`} />
      )}

      {/* Ligne repliée : tout ce qu'il faut pour trier la file d'un coup d'œil. */}
      <div className="flex items-start gap-2 px-2.5 py-2">
        {movable
          ? <ReorderRail p={p} dnd={{ ...dnd, dragStart: (e, id) => dnd.dragStart(e, id, cardRef.current) }} />
          : <span className="w-4 shrink-0" />}

        <button
          className="mt-0.5 p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
          data-testid="travaux-toggle"
          aria-expanded={open}
          title={open ? 'Replier' : editable ? 'Ouvrir — prompt et réglages' : 'Ouvrir la conversation'}
          onClick={() => setOpen(o => !o)}
        ><ChevronDown size={14} className={open ? 'rotate-180 transition' : 'transition'} /></button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <StatusPill p={p} />
            {editable ? (
              <input
                className="flex-1 min-w-0 bg-transparent text-sm font-medium text-slate-800 border-0 p-0 focus:outline-none placeholder:text-slate-300"
                value={draft.title}
                onChange={e => edit('title', e.target.value)}
                onBlur={flush}
                placeholder="Titre — vide = automatique"
                title={p.title_auto ? 'Titre automatique : écris le tien pour le figer' : 'Titre figé — vide le champ pour revenir au titre automatique'}
              />
            ) : (
              <span className="flex-1 min-w-0 truncate text-sm font-medium text-slate-800">{p.title}</span>
            )}

            {/* Repères discrets : la ligne doit rester lisible d'un coup d'œil. */}
            {!!p.same_context && (
              <Link2 size={12} className="shrink-0 text-violet-500" aria-label="Même contexte">
                <title>Reprend la session Claude de l'item précédent</title>
              </Link2>
            )}
            {p.mode === 'question' && (
              <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-sky-50 text-sky-700" title="Lecture seule — tourne en parallèle">Q</span>
            )}
            {!!messages.length && (
              <span className="shrink-0 inline-flex items-center gap-0.5 text-xs text-slate-400" title={`${messages.length} message${messages.length > 1 ? 's' : ''} dans le fil`}>
                <MessageSquare size={11} /> {messages.length}
              </span>
            )}
            {elapsed && <span className="shrink-0 text-xs text-slate-400">{elapsed}</span>}
            {finished && shortDate(p.completed_at) && (
              <span className="shrink-0 text-xs text-slate-400">{shortDate(p.completed_at)}</span>
            )}
          </div>

          {!open && !!preview && (
            <button
              className="mt-0.5 block w-full text-left text-xs text-slate-400 truncate hover:text-slate-600"
              onClick={() => setOpen(true)}
              title="Ouvrir"
            >{preview}</button>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {/* Frein posé sur un item précis : quand CELUI-CI se termine, la file se
              met en pause au lieu d'enchaîner. La façon la plus simple de borner la
              consommation de jetons sans surveiller la page. */}
          {['queued', 'running'].includes(p.status) && (
            <button
              data-testid="travaux-stop-after"
              data-active={p.stop_after ? '1' : '0'}
              className={`inline-flex items-center gap-1 px-1.5 py-1 text-[11px] rounded-lg border transition ${
                p.stop_after
                  ? 'border-amber-300 bg-amber-50 text-amber-700'
                  : 'border-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              }`}
              title={p.stop_after
                ? 'La file se mettra en pause une fois cette tâche terminée. Clique pour annuler.'
                : 'Mettre la file en pause une fois cette tâche terminée — les suivantes attendront ton feu vert.'}
              onClick={() => onPatch(p.id, { stop_after: p.stop_after ? 0 : 1 })}
            >
              <CircleStop size={13} />{p.stop_after ? ' Pause après' : ''}
            </button>
          )}
          {editable && (
            <button className={iconBtn} data-testid="travaux-edit-prompt" onClick={openPrompt} title="Modifier le prompt">
              <Pencil size={14} />
            </button>
          )}
          {['done', 'blocked'].includes(p.status) && (
            <button
              className={iconBtn} data-testid="travaux-reply"
              onClick={() => { setOpen(true); setFocusReply(n => n + 1) }}
              title="Répondre à Claude"
            ><Send size={14} /></button>
          )}
          {(executing || waiting) && (
            <button
              className={iconBtn} data-testid="travaux-steer"
              onClick={() => { setOpen(true); setFocusReply(n => n + 1) }}
              title="Écrire à Claude en cours de tâche — pris en compte sans interrompre le travail"
            ><Send size={14} /></button>
          )}
          {editable && p.status !== 'paused' && (
            <button className={iconBtn} data-testid="travaux-move-first" onClick={() => onFirst(p.id)} title="Passer en premier"><ChevronsUp size={14} /></button>
          )}
          {editable && p.status !== 'paused' && (
            <button className={iconBtn} onClick={() => onPatch(p.id, { status: 'paused' })} title="Mettre de côté"><Pause size={14} /></button>
          )}
          {p.status === 'paused' && (
            <button className={iconBtn} onClick={() => onPatch(p.id, { status: 'queued' })} title="Remettre en file"><Play size={14} /></button>
          )}
          {!executing && (
            <button className={`${iconBtn} hover:text-rose-600`} onClick={() => onDelete(p.id)} title="Retirer"><Trash2 size={14} /></button>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-100 px-3 py-3 space-y-3">
          {/* Fil de discussion : chaque compte-rendu y est versé, et une réponse
              relance l'exécution avec le fil en contexte. `user_summary` seul ne
              s'affiche que pour les items d'avant le fil. */}
          {messages.length ? (
            <div className="space-y-2">
              {hidden > 0 && (
                <button
                  className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
                  data-testid="travaux-show-thread"
                  onClick={() => setShowWholeThread(true)}
                ><ChevronUp size={12} /> Afficher les {hidden} message{hidden > 1 ? 's' : ''} précédent{hidden > 1 ? 's' : ''}</button>
              )}
              {shownMessages.map(m => <ThreadMessage key={m.id} m={m} />)}
            </div>
          ) : p.user_summary ? (
            <div className="text-sm text-slate-600 whitespace-pre-wrap bg-slate-50 rounded-lg px-3 py-2">{p.user_summary}</div>
          ) : null}

          {/* Question de Claude : le texte est déjà dans le fil (dernier message), on
              n'affiche donc ici que les choix — un clic répond et relance la tâche. */}
          {asking && (
            <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2.5" data-testid="travaux-question">
              <div className="text-xs font-medium text-violet-800 inline-flex items-center gap-1.5">
                <HelpCircle size={13} /> Claude attend ta réponse pour continuer
              </div>
              {!!p.pending_question.options.length && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {p.pending_question.options.map((opt, i) => (
                    <button
                      key={i}
                      className="px-2.5 py-1 text-sm rounded-lg bg-white border border-violet-300 text-violet-900 hover:bg-violet-100 disabled:opacity-50 text-left"
                      data-testid="travaux-question-option"
                      disabled={answering}
                      onClick={async () => { setAnswering(true); try { await onReply(p.id, opt) } finally { setAnswering(false) } }}
                    >{opt}</button>
                  ))}
                </div>
              )}
              <p className="text-xs text-violet-700/70 mt-2">
                Un choix relance le travail avec ta réponse. Tu peux aussi répondre librement ci-dessous.
              </p>
            </div>
          )}

          {['done', 'blocked'].includes(p.status) && <ReplyBox onSend={text => onReply(p.id, text)} autoFocus={focusReply} />}

          {/* Steering : on peut parler à Claude PENDANT qu'il travaille (ou pendant
              que la tâche attend son tour) — le message est pris en compte en cours
              de tâche, rien n'est interrompu. */}
          {(executing || waiting) && (
            <SteerBox onSend={text => onSteer(p.id, text)} executing={executing} autoFocus={focusReply} />
          )}
          {waiting && (
            <p className="text-xs text-amber-600 inline-flex items-center gap-1">
              <Hourglass size={11} />
              {p.wait_rank > 1
                ? `Pas encore démarrée — ${p.wait_rank - 1} tâche${p.wait_rank > 2 ? 's' : ''} à finir avant celle-ci. Le prompt et l'ordre restent modifiables.`
                : 'Pas encore démarrée — elle part dès que le poste se libère. Le prompt et l\'ordre restent modifiables.'}
            </p>
          )}

          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">
              {editable ? 'Prompt envoyé — modifiable tant que ça n\'a pas démarré' : 'Prompt envoyé'}
            </div>
            {editable ? (
              <textarea
                ref={promptRef}
                data-testid="travaux-prompt-input"
                className={`${inputCls} w-full font-mono text-xs`}
                rows={8}
                value={draft.prompt}
                onChange={e => edit('prompt', e.target.value)}
                onBlur={flush}
              />
            ) : (
              <pre className="text-xs text-slate-600 whitespace-pre-wrap font-mono bg-slate-50 rounded-lg p-3">{p.prompt}</pre>
            )}
          </div>

          {editable && (
            <div className="flex items-center gap-3 flex-wrap">
              <select className={inputCls} value={p.preset} onChange={e => onPatch(p.id, { preset: e.target.value })}>
                {PRESETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select className={inputCls} value={p.mode} onChange={e => onPatch(p.id, { mode: e.target.value })}>
                <option value="implement">Implémenter</option>
                <option value="question">Question (lecture seule, en parallèle)</option>
              </select>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                <input type="checkbox" checked={!!p.same_context} onChange={e => onPatch(p.id, { same_context: e.target.checked })} />
                Poursuit le contexte du précédent
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Composeur replié : un champ d'une ligne, qui s'ouvre au clic. */
function NewPromptComposer({ agentEnabled, onCreate }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ prompt: '', title: '', mode: 'implement', preset: 'deep', same_context: false, priority: false })
  const [saving, setSaving] = useState(false)
  const ref = useRef(null)

  const start = () => { setOpen(true); setTimeout(() => ref.current?.focus(), 30) }
  // Création : pas d'autosave possible (aucun id avant l'envoi) — voir CLAUDE.md.
  const add = async () => {
    if (!form.prompt.trim()) return
    setSaving(true)
    try {
      await onCreate(form)
      setForm({ prompt: '', title: '', mode: 'implement', preset: 'deep', same_context: false, priority: false })
      setOpen(false)
    } finally { setSaving(false) }
  }

  if (!open) {
    return (
      <button
        className="w-full flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-500 hover:border-brand-400 hover:text-brand-700 mb-3"
        onClick={start}
        data-testid="travaux-new-prompt"
      >
        <Plus size={15} /> Nouveau prompt…
        {!agentEnabled && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle size={12} /> Agent désactivé
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 mb-3">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-sm font-semibold text-slate-800">Nouveau prompt</div>
        <div className="text-xs text-slate-500">
          {agentEnabled
            ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} /> Agent actif</span>
            : <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={12} /> Agent désactivé — rien ne s'exécutera</span>}
        </div>
      </div>
      <textarea
        ref={ref}
        className={`${inputCls} w-full`}
        rows={4}
        placeholder="Décris la tâche comme tu me l'écrirais dans le terminal…"
        value={form.prompt}
        onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
      />
      <div className="flex items-center gap-3 mt-3 flex-wrap">
        {/* Laissé vide, le titre est déduit du prompt côté serveur (heuristique
            immédiate, puis titre modèle en quelques secondes). */}
        <input className={`${inputCls} flex-1 min-w-[200px]`} placeholder="Titre — laisse vide pour un titre automatique"
          title="Vide : le titre est déduit automatiquement du prompt"
          value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
        <select className={inputCls} value={form.preset} onChange={e => setForm(f => ({ ...f, preset: e.target.value }))}>
          {PRESETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className={inputCls} value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value }))}>
          <option value="implement">Implémenter</option>
          <option value="question">Question (lecture seule, en parallèle)</option>
        </select>
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600" title="Reprend la session Claude de l'item précédent — pour un prompt qui poursuit le travail du précédent">
          <input type="checkbox" checked={form.same_context} onChange={e => setForm(f => ({ ...f, same_context: e.target.checked }))} />
          Poursuit le contexte du précédent
        </label>
        {/* Même effet que le bouton « Passer en premier » d'une carte, mais dès la
            création : l'item se dépose devant la file au lieu d'à la fin. */}
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600" title="Dépose l'item en tête de file au lieu de la fin — il part avant les autres">
          <input type="checkbox" checked={form.priority} data-testid="travaux-new-priority"
            onChange={e => setForm(f => ({ ...f, priority: e.target.checked }))} />
          <ChevronsUp size={13} className="text-slate-400" /> Mettre en priorité
        </label>
        <button className={btnCls} onClick={() => setOpen(false)}>Annuler</button>
        <button className={btnPrimary} onClick={add} disabled={saving || !form.prompt.trim()}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Ajouter à la file
        </button>
      </div>
    </div>
  )
}

// Combien de conversations terminées on rend d'emblée : au-delà, un bouton. Le fil
// complet de chacune est de toute façon replié, mais rendre 200 cartes coûte cher.
const HISTORY_PAGE = 15

function QueueTab({ toast, space }) {
  const [data, setData] = useState({
    prompts: [], agent_enabled: true, runner_busy: false, running_questions: 0, max_parallel_questions: 2,
    queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
  })
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('file')
  const [search, setSearch] = useState('')
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE)

  // Plusieurs chargements peuvent être en vol en même temps (temps réel + sondage +
  // rechargement après une action). Sans numéro d'ordre, une réponse partie AVANT un
  // réordonnancement pouvait arriver APRÈS et remettre la liste dans l'ordre d'avant.
  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      // Chaque page ne charge que SA file (finance ou agent) : les deux listes
      // sont indépendantes, seul l'exécuteur est partagé.
      const fresh = await api.travaux.listPrompts({ space })
      if (mine === seq.current) setData(fresh)
    }
    catch (e) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [toast, space])

  // Rafraîchir pendant que l'utilisateur écrit dans une carte re-rend toute la
  // liste sous ses doigts. On note qu'un rafraîchissement est dû et on le passe
  // dès que le champ perd le focus.
  const stale = useRef(false)
  const typing = () => {
    const el = document.activeElement
    return !!(el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.closest('[data-prompt-id]'))
  }
  const softLoad = useCallback(() => {
    if (typing()) { stale.current = true; return }
    load()
  }, [load])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onEvt = () => softLoad()
    // Le passage « en attente → en cours » se joue côté ordonnanceur : il n'émet pas
    // d'événement de file, seulement une mise à jour de tâche. Sans cette écoute, la
    // carte resterait « En attente » jusqu'au rafraîchissement lent.
    const onTask = (e) => { if (e.detail?.kind === 'queue') softLoad() }
    window.addEventListener('travaux:prompts:updated', onEvt)
    window.addEventListener('agent:task:updated', onTask)
    // Filet : l'exécution en cours n'émet pas d'événement à chaque étape, un
    // rafraîchissement lent garde la durée et l'état à jour.
    const t = setInterval(softLoad, 20_000)
    return () => {
      window.removeEventListener('travaux:prompts:updated', onEvt)
      window.removeEventListener('agent:task:updated', onTask)
      clearInterval(t)
    }
  }, [softLoad])

  // « running » côté DB couvre deux réalités : l'item que Claude traite vraiment et
  // celui qui attend son tour chez l'ordonnanceur. On les sépare pour l'affichage,
  // en gardant les vrais « en cours » en tête de liste.
  // Un item qui attend une réponse sort de l'historique et passe tout en haut : c'est
  // le seul état où le travail est arrêté par nous, pas par l'agent.
  const { asking, executing, waiting, queuedList, pausedList, history } = useMemo(() => {
    const running = data.prompts.filter(p => p.status === 'running')
    return {
      asking: data.prompts.filter(isAsking),
      executing: running.filter(p => p.run_state === 'executing'),
      waiting: running.filter(p => p.run_state !== 'executing'),
      queuedList: data.prompts.filter(p => p.status === 'queued'),
      pausedList: data.prompts.filter(p => p.status === 'paused'),
      history: data.prompts.filter(p => ['done', 'blocked', 'cancelled'].includes(p.status) && !isAsking(p)),
    }
  }, [data.prompts])

  const matches = useCallback((p) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return [p.title, p.prompt, ...(p.messages || []).map(m => m.text)]
      .some(t => String(t || '').toLowerCase().includes(q))
  }, [search])

  const fileList = useMemo(
    () => [...asking, ...executing, ...waiting, ...queuedList, ...pausedList].filter(matches),
    [asking, executing, waiting, queuedList, pausedList, matches])
  const historyList = useMemo(() => history.filter(matches), [history, matches])

  const create = async (form) => {
    try { await api.travaux.createPrompt({ ...form, space }); load() }
    catch (e) { toast.error(e.message); throw e }
  }

  // Renvoie la ligne serveur : l'autosave des cartes s'en sert pour savoir si sa
  // frappe est bien arrivée (et accepter une normalisation côté serveur).
  const patch = useCallback(async (id, p) => {
    try {
      const row = await api.travaux.updatePrompt(id, p)
      load()
      return row
    } catch (e) { toast.error(e.message); return null }
  }, [load, toast])
  const remove = useCallback(async (id) => {
    try { await api.travaux.deletePrompt(id); load() } catch (e) { toast.error(e.message) }
  }, [load, toast])
  const first = useCallback(async (id) => {
    try { await api.travaux.promptFirst(id); load() } catch (e) { toast.error(e.message) }
  }, [load, toast])

  // ── Priorité : réordonner la file ──────────────────────────────────────────
  // Seule une exécution RÉELLEMENT en cours est intouchable. Les items « en
  // attente » (remis à l'ordonnanceur, pas encore démarrés) se réordonnent avec
  // ceux de la file — le serveur les lui reprend et les lui rend dans le nouvel
  // ordre. Deux groupes, chacun réordonnable en son sein : « en file » (attente +
  // file) et « de côté » — le serveur trie toujours la file avant les items de
  // côté, un glissement d'un groupe à l'autre reviendrait en place.
  const groupIds = useMemo(() => ({
    queued: [...waiting, ...queuedList].map(p => p.id),
    paused: pausedList.map(p => p.id),
  }), [waiting, queuedList, pausedList])
  const groupOf = useCallback((id) => (
    groupIds.queued.includes(id) ? 'queued' : groupIds.paused.includes(id) ? 'paused' : null
  ), [groupIds])

  const applyOrder = useCallback(async (group, ids) => {
    if (ids.every((id, i) => id === groupIds[group][i])) return
    const ordered = group === 'queued' ? [...ids, ...groupIds.paused] : [...groupIds.queued, ...ids]
    const slots = new Set(ordered)
    // Optimiste : la carte bouge tout de suite, le serveur confirme derrière. Les
    // items déplaçables reprennent leurs propres emplacements dans le tableau,
    // dans le nouvel ordre — les autres cartes ne bronchent pas.
    setData(d => {
      const moved = ordered.map(id => d.prompts.find(p => p.id === id)).filter(Boolean)
      let i = 0
      return { ...d, prompts: d.prompts.map(p => (slots.has(p.id) ? moved[i++] : p)) }
    })
    try {
      await api.travaux.reorderPrompts(executing.map(p => p.id).concat(ordered))
    } catch (e) { toast.error(e.message) }
    load()
  }, [groupIds, executing, load, toast])

  const move = useCallback((id, delta) => {
    const group = groupOf(id)
    if (!group) return
    const list = groupIds[group]
    const i = list.indexOf(id)
    const j = i + delta
    if (j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    applyOrder(group, next)
  }, [groupIds, groupOf, applyOrder])

  const [dragId, setDragId] = useState(null)
  const [dragOver, setDragOver] = useState({ id: null, side: null })
  const dragIdRef = useRef(null)
  const sideOf = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    return (e.clientY - r.top) < r.height / 2 ? 'before' : 'after'
  }
  const resetDrag = useCallback(() => {
    dragIdRef.current = null
    setDragId(null)
    setDragOver({ id: null, side: null })
  }, [])
  const dnd = {
    dragId,
    dragOverId: dragOver.id,
    dragOverSide: dragOver.side,
    // Rien à réordonner quand l'item est seul de son groupe : pas de poignée.
    canMove: (id) => (groupIds[groupOf(id)]?.length || 0) > 1,
    isFirst: (id) => groupIds[groupOf(id)]?.[0] === id,
    isLast: (id) => groupIds[groupOf(id)]?.slice(-1)[0] === id,
    move,
    dragStart: (e, id, card) => {
      dragIdRef.current = id
      setDragId(id)
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', id) } catch { /* Safari */ }
        // Fantôme = la carte entière, pas la poignée seule.
        if (card) { try { e.dataTransfer.setDragImage(card, 24, 24) } catch { /* vieux navigateurs */ } }
      }
    },
    dragOver: (e, id) => {
      const src = dragIdRef.current
      if (!src || src === id || groupOf(src) !== groupOf(id)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const side = sideOf(e)
      setDragOver(prev => (prev.id === id && prev.side === side ? prev : { id, side }))
    },
    drop: (e, targetId) => {
      e.preventDefault()
      const sourceId = dragIdRef.current
      // Le côté est recalculé ici : React groupe les setState du dragOver, donc
      // l'état peut être périmé au moment du drop (surtout en test synchrone).
      const side = sideOf(e)
      resetDrag()
      const group = groupOf(sourceId)
      if (!sourceId || sourceId === targetId || group !== groupOf(targetId)) return
      const next = groupIds[group].filter(id => id !== sourceId)
      let idx = next.indexOf(targetId)
      if (idx === -1) return
      if (side === 'after') idx += 1
      next.splice(idx, 0, sourceId)
      applyOrder(group, next)
    },
    dragEnd: resetDrag,
  }
  // Répondre relance la tâche : le fil est réinjecté dans le prompt, et la session
  // Claude précédente est reprise quand elle existe encore.
  const reply = useCallback(async (id, text) => {
    try {
      await api.travaux.replyToPrompt(id, text)
      // En pause, la relance est bien enregistrée mais ne démarrera qu'à la reprise :
      // le dire évite d'attendre devant une carte qui ne bouge pas.
      toast.success(data.queue_paused
        ? 'Réponse enregistrée — la file est en pause, la tâche repartira à la reprise'
        : 'Réponse envoyée — la tâche repart')
      load()
    } catch (e) { toast.error(e.message); throw e }
  }, [data.queue_paused, load, toast])

  // Steering : message glissé à Claude PENDANT l'exécution (rien n'est relancé).
  // `delivered` distingue la voie : en direct (hook) ou intégré au brief au départ.
  const steer = useCallback(async (id, text) => {
    try {
      const out = await api.travaux.steerPrompt(id, text)
      toast.success(out.delivered === 'live'
        ? 'Message transmis — Claude le prend en compte sans interrompre la tâche'
        : 'Message noté — il partira avec la tâche au démarrage')
      load()
    } catch (e) { toast.error(e.message); throw e }
  }, [load, toast])

  const advance = async () => {
    try {
      const { started, startedCount, reason } = await api.travaux.advanceQueue()
      if (startedCount > 1) toast.success(`${startedCount} items démarrés`)
      else if (started) toast.success(`« ${started.title} » démarré`)
      else if (reason === 'queue-paused') toast.error('La file est en pause — reprends-la avec le bouton en haut de page')
      else if (reason === 'agent-disabled') toast.error("L'agent est désactivé — activez-le sur la page Agent")
      else if (reason === 'busy') toast.info('Tout ce qui pouvait démarrer tourne déjà')
      else toast.info('Rien à lancer : la file est vide')
      load()
    } catch (e) { toast.error(e.message) }
  }

  const rowProps = { onPatch: patch, onDelete: remove, onFirst: first, onReply: reply, onSteer: steer }
  const seg = (active) => `inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition ${
    active ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800'}`

  return (
    <div>
      {/* Pause en cours : le dire ici aussi (le bouton est en haut de page), sinon une
          file qui n'avance pas ressemble à une panne. */}
      {data.queue_paused && (
        <div
          className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
          data-testid="travaux-queue-paused-banner"
        >
          <PauseCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">File en pause — aucune nouvelle tâche ne démarre.</div>
            <div className="text-xs text-amber-700/90 mt-0.5">
              {data.queue_paused_reason || 'Pause posée à la main.'} La tâche en cours va au bout ;
              à la reprise, la file repart exactement où elle s'est arrêtée — rien n'est refait.
            </div>
          </div>
        </div>
      )}

      <NewPromptComposer agentEnabled={data.agent_enabled} onCreate={create} />

      {/* Barre de navigation : deux vues, comptées, et une recherche. Elle colle en
          haut pour rester accessible sans remonter toute la liste. */}
      <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-slate-50/95 backdrop-blur-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100">
            <button className={seg(view === 'file')} data-testid="travaux-view-file" onClick={() => setView('file')}>
              <ListOrdered size={14} /> File
              <span className="text-xs text-slate-400">{asking.length + executing.length + waiting.length + queuedList.length + pausedList.length}</span>
            </button>
            <button className={seg(view === 'conversations')} data-testid="travaux-view-conversations" onClick={() => setView('conversations')}>
              <MessageSquare size={14} /> Conversations
              <span className="text-xs text-slate-400">{history.length}</span>
            </button>
          </div>

          {!!asking.length && view !== 'file' && (
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100"
              onClick={() => setView('file')}
            ><HelpCircle size={13} /> {asking.length} à répondre</button>
          )}

          <div className="flex-1" />

          <input
            className={`${inputCls} w-44`}
            placeholder="Rechercher…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            data-testid="travaux-search"
          />
          {view === 'file' && (
            <>
              {/* Les questions étant en lecture seule, elles tournent à plusieurs et en
                  même temps qu'un chantier : le bouton reste actif tant qu'il reste
                  quelque chose de démarrable. */}
              {data.running_questions > 0 && (
                <span className="text-xs text-slate-500">
                  {data.running_questions}/{data.max_parallel_questions} question{data.running_questions > 1 ? 's' : ''} en parallèle
                </span>
              )}
              <button
                className={btnCls}
                onClick={advance}
                disabled={data.queue_paused || !queuedList.length}
                title={data.queue_paused ? 'File en pause — reprends-la avec le bouton en haut de page' : undefined}
              >
                <Play size={14} /> Lancer la file
              </button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2 mt-3"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : view === 'file' ? (
        <div
          className="space-y-1.5 mt-1"
          onDragEnd={dnd.dragEnd}
          onBlur={() => { if (stale.current) { stale.current = false; load() } }}
        >
          {fileList.map(p => <PromptRow key={p.id} p={p} dnd={dnd} {...rowProps} />)}
          {!fileList.length && (
            <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center">
              {search.trim() ? 'Aucun item ne correspond à cette recherche.' : 'File vide. Ajoute un prompt ci-dessus — il partira tout seul.'}
            </div>
          )}
          {groupIds.queued.length > 1 && !search.trim() && (
            <p className="text-xs text-slate-400 pt-1">
              L'ordre de la liste = l'ordre de départ. Glisse une carte par sa poignée, ou utilise les flèches.
              Tant qu'un item n'a pas démarré — « en attente » compris — son prompt et sa place restent modifiables.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1.5 mt-1">
          {historyList.slice(0, historyLimit).map(p => <PromptRow key={p.id} p={p} {...rowProps} />)}
          {!historyList.length && (
            <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center">
              {search.trim() ? 'Aucune conversation ne correspond à cette recherche.' : 'Aucune tâche terminée pour l\'instant.'}
            </div>
          )}
          {historyList.length > historyLimit && (
            <button className={`${btnCls} w-full justify-center`} onClick={() => setHistoryLimit(n => n + HISTORY_PAGE)}>
              Afficher {Math.min(HISTORY_PAGE, historyList.length - historyLimit)} conversations de plus
              <span className="text-slate-400">· {historyList.length - historyLimit} restantes</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Onglet 2 : suggestions de l'agent ────────────────────────────────────────

function SuggestionCard({ s, onAccept, onDismiss }) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState(s.prompt)
  useEffect(() => { setPrompt(s.prompt) }, [s.prompt])

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {s.kind === 'integration' && (
              <span className="px-2 py-0.5 text-xs rounded-full bg-indigo-50 text-indigo-700 inline-flex items-center gap-1">
                <Plug size={11} /> Intégration
              </span>
            )}
            {s.area && <span className="px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-600">{s.area}</span>}
            {s.status === 'accepted' && <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-50 text-emerald-700">Dans ma file</span>}
            {s.status === 'dismissed' && <span className="px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-500">Rejetée</span>}
          </div>
          <div className="mt-1.5 text-sm font-medium text-slate-800">{s.title}</div>
          {s.rationale && <p className="mt-1 text-sm text-slate-600">{s.rationale}</p>}
          <button className="mt-2 text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1" onClick={() => setOpen(o => !o)}>
            <ChevronDown size={12} className={open ? 'rotate-180 transition' : 'transition'} />
            {open ? 'Masquer le prompt' : 'Voir / ajuster le prompt'}
          </button>
          {open && (
            <textarea className={`${inputCls} w-full mt-2 font-mono text-xs`} rows={8} value={prompt} onChange={e => setPrompt(e.target.value)} />
          )}
        </div>
        {s.status === 'new' && (
          <div className="flex flex-col gap-1.5 shrink-0">
            <button className={btnPrimary} onClick={() => onAccept(s.id, prompt !== s.prompt ? prompt : null)} title="Ajouter à ma file">
              <Check size={14} /> Ajouter
            </button>
            <button className={btnCls} onClick={() => onDismiss(s.id)}><X size={14} /> Rejeter</button>
          </div>
        )}
      </div>
    </div>
  )
}

// Deux natures de suggestions dans la même liste : un chantier à faire dans l'ERP
// tel qu'il est, ou un outil externe à brancher. Le filtre pilote AUSSI le bouton
// « Générer » — on relance le moteur qu'on est en train de regarder.
const SUGGESTION_KINDS = [['', 'Tout'], ['chantier', 'Chantiers'], ['integration', 'Intégrations']]

function SuggestionsTab({ toast, space }) {
  const [suggestions, setSuggestions] = useState([])
  const [status, setStatus] = useState('new')
  const [kind, setKind] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)

  const load = useCallback(async () => {
    try {
      const { suggestions } = await api.travaux.listSuggestions({
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
      })
      setSuggestions(suggestions)
    } catch (e) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [status, kind, toast])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onEvt = () => { setGenerating(false); load() }
    window.addEventListener('travaux:suggestions:updated', onEvt)
    return () => window.removeEventListener('travaux:suggestions:updated', onEvt)
  }, [load])

  const generate = async () => {
    setGenerating(true)
    try {
      await api.travaux.generateSuggestions(kind || null)
      toast.info(kind === 'integration'
        ? 'Recherche d\'outils à brancher lancée — les propositions apparaîtront ici'
        : 'Analyse lancée — les suggestions apparaîtront ici')
    } catch (e) { setGenerating(false); toast.error(e.message) }
  }
  const accept = async (id, prompt) => {
    try {
      await api.travaux.acceptSuggestion(id, prompt, space)
      toast.success('Ajoutée à ta file')
      load()
    } catch (e) { toast.error(e.message) }
  }
  const dismiss = async (id) => {
    try { await api.travaux.dismissSuggestion(id); load() } catch (e) { toast.error(e.message) }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {[['new', 'Nouvelles'], ['accepted', 'Dans ma file'], ['dismissed', 'Rejetées']].map(([v, l]) => (
            <button
              key={v}
              className={`px-3 py-1.5 text-sm rounded-lg ${status === v ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              onClick={() => setStatus(v)}
            >{l}</button>
          ))}
          <span className="w-px h-5 bg-slate-200 mx-1.5" />
          {SUGGESTION_KINDS.map(([v, l]) => (
            <button
              key={v || 'all'}
              className={`px-3 py-1.5 text-sm rounded-lg inline-flex items-center gap-1.5 ${kind === v ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              onClick={() => setKind(v)}
            >{v === 'integration' && <Plug size={13} />}{l}</button>
          ))}
        </div>
        <button
          className={btnCls}
          onClick={generate}
          disabled={generating}
          title={kind === 'integration' ? 'Chercher des outils externes à brancher'
            : kind === 'chantier' ? 'Chercher des chantiers'
              : 'Chercher des chantiers ET des outils à brancher'}
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {kind === 'integration' ? 'Chercher des intégrations' : 'Générer maintenant'}
        </button>
      </div>

      <p className="text-xs text-slate-500 mb-4">
        L'agent regarde chaque matin les travaux que tu fais encore à la main, les chantiers récents et les erreurs de synchronisation,
        puis propose ici les prochaines étapes. Il propose aussi des <strong className="font-medium text-slate-600">intégrations</strong> — des
        logiciels ou des API externes à brancher à l'ERP, en tenant compte de ce qui est déjà connecté — avec ce que le branchement débloquerait.
        Rien ne s'exécute avant que tu ne l'ajoutes à ta file.
      </p>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : suggestions.length ? (
        <div className="space-y-2.5">
          {suggestions.map(s => <SuggestionCard key={s.id} s={s} onAccept={accept} onDismiss={dismiss} />)}
        </div>
      ) : (
        <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center">
          Aucune {kind === 'integration' ? 'intégration proposée' : 'suggestion'} {status === 'new' ? 'en attente' : ''}.
        </div>
      )}
    </div>
  )
}

// ─── Onglet 3 : carnet d'idées ────────────────────────────────────────────────
//
// Le seul onglet d'où rien ne peut partir en exécution : une idée se garde et se
// relit (« The Future of ERP Systems » n'avait rien à faire dans la file, où tout
// est destiné à être fait). Le passage à l'action est un geste explicite, et
// l'item créé arrive « de côté » dans la file — jamais lancé d'office.

function IdeaCard({ idea, onPatch, onDelete, onPromote, onMove, isFirst, isLast }) {
  const [draft, setDraft] = useState({ title: idea.title, notes: idea.notes || '', tag: idea.tag || '' })
  const { queue, flush } = useAutosave(patch => onPatch(idea.id, patch))
  useEffect(() => {
    setDraft({ title: idea.title, notes: idea.notes || '', tag: idea.tag || '' })
  }, [idea.title, idea.notes, idea.tag])

  const arrow = 'p-0.5 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-0'
  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-3.5" data-idea-id={idea.id}>
      <div className="flex items-start gap-2.5">
        <div className="flex flex-col items-center shrink-0 -ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button className={arrow} title="Monter" aria-label="Monter" data-testid="idea-move-up"
            disabled={isFirst} onClick={() => onMove(idea.id, -1)}><ChevronUp size={14} /></button>
          <button className={arrow} title="Descendre" aria-label="Descendre" data-testid="idea-move-down"
            disabled={isLast} onClick={() => onMove(idea.id, 1)}><ChevronDown size={14} /></button>
        </div>
        <Lightbulb size={15} className="text-amber-400 mt-1.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <input
            className="w-full bg-transparent text-sm font-medium text-slate-800 border-0 p-0 focus:outline-none"
            value={draft.title}
            placeholder="Titre de l'idée"
            onChange={e => { setDraft(d => ({ ...d, title: e.target.value })); queue({ title: e.target.value }) }}
            onBlur={flush}
          />
          <textarea
            className="w-full mt-1.5 bg-transparent text-sm text-slate-600 border-0 p-0 focus:outline-none resize-y placeholder:text-slate-300"
            rows={draft.notes ? 3 : 1}
            placeholder="Développer l'idée…"
            value={draft.notes}
            onChange={e => { setDraft(d => ({ ...d, notes: e.target.value })); queue({ notes: e.target.value }) }}
            onBlur={flush}
          />
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <input
              className="w-40 text-xs text-slate-500 bg-transparent border-0 p-0 focus:outline-none placeholder:text-slate-300"
              placeholder="thème…"
              value={draft.tag}
              onChange={e => { setDraft(d => ({ ...d, tag: e.target.value })); queue({ tag: e.target.value }) }}
              onBlur={flush}
            />
            {idea.work_prompt_id && (
              <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-50 text-emerald-700">Déjà dans ma file</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <button
            className={btnCls}
            onClick={() => onPromote(idea.id)}
            title="Créer un item dans ma file, mis de côté — rien ne se lance tant que tu ne le démarres pas"
            data-testid="idea-promote"
          ><ListOrdered size={14} /> Passer à l'action</button>
          <button className={`${btnCls} text-rose-600`} onClick={() => onDelete(idea.id)} title="Retirer l'idée" data-testid="idea-delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

function IdeasTab({ toast, space }) {
  const [ideas, setIdeas] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ title: '', notes: '' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try { setIdeas((await api.travaux.listIdeas()).ideas) }
    catch (e) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onEvt = () => load()
    window.addEventListener('travaux:ideas:updated', onEvt)
    return () => window.removeEventListener('travaux:ideas:updated', onEvt)
  }, [load])

  // Création : pas d'autosave possible (aucun id avant l'envoi) — voir CLAUDE.md.
  const add = async () => {
    if (!form.title.trim()) return
    setSaving(true)
    try {
      await api.travaux.createIdea(form)
      setForm({ title: '', notes: '' })
      load()
    } catch (e) { toast.error(e.message) }
    finally { setSaving(false) }
  }
  const patch = async (id, p) => {
    try { await api.travaux.updateIdea(id, p) } catch (e) { toast.error(e.message); load() }
  }
  const remove = async (id) => {
    setIdeas(prev => prev.filter(x => x.id !== id))
    try { await api.travaux.deleteIdea(id) } catch (e) { toast.error(e.message); load() }
  }
  const promote = async (id) => {
    try {
      const { already } = await api.travaux.promoteIdea(id, space)
      toast.success(already
        ? 'Cette idée a déjà son item dans ta file (mis de côté)'
        : 'Ajoutée à ta file, mise de côté — démarre-la quand tu veux')
      load()
    } catch (e) { toast.error(e.message) }
  }
  // Réordonner : le carnet garde l'ordre qu'on lui donne (optimiste, le serveur suit).
  const move = async (id, delta) => {
    const i = ideas.findIndex(x => x.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= ideas.length) return
    const next = [...ideas]
    ;[next[i], next[j]] = [next[j], next[i]]
    setIdeas(next)
    try { await api.travaux.reorderIdeas(next.map(x => x.id)) } catch (e) { toast.error(e.message); load() }
  }

  return (
    <div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-5">
        <div className="text-sm font-semibold text-slate-800 mb-3">Nouvelle idée</div>
        <input
          className={`${inputCls} w-full`}
          placeholder="L'idée en une ligne…"
          value={form.title}
          onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) add() }}
          data-testid="idea-title-input"
        />
        <textarea
          className={`${inputCls} w-full mt-2`}
          rows={2}
          placeholder="Développer (facultatif) — pourquoi, pistes, ce que ça changerait…"
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
        />
        <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
          <p className="text-xs text-slate-500">
            Rien ne s'exécute depuis les idées : elles restent là pour être relues.
          </p>
          <button className={btnPrimary} onClick={add} disabled={saving || !form.title.trim()} data-testid="idea-add">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Garder l'idée
          </button>
        </div>
      </div>

      <h2 className="text-sm font-semibold text-slate-800 mb-3">
        Mes idées <span className="text-slate-400 font-normal">· {ideas.length}</span>
      </h2>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : ideas.length ? (
        <div className="space-y-2.5">
          {ideas.map((idea, i) => (
            <IdeaCard
              key={idea.id} idea={idea} onPatch={patch} onDelete={remove} onPromote={promote}
              onMove={move} isFirst={i === 0} isLast={i === ideas.length - 1}
            />
          ))}
        </div>
      ) : (
        <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center">
          Aucune idée pour l'instant. Note ci-dessus ce que tu veux garder sous la main.
        </div>
      )}
    </div>
  )
}


// ─── Pause de la file ─────────────────────────────────────────────────────────

/**
 * Bouton pause / reprise de la file, en haut de page à côté de la consommation de
 * Claude : on voit ce qu'il reste de quota, et on coupe d'un clic si on veut en
 * garder pour plus tard. Bouton assumé (pas d'autosave) : c'est une action à effet
 * réel — elle décide si des exécutions démarrent.
 *
 * Ce qu'elle NE fait pas : tuer l'exécution en cours. La pause bloque les départs,
 * donc reprendre repart d'où la file s'était arrêtée, sans rien recommencer.
 *
 * État autonome (pas de props) pour rester visible sur les trois onglets ; la
 * synchro avec la liste passe par l'événement temps réel `travaux:prompts:updated`,
 * que les deux côtés écoutent.
 */
function QueuePauseControl({ toast }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setState(await api.travaux.getQueuePause()) } catch { /* silencieux : jamais bloquant */ }
  }, [])

  useEffect(() => {
    load()
    const onEvt = () => load()
    window.addEventListener('travaux:prompts:updated', onEvt)
    // Filet : la pause peut être posée par le serveur (item « arrêter après celle-ci »)
    // alors que la page est ouverte sans que rien d'autre ne bouge.
    const t = setInterval(load, 30_000)
    return () => { window.removeEventListener('travaux:prompts:updated', onEvt); clearInterval(t) }
  }, [load])

  const toggle = async () => {
    const next = !state?.paused
    setBusy(true)
    try {
      const out = await api.travaux.setQueuePaused(next)
      setState({ paused: out.paused, paused_at: out.paused_at, reason: out.reason })
      toast.success(next
        ? 'File en pause — la tâche en cours finit, aucune autre ne démarre'
        : out.startedCount ? 'File reprise — le travail suivant démarre' : 'File reprise')
      // La liste (bandeau, bouton « Lancer la file ») se remet à jour comme si le
      // serveur avait diffusé : la reprise passe par la même route pour tout le monde.
      window.dispatchEvent(new CustomEvent('travaux:prompts:updated'))
    } catch (e) { toast.error(e.message) }
    finally { setBusy(false) }
  }

  const paused = !!state?.paused
  return (
    <button
      data-testid="travaux-pause-queue"
      data-paused={paused ? '1' : '0'}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border shrink-0 disabled:opacity-50 ${
        paused
          ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
      }`}
      disabled={busy || !state}
      onClick={toggle}
      title={paused
        ? 'Reprendre la file là où elle s\'est arrêtée'
        : 'Mettre la file en pause : la tâche en cours va au bout, aucune autre ne démarre'}
    >
      {busy ? <Loader2 size={14} className="animate-spin" />
        : paused ? <PlayCircle size={14} /> : <PauseCircle size={14} />}
      {paused ? 'Reprendre la file' : 'Pause'}
    </button>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'file', label: 'Ma file de prompts', icon: ListOrdered },
  { key: 'suggestions', label: 'Suggestions de Claude', icon: Sparkles },
  { key: 'idees', label: 'Idées', icon: Lightbulb },
]
// La même page sert deux sections : Espace finance (/travaux) et Agent
// (/agent/travaux). Chacune a SA file de prompts (listes distinctes en DB, un seul
// exécuteur partagé) ; les suggestions et les idées, elles, sont les mêmes partout —
// seul l'endroit où « Ajouter » / « Passer à l'action » dépose l'item change.
const SPACE_CONFIG = {
  finance: {
    title: 'Travaux',
    intro: "Ta file de prompts pour l'agent, ses recommandations, et ton carnet d'idées.",
    tabs: TABS,
  },
  agent: {
    title: "Travaux de l'agent",
    intro: "La file de prompts de la section Agent — distincte de celle de l'Espace finance, mais exécutée par le même agent (une implémentation à la fois, toutes files confondues). Suggestions et idées sont partagées entre les deux sections.",
    tabs: TABS,
  },
}

export default function Travaux({ space = 'finance' }) {
  const { addToast } = useToast()
  const cfg = SPACE_CONFIG[space] || SPACE_CONFIG.finance
  // Adaptateur : les onglets appellent toast.error/success/info, le provider
  // expose addToast({ message, type }).
  const toast = useMemo(() => ({
    error:   m => addToast({ message: m, type: 'error' }),
    success: m => addToast({ message: m, type: 'success' }),
    info:    m => addToast({ message: m, type: 'info' }),
  }), [addToast])
  // L'URL est la source de vérité de l'onglet : un lien Slack, un rechargement
  // ou le sous-menu de la sidebar (?onglet=…) retombent au bon endroit, même
  // quand la page est déjà montée.
  const [params, setParams] = useSearchParams()
  const asked = params.get('onglet')
  const tab = cfg.tabs.some(x => x.key === asked) ? asked : 'file'
  const select = (key) => setParams({ onglet: key }, { replace: true })

  return (
    <Layout>
      <div className="p-6 max-w-5xl" data-travaux-space={space}>
        <h1 className="text-2xl font-bold text-slate-900">{cfg.title}</h1>
        <p className="text-sm text-slate-500 mt-1 mb-4">
          {cfg.intro}
        </p>

        {/* Consommation de Claude + frein d'urgence, à la même hauteur : on voit ce
            qu'il reste de quota et on coupe d'un clic si on veut en garder pour la
            journée de quelqu'un d'autre. Le bouton reste là même si la lecture de
            l'utilisation échoue (le bandeau, lui, s'efface silencieusement). */}
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <ClaudeUsageStrip className="mb-0 flex-1 min-w-[300px]" />
          <QueuePauseControl toast={toast} />
        </div>

        <div className="flex items-center gap-1 border-b border-slate-200 mb-5">
          {cfg.tabs.map(t => (
            <button
              key={t.key}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
              onClick={() => select(t.key)}
            >
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'file' && <QueueTab toast={toast} space={space} />}
        {tab === 'suggestions' && <SuggestionsTab toast={toast} space={space} />}
        {tab === 'idees' && <IdeasTab toast={toast} space={space} />}
      </div>
    </Layout>
  )
}
```

### `client/src/lib/api.js` — extrait : client HTTP de la fonctionnalité

`getFresh` = GET sans cache (les listes changent en arrière-plan à chaque fin d'exécution). Les routes `recurring` sont retirées.

```js
  // Travaux : file de prompts, suggestions de l'agent, carnet d'idées, travaux
  // récurrents.
  // Les listes sont pollées via getFresh (pas de cache) : la file change en
  // arrière-plan à chaque fin d'exécution, un cache de 30 s la ferait mentir.
  travaux: {
    // `space` sépare les deux files : 'finance' (Espace finance) / 'agent' (section Agent).
    listPrompts:   (params = {}) => getFresh('/travaux/prompts' + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '')),
    createPrompt:  (data)      => post('/travaux/prompts', data),
    updatePrompt:  (id, data)  => patch(`/travaux/prompts/${id}`, data),
    deletePrompt:  (id)        => del(`/travaux/prompts/${id}`),
    reorderPrompts:(ids)       => post('/travaux/prompts/reorder', { ids }),
    promptFirst:   (id)        => post(`/travaux/prompts/${id}/first`, {}),
    advanceQueue:  ()          => post('/travaux/prompts/advance', {}),
    // Pause de la file : rien de nouveau ne démarre, l'exécution en cours va au bout.
    getQueuePause: ()          => getFresh('/travaux/queue/pause'),
    setQueuePaused:(paused, reason) => post('/travaux/queue/pause', { paused, reason }),
    listMessages:  (id)        => getFresh(`/travaux/prompts/${id}/messages`),
    replyToPrompt: (id, text)  => post(`/travaux/prompts/${id}/reply`, { text }),
    // Steering : message livré à Claude PENDANT l'exécution, sans l'interrompre.
    steerPrompt:   (id, text)  => post(`/travaux/prompts/${id}/message`, { text }),

    listSuggestions:  (params = {}) => getFresh('/travaux/suggestions?' + new URLSearchParams(params)),
    acceptSuggestion: (id, prompt, space)  => post(`/travaux/suggestions/${id}/accept`, { ...(prompt ? { prompt } : {}), ...(space ? { space } : {}) }),
    dismissSuggestion:(id, reason)  => post(`/travaux/suggestions/${id}/dismiss`, { reason }),
    deleteSuggestion: (id)          => del(`/travaux/suggestions/${id}`),
    // Sans `kind`, le serveur passe les deux moteurs (chantiers + intégrations).
    generateSuggestions: (kind)     => post('/travaux/suggestions/generate', kind ? { kind } : {}),

    // Carnet d'idées : rien ne s'exécute d'ici ; `promoteIdea` dépose un item de
    // file « de côté », à lancer à la main.
    listIdeas:    ()         => getFresh('/travaux/ideas'),
    createIdea:   (data)     => post('/travaux/ideas', data),
    updateIdea:   (id, data) => patch(`/travaux/ideas/${id}`, data),
    deleteIdea:   (id)       => del(`/travaux/ideas/${id}`),
    reorderIdeas: (ids)      => post('/travaux/ideas/reorder', { ids }),
    promoteIdea:  (id, space) => post(`/travaux/ideas/${id}/promote`, space ? { space } : {}),
```

### `client/src/lib/realtime.js` — extrait : pont WebSocket → événements `window`

```js
      state.authed = true
      if (state.offlineFlipTimer) { clearTimeout(state.offlineFlipTimer); state.offlineFlipTimer = null }
      markOnline()
      flushSubscriptions()
      return
    }
    if (msg.type === 'subscribed') return // ack — nothing to do

    // Back-compat global events
    if (msg.type === 'agent:task:updated') {
      window.dispatchEvent(new CustomEvent('agent:task:updated', { detail: msg.task }))
      return
    }
    if (msg.type === 'agent:task:stream') {
      window.dispatchEvent(new CustomEvent('agent:task:stream', { detail: msg }))
      return
    }
    if (msg.type === 'agent:settings:updated') {
      window.dispatchEvent(new CustomEvent('agent:settings:updated', { detail: msg.settings }))
      return
    }
    if (msg.type === 'agent:backlog:updated') {
      window.dispatchEvent(new CustomEvent('agent:backlog:updated', { detail: msg }))
      return
    }
    // Travaux (file de prompts, suggestions, travaux récurrents) : un seul
    // événement par liste, la page recharge la liste concernée.
    if (msg.type?.startsWith('travaux:')) {
      window.dispatchEvent(new CustomEvent(msg.type, { detail: msg }))
      return
    }
    if (msg.type === 'sync:progress') {
      window.dispatchEvent(new CustomEvent('sync:progress', { detail: msg }))
      return
    }

    // Channel-routed event
    if (msg.channel && state.channelHandlers.has(msg.channel)) {
      const handlers = state.channelHandlers.get(msg.channel)
      for (const fn of handlers) {
        try { fn(msg) } catch (e) { console.error('realtime handler error', e) }
```

---

## 9. Contrat d'API HTTP (toutes les routes sous `/api/travaux`, `requireAuth`)

| Méthode | Route | Corps / query | Réponse |
|---|---|---|---|
| GET | `/prompts` | `?space=finance` ou `agent` | `{ prompts[], agent_enabled, queue_paused, queue_paused_at, queue_paused_reason, runner_busy, running_questions, max_parallel_questions }` — chaque prompt enrichi de `pending_question` (objet), `user_summary`, `agent_status`, `run_state`, `lane`, `wait_rank`, `messages[]` |
| POST | `/prompts` | `{ prompt*, title?, mode?, preset?, same_context?, status?, priority?, space? }` | 201 item ; déclenche `advanceQueue()` |
| PATCH | `/prompts/:id` | champs éditables : `title, prompt, mode, preset, same_context, status, position, stop_after` | item |
| DELETE | `/prompts/:id` | — | `{ ok: true }` (soft delete + reprise à l'ordonnanceur si pas démarré) |
| POST | `/prompts/reorder` | `{ ids: [...] }` | `{ prompts[] }` |
| POST | `/prompts/:id/first` | — | item (passe en tête de SA file) |
| GET | `/prompts/:id/messages` | — | `{ messages[] }` |
| POST | `/prompts/:id/reply` | `{ text }` | 201 item — **relance** la tâche avec le fil ; 409 si l'exécution tourne |
| POST | `/prompts/:id/message` | `{ text }` | 201 `{ …item, delivered: 'live' ou 'queued' }` — steering ; 409 si la tâche a rendu la main |
| POST | `/prompts/advance` | — | `{ started, startedCount, reason }` — `reason ∈ busy · agent-disabled · queue-paused · empty` |
| GET, POST | `/queue/pause` | `{ paused: bool, reason? }` | `{ paused, paused_at, reason }` |
| GET | `/suggestions` | `?status=new·accepted·dismissed` + `&kind=chantier·integration` | `{ suggestions[] }` |
| POST | `/suggestions`, `/suggestions/:id/accept`, `/dismiss`, DELETE, `/suggestions/generate` | `accept: { prompt?, space? }` · `generate: { kind? }` (202, asynchrone) | |
| GET, POST, PATCH, DELETE | `/ideas`, `/ideas/:id`, `/ideas/reorder`, `/ideas/:id/promote` | `promote: { prompt?, space? }` | `promote` → 201 (ou 200 si déjà promue) |

---

## 10. Seams à traiter dans un portage

1. **Chemins en dur** (`taskRunner.js`) : `CLAUDE_BIN`, `CWD`, `HOME`, l'emplacement de
   `agent-tasks.json` / `agent-settings.json` / `agent-backlog.json` et des artefacts
   `.agent-exec-*`. À paramétrer par variables d'environnement.
2. **`recurringWork.js`** (exclu ici) : `workSuggestions.js` l'importe encore
   (`listRecurringTasks`) — c'est un *signal* du moteur de suggestions (« ce que tu fais encore à la
   main chaque semaine »). Le stub minimal est `() => []` ; le moteur fonctionne sans, avec un
   signal en moins.
3. **Prompts d'exécution** (`DEFAULT_EXECUTION_PROMPT`, `DEFAULT_QUESTION_PROMPT`, …) : ils portent
   les règles du projet Orisha (« modif client → `npm run build` puis test Playwright », « modif
   serveur → `pm2 restart` », max 3 tentatives de correction). **À réécrire** pour la definition of
   done de l'app cible. Ils sont surchargeables à chaud via `agent-settings.json`.
4. **`agentModel.js`** : dépend de `claudeUsage.js` (lecture des quotas de l'abonnement via
   `/api/oauth/usage`), non inclus ici. Stub acceptable : `getClaudeUsage()` qui lève → tout retombe
   sur la voie réactive (détection dans le transcript) et le repli par défaut.
5. **Notifications** : `SLACK_WEBHOOK_PERSO` (recap une ligne) — remplaçable par n'importe quel
   canal. Ne pas recopier le compte-rendu complet dans la notification : décision explicite après
   essai (illisible, et le fil de la carte est le bon endroit).
6. **`backlog` / bulle d'aide** : `taskRunner.js` contient aussi le circuit « signalement
   utilisateur → proposition instantanée → approbation → implémentation » (`addBacklogItem`,
   `generateInstantProposal`, `approveBacklogItem`, `conversationReply`, `kind: 'suggestion'` /
   `'proposal'`). Ce n'est **pas** nécessaire à la file : supprimable, mais `kick()`,
   `releaseSlot()`, `getSettings()` et le format de tâche sont partagés — les retirer demande de
   garder ces quatre-là.
7. **Auth / temps réel** : `requireAuth` (JWT) et `broadcastAll` sont les deux seules dépendances
   d'infrastructure de `promptQueue.js`. Sans WebSocket, le sondage 20 s du client suffit (avec un
   ressenti dégradé).
8. **Composants UI empruntés à l'app** : `Layout`, `useToast`, `ClaudeUsageStrip`, `api.js`
   (wrapper fetch avec `getFresh` = sans cache), classes Tailwind (`brand-*` = palette du projet).

---

## 11. Décisions de conception à ne pas défaire (leçons déjà payées)

- **`setsid --fork` n'est pas cosmétique** : pm2 tue tout le sous-arbre du serveur à chaque
  `restart`. Sans coupure de lignée, une exécution mourait au redémarrage qu'elle déclenchait
  elle-même après une modif serveur — rapport tronqué, puis compte-rendu inventé par-dessus.
- **Résultat lu depuis des fichiers durables**, jamais depuis le pipe stdout : un redémarrage du
  parent ne peut ni perdre le résultat ni SIGPIPE-tuer l'enfant.
- **« running » ≠ « Claude travaille »** : un item remis à l'ordonnanceur attend souvent son tour.
  Sans la distinction `run_state`, deux réponses envoyées coup sur coup affichaient deux « En
  cours » et l'item semblait bloqué.
- **Un item pas encore démarré reste modifiable** : le figer bloquait la file dès que deux items
  étaient poussés coup sur coup.
- **Le fil est réinjecté en clair** dans le prompt de relance : la continuité ne doit jamais dépendre
  de `--resume` (une session purgée casserait tout). `--resume` n'est qu'un bonus de contexte.
- **Un quota épuisé n'est pas un échec** : marquer « bloqué » brûlait toute la file en quelques
  secondes, chaque item repartant pour mourir aussitôt avec un message d'erreur trompeur.
- **Compte-rendu jamais placeholder** : si la section `RÉSUMÉ UTILISATEUR` manque, on génère un
  compte-rendu de secours (sans outils) et, à défaut, on montre le rapport technique brut. Un
  réparateur idempotent (`repairAgentReplies`) rattrape les fils abîmés par un redémarrage.
- **Anti-fabulation** : le prompt du compte-rendu de secours interdit explicitement d'affirmer un
  changement que le rapport ne montre pas (un rapport coupé net produisait « c'est intégré, allez
  voir » pour du travail jamais fait).
- **La pause ne tue rien** : elle bloque les départs. Reprendre repart où on s'était arrêté, aucun
  jeton gaspillé à refaire ce qui était commencé.
- **Le carnet d'idées n'exécute rien** : mélanger « à garder » et « à faire » dans la même file
  rendait la file mensongère.

---

## 12. Ordre de portage suggéré

1. Tables + `broadcastAll` + auth.
2. `taskRunner.js` réduit au strict nécessaire : `enqueueAgentTask`, `kick`, `executeTask`,
   `runDetachedExecution`, `monitorExecution`, `finalize`, `getSettings/setSettings`,
   `presetFor`, `findAgentTask`, `updatePendingAgentTask`, `cancelPendingAgentTask`,
   `sendSteeringMessage`, `generateUserSummary`, `runToollessClaude`. Adapter les prompts (§10.3).
3. `promptQueue.js` tel quel (adapter le recap et `APP_URL`).
4. Routes + client `api.travaux.*`.
5. `Travaux.jsx` — onglet file d'abord ; suggestions et idées sont indépendants et optionnels.
6. Hook de steering (`agent-steer-hook.mjs` + `agent-steer-hooks.json` passés par `--settings`).
7. `promptTitle.js` (titres auto), puis `agentModel.js` (repli de modèle) — les deux sont des
   raffinements, la file tourne sans.

