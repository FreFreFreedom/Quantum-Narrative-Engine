# Panneau latéral « File de travaux » — code + style réutilisables

Extrait de l'ERP Orisha (React + Vite + Tailwind), 16 août 2026.

## Ce que c'est

Un **bouton discret dans l'en-tête de la barre de gauche** qui ouvre un **panneau
plein-hauteur ancré à droite** (420 px, voile gris sur le reste de l'écran). Le
panneau montre la file, permet d'y déposer un item, et porte en haut à droite un
lien **« Ouvrir la page → »** qui bascule vers la page complète et referme le
panneau. Raccourci global : **⌘/Ctrl + /**, `Échap` ferme.

Trois idées de conception, transposables à n'importe quelle liste :

1. **Le bouton vit dans le chrome, l'état vit au-dessus des routes.** Un
   `Provider` monté au-dessus du routeur détient `open` + les données ; le bouton
   n'est qu'un consommateur du contexte. La sidebar est remontée à chaque
   navigation — sans ce découpage, le panneau se refermerait en changeant de page.
2. **Pastille sur le bouton.** Violette = quelque chose attend une action de
   l'utilisateur ; grise = simple compte d'items vivants. Rien d'autre.
3. **Le panneau ne duplique pas la page.** Les briques d'affichage (pastille
   d'état, choix, zone de réponse, styles de champs) vivent dans un module
   partagé ; le panneau et la page pleine en sont deux consommateurs.

## Anatomie

| Fichier | Rôle |
|---|---|
| `components/TravauxQuickPanel.jsx` | Le provider, le bouton, le panneau |
| `lib/travauxQueue.jsx` | Briques partagées page ⇄ panneau (styles, pastille, hooks de lecture) |
| `lib/pageContext.jsx` | Optionnel : « cibler un élément à la souris » + contexte de page joint |
| `components/Layout.jsx` | Pose du bouton (3 emplacements : sidebar, rail replié, en-tête mobile) |
| `App.jsx` | `<TravauxQuickProvider>` au-dessus des routes |

## Le style, en clair

Palette **brand** (vert Orisha) utilisée par les classes `brand-*` :

```js
const brand = {
  50:'#EEFAF1', 100:'#D2F4DD', 200:'#A2E8B6', 300:'#6BD588', 400:'#43CC6E',
  500:'#2BC25C', 600:'#21B14B', 700:'#1B8E3C', 800:'#167030', 900:'#115825', 950:'#062F12',
}
```

Mesures et conventions qui font le « look » :

- **Panneau** : `fixed top-0 right-0 bottom-0 w-full sm:w-[420px] bg-white
  border-l border-slate-200 shadow-2xl flex flex-col`, z-index `9993` ; voile
  `fixed inset-0 z-[9992] bg-slate-900/10` (léger — on voit encore la page).
- **En-tête du panneau** : hauteur `h-14`, `px-3.5`, `border-b border-slate-100`
  — mêmes 56 px que l'en-tête de la sidebar, les deux barres s'alignent.
- **Corps** : `flex-1 overflow-y-auto p-3.5 space-y-4` (le panneau ne scrolle
  jamais en entier, seul son corps le fait).
- **Titres de section** : `text-[11px] uppercase tracking-wide font-semibold`,
  gris `slate-400` — violet `violet-700` pour la section qui réclame une action.
- **Cartes** : `rounded-lg`/`rounded-xl`, `border border-slate-200`, fond blanc ;
  une carte « qui attend » gagne `border-violet-300 ring-1 ring-violet-100`, une
  carte « en cours » `border-brand-300 ring-1 ring-brand-100`. C'est le seul
  vocabulaire de mise en avant : bordure + halo 1 px, jamais de fond saturé.
- **Vide** : `border border-dashed border-slate-200`, texte `text-slate-400`
  centré — jamais une zone blanche muette.
- **Boutons** : primaire `bg-brand-600 text-white hover:bg-brand-700
  rounded-lg px-3 py-1.5 text-sm font-medium` ; secondaire = même géométrie en
  `border-slate-200 text-slate-700 hover:bg-slate-50`.
- **Icônes** : lucide-react, 12–16 px selon la densité de la ligne.
- **Mode nuit** : aucune classe `dark:`. Les couleurs Tailwind sont branchées sur
  des variables CSS (`rgb(var(--c-brand-600) / <alpha-value>)`) dont la rampe est
  inversée en thème sombre. Écrire `text-slate-800` suffit.

## Pour le transplanter ailleurs

Ce qu'il faut remplacer : `api.travaux.*` (les 3 appels — lister, créer,
répondre), `useAuth`, `useToast`, et le `Link` de react-router. Tout le reste —
géométrie, contexte, raccourci clavier, pastille — est autonome.

---

# Code

## `components/TravauxQuickPanel.jsx`

```jsx
// Panneau rapide de la file de travaux — accessible depuis N'IMPORTE QUELLE page
// de l'ERP (bouton dans l'en-tête de la barre de gauche + raccourci ⌘/Ctrl + /).
//
// Il fait trois choses, sans quitter la page où on se trouve :
//   1. déposer un prompt dans la file, avec le contexte de la page pré-rempli
//      (route, fiche affichée, et au besoin un élément ciblé au clic — même
//      mécanisme que le FAB « Modifier le système », voir lib/pageContext.jsx) ;
//   2. montrer l'état de la file : ce qui tourne, ce qui attend et à quel rang ;
//   3. répondre à une question de Claude (« À répondre ») — un choix ou du texte
//      libre relance la tâche immédiatement.
//
// Rien n'est réimplémenté ici : la lecture temps réel de la file, la pastille
// d'état, les choix d'une question et la zone de réponse viennent de
// lib/travauxQueue.jsx, partagés avec la page /travaux.
import { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  ListOrdered, X, Plus, Loader2, HelpCircle, Crosshair, MousePointerClick,
  ArrowRight, AlertTriangle, PauseCircle,
} from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import {
  inputCls, btnPrimary,
  isAsking, firstLine, StatusPill, QuestionChoices, ReplyBox, PlacementToggle, useTravauxPrompts,
} from '../lib/travauxQueue.jsx'
import { useElementPicker, buildPageContext, currentRecordLabel, PickerBanner } from '../lib/pageContext.jsx'

// Le panneau dépose dans la file de l'Espace finance (/travaux) — la même que le
// FAB « Modifier le système », dont c'est désormais la seule destination.
const SPACE = 'finance'

const Ctx = createContext(null)

/** État partagé du panneau : le bouton déclencheur vit dans la barre de gauche. */
export function useTravauxQuick() { return useContext(Ctx) }

/**
 * Bouton d'ouverture, à poser dans le chrome de l'app (en-tête de la sidebar,
 * rail replié, en-tête mobile). Pastille violette = des questions attendent une
 * réponse ; sinon le nombre d'items vivants dans la file.
 */
export function TravauxQuickButton({ compact = false, className = '' }) {
  const ctx = useTravauxQuick()
  if (!ctx) return null
  const { open, setOpen, askingCount, activeCount } = ctx
  const badge = askingCount || activeCount
  return (
    <button
      type="button"
      data-testid="travaux-quick-button"
      data-asking={askingCount ? '1' : '0'}
      onClick={() => setOpen(o => !o)}
      title={askingCount
        ? `File de travaux — ${askingCount} question${askingCount > 1 ? 's' : ''} à répondre (⌘/Ctrl + /)`
        : 'File de travaux — ajouter un prompt, voir la file (⌘/Ctrl + /)'}
      aria-label="File de travaux"
      aria-expanded={open}
      className={`relative rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors
        ${compact ? 'p-2' : 'p-1.5'} ${open ? 'text-brand-700 bg-brand-50' : ''} ${className}`}
    >
      <ListOrdered size={compact ? 16 : 15} />
      {!!badge && (
        <span
          data-testid="travaux-quick-badge"
          className={`absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-semibold
            leading-[15px] text-white ring-2 ring-white ${askingCount ? 'bg-violet-600' : 'bg-slate-400'}`}
        >{badge > 9 ? '9+' : badge}</span>
      )}
    </button>
  )
}

/** Une ligne de file, repliée : rang, pastille d'état, titre. */
function QueueLine({ p, index }) {
  return (
    <div
      className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white"
      data-testid="travaux-quick-queue-item"
      data-prompt-id={p.id}
    >
      <span className="mt-0.5 w-5 shrink-0 text-center text-[11px] font-semibold text-slate-400 tabular-nums">{index}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-800 truncate">{p.title || firstLine(p.prompt, 60)}</div>
        <div className="mt-0.5"><StatusPill p={p} /></div>
      </div>
    </div>
  )
}

/** Carte « À répondre » : la question, ses choix, et une réponse libre. */
function AskingCard({ p, onReply }) {
  return (
    <div
      className="rounded-xl border border-violet-300 ring-1 ring-violet-100 bg-white p-2.5 space-y-2"
      data-testid="travaux-quick-asking"
      data-prompt-id={p.id}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusPill p={p} />
        <span className="flex-1 min-w-0 truncate text-sm font-medium text-slate-800">{p.title}</span>
      </div>
      {/* La question est rappelée ici : le panneau n'affiche pas le fil complet. */}
      <QuestionChoices p={p} onAnswer={opt => onReply(p.id, opt)} showQuestion />
      <ReplyBox onSend={(text, placement) => onReply(p.id, text, placement)} />
    </div>
  )
}

function QuickPanel({ onClose, data, load }) {
  const location = useLocation()
  const { addToast } = useToast()
  const toast = useMemo(() => ({
    error: m => addToast({ message: m, type: 'error' }),
    success: m => addToast({ message: m, type: 'success' }),
  }), [addToast])

  const [text, setText] = useState('')
  const [priority, setPriority] = useState(false)
  const [element, setElement] = useState('')
  const [record, setRecord] = useState('')
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  const inputRef = useRef(null)

  // Fiche affichée : lue à l'ouverture (et à chaque changement de page tant que le
  // panneau est ouvert) — c'est le titre que l'utilisateur a sous les yeux.
  useEffect(() => { setRecord(currentRecordLabel(location.pathname)) }, [location.pathname, location.search])
  useEffect(() => { inputRef.current?.focus() }, [])

  useElementPicker(picking, {
    onPick: (desc) => { setElement(desc); setPicking(false) },
    onCancel: () => setPicking(false),
  })

  const context = buildPageContext({
    pathname: location.pathname, search: location.search, element, record,
  })

  // Création : pas d'autosave possible (aucun id avant l'envoi) — voir CLAUDE.md.
  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      await api.travaux.createPrompt({
        // Le contexte suit dans le prompt : c'est lui que l'agent reçoit.
        prompt: `${trimmed}\n\nContexte (ERP) : ${context}`,
        space: SPACE,
        priority,
      })
      setText('')
      setElement('')
      setPriority(false)
      toast.success(priority ? 'Ajouté en tête de ta file' : 'Ajouté à ta file de travaux')
      load()
    } catch (e) { toast.error(e.message) }
    finally { setSending(false) }
  }

  // Répondre relance la tâche (voir page Travaux) : 'front' repart tout de suite,
  // 'back' la remet en fin de file.
  const reply = useCallback(async (id, replyText, placement = 'front') => {
    try {
      await api.travaux.replyToPrompt(id, replyText, placement)
      toast.success(data.queue_paused
        ? 'Réponse enregistrée — la file est en pause, la tâche repartira à la reprise'
        : placement === 'back'
          ? 'Réponse enregistrée — la tâche retourne en fin de file'
          : 'Réponse envoyée — la tâche repart')
      load()
    } catch (e) { toast.error(e.message); throw e }
  }, [data.queue_paused, load, toast])

  // Trois groupes, dans l'ordre où ils intéressent : ce qui attend une réponse, ce
  // qui tourne, puis la file numérotée (déjà remis à l'ordonnanceur d'abord).
  const { asking, running, queue, pausedCount } = useMemo(() => {
    const prompts = data.prompts || []
    const live = prompts.filter(p => p.status === 'running')
    return {
      asking: prompts.filter(isAsking),
      running: live.filter(p => p.run_state === 'executing'),
      queue: [
        ...live.filter(p => p.run_state !== 'executing'),
        ...prompts.filter(p => p.status === 'queued'),
      ],
      pausedCount: prompts.filter(p => p.status === 'paused').length,
    }
  }, [data.prompts])

  return (
    <>
      {picking && <PickerBanner
        onSkip={() => setPicking(false)}
        onCancel={() => setPicking(false)}
        skipLabel="Sans élément"
        testIdPrefix="travaux-quick"
      />}

      {/* Pendant le ciblage, le panneau s'efface : la page doit être cliquable. */}
      <div className={picking ? 'hidden' : undefined}>
        <div className="fixed inset-0 z-[9992] bg-slate-900/10" onClick={onClose} />
        {/* Pas de garde-frappe ici (contrairement aux cartes de la page /travaux) :
            tous les champs du panneau tiennent leur texte en état local, un
            rafraîchissement de la file ne peut pas l'écraser. */}
        <aside
          data-testid="travaux-quick-panel"
          className="fixed top-0 right-0 bottom-0 z-[9993] w-full sm:w-[420px] bg-white border-l border-slate-200
            shadow-2xl flex flex-col"
        >
          <div className="flex items-center gap-2 h-14 px-3.5 border-b border-slate-100 flex-shrink-0">
            <ListOrdered size={16} className="text-slate-500" />
            <div className="text-sm font-semibold text-slate-800">File de travaux</div>
            <Link
              to="/travaux"
              onClick={onClose}
              data-testid="travaux-quick-open-page"
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
            >Ouvrir la page <ArrowRight size={12} /></Link>
            <button
              onClick={onClose}
              data-testid="travaux-quick-close"
              aria-label="Fermer"
              title="Fermer (Échap)"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            ><X size={15} /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
            {/* ── Composer : le contexte de la page est déjà là ─────────────── */}
            <div>
              <textarea
                ref={inputRef}
                data-testid="travaux-quick-input"
                className={`${inputCls} w-full`}
                rows={3}
                placeholder="Décris la tâche — la page où tu es est jointe automatiquement…"
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
              />
              <div
                data-testid="travaux-quick-context"
                className="mt-1.5 rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-1.5 text-[11px] text-slate-500"
              >
                <div className="font-medium text-slate-600">Contexte joint</div>
                <div className="font-mono break-all">{location.pathname}{location.search}</div>
                {!!record && <div className="truncate" data-testid="travaux-quick-record">Fiche affichée : « {record} »</div>}
                {element ? (
                  <div className="mt-1 flex items-start gap-1.5" data-testid="travaux-quick-element">
                    <MousePointerClick size={12} className="text-brand-600 flex-shrink-0 mt-0.5" />
                    <span className="font-mono break-all line-clamp-2 flex-1">{element}</span>
                    <button
                      onClick={() => setElement('')}
                      data-testid="travaux-quick-element-remove"
                      aria-label="Retirer l'élément ciblé"
                      className="text-slate-400 hover:text-slate-600 flex-shrink-0"
                    ><X size={12} /></button>
                  </div>
                ) : (
                  <button
                    data-testid="travaux-quick-pick-element"
                    onClick={() => setPicking(true)}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:text-brand-700"
                  ><Crosshair size={12} /> Cibler un élément sur la page</button>
                )}
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <button className={btnPrimary} data-testid="travaux-quick-submit" onClick={submit} disabled={sending || !text.trim()}>
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Ajouter à la file
                </button>
                {/* Début ou fin de la file — même bouton que la page /travaux et
                    que le FAB (lib/travauxQueue.jsx). */}
                <PlacementToggle
                  testId="travaux-quick-priority"
                  value={priority ? 'first' : 'last'}
                  onChange={v => setPriority(v === 'first')}
                />
                <span className="text-xs text-slate-400 ml-auto">⌘/Ctrl + Entrée</span>
              </div>
              {!data.agent_enabled && (
                <p className="mt-1.5 text-xs text-amber-700 inline-flex items-center gap-1">
                  <AlertTriangle size={12} /> Agent désactivé — l'item attendra dans la file.
                </p>
              )}
              {data.queue_paused && (
                <p className="mt-1.5 text-xs text-amber-700 inline-flex items-center gap-1" data-testid="travaux-quick-paused">
                  <PauseCircle size={12} /> File en pause — aucune nouvelle tâche ne démarre.
                </p>
              )}
            </div>

            {/* ── À répondre : le seul état où rien n'avance sans nous ──────── */}
            {!!asking.length && (
              <section className="space-y-2">
                <h3 className="text-[11px] uppercase tracking-wide text-violet-700 font-semibold inline-flex items-center gap-1">
                  <HelpCircle size={12} /> À répondre · {asking.length}
                </h3>
                {asking.map(p => <AskingCard key={p.id} p={p} onReply={reply} />)}
              </section>
            )}

            {/* ── En cours ─────────────────────────────────────────────────── */}
            {!!running.length && (
              <section className="space-y-1.5" data-testid="travaux-quick-running">
                <h3 className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">En cours</h3>
                {running.map(p => (
                  <div key={p.id} className="rounded-lg border border-brand-300 ring-1 ring-brand-100 bg-white px-2.5 py-1.5" data-prompt-id={p.id}>
                    <div className="text-sm text-slate-800 truncate">{p.title || firstLine(p.prompt, 60)}</div>
                    <div className="mt-0.5"><StatusPill p={p} /></div>
                  </div>
                ))}
              </section>
            )}

            {/* ── La file, numérotée : la position, c'est l'ordre de départ ─── */}
            <section className="space-y-1.5">
              <h3 className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">
                En file · {queue.length}
              </h3>
              {queue.length
                ? queue.map((p, i) => <QueueLine key={p.id} p={p} index={i + 1} />)
                : (
                  <p className="text-xs text-slate-400 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center">
                    Rien en attente. Ajoute un prompt ci-dessus — il partira tout seul.
                  </p>
                )}
              {!!pausedCount && (
                <p className="text-xs text-slate-400 pt-0.5">
                  {pausedCount} item{pausedCount > 1 ? 's' : ''} de côté — sur la page Travaux.
                </p>
              )}
            </section>
          </div>
        </aside>
      </div>
    </>
  )
}

/**
 * Provider global : l'état du panneau, sa lecture de la file (temps réel) et le
 * raccourci clavier. Monté une seule fois au-dessus des routes (App.jsx) — la
 * sidebar, elle, est remontée à chaque navigation, l'état survit ainsi au
 * changement de page.
 */
export function TravauxQuickProvider({ children }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)

  // `active=1` : la file vivante seulement (la réponse complète embarque tout
  // l'historique et ses fils — trop lourde pour un panneau global). Sondage lent
  // seulement quand le panneau est ouvert ; sinon le temps réel suffit à la
  // pastille. Erreurs silencieuses : c'est une lecture de fond.
  const { data, load } = useTravauxPrompts({
    activeOnly: true,
    enabled: !!user,
    pollMs: open ? 20_000 : 0,
  })

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Échap ferme — sauf pendant le ciblage d'un élément, que le picker gère lui-même
  // (il arrête la propagation en phase capture).
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const askingCount = useMemo(() => (data.prompts || []).filter(isAsking).length, [data.prompts])
  const activeCount = useMemo(
    () => (data.prompts || []).filter(p => ['running', 'queued'].includes(p.status) && !isAsking(p)).length,
    [data.prompts])

  const value = useMemo(() => ({ open, setOpen, askingCount, activeCount }), [open, askingCount, activeCount])

  return (
    <Ctx.Provider value={value}>
      {children}
      {user && open && (
        <QuickPanel onClose={() => setOpen(false)} data={data} load={load} />
      )}
    </Ctx.Provider>
  )
}
```

## `lib/travauxQueue.jsx`

```jsx
// Briques communes de la file de prompts (/travaux) : lecture temps réel de la
// file, pastille d'état, choix d'une question de Claude, zone de réponse.
//
// Deux consommateurs, une seule logique : la page Travaux (liste complète, ordre,
// réglages) et le panneau rapide accessible depuis n'importe quelle page
// (TravauxQuickPanel). Tout ce qui est ici doit rester utilisable sans la page.
import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, HelpCircle, Send, ChevronsDown, ChevronsUp } from 'lucide-react'
import api from './api.js'

export const inputCls = 'px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
export const btnCls = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50'
export const btnPrimary = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50'

export const STATUS_STYLES = {
  asking: 'bg-violet-50 text-violet-700',
  running: 'bg-brand-50 text-brand-700',
  // « waiting » (remis à l'ordonnanceur, pas démarré) s'affiche comme n'importe
  // quel item en file : « En attente » disait la même chose que le rang, en
  // moins clair. La distinction reste dans le tooltip, pas dans la pastille.
  waiting: 'bg-slate-100 text-slate-600',
  queued: 'bg-slate-100 text-slate-600',
  paused: 'bg-amber-50 text-amber-700',
  done: 'bg-emerald-50 text-emerald-700',
  blocked: 'bg-rose-50 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-500',
}
export const STATUS_LABELS = {
  asking: 'À répondre',
  running: 'En cours', waiting: 'En file', queued: 'En file', paused: 'De côté',
  done: 'Terminé', blocked: 'Bloqué', cancelled: 'Annulé',
}

/** L'agent attend une réponse : rien n'avancera sans un clic de l'utilisateur. */
export function isAsking(p) {
  return !!p.pending_question?.question && ['done', 'blocked'].includes(p.status)
}

/**
 * Un item remis à l'agent n'est pas forcément en train de tourner : une seule
 * implémentation avance à la fois. `run_state` (serveur) tranche entre les deux —
 * sans lui, deux réponses envoyées coup sur coup affichaient deux « En cours ».
 */
export function pillStateOf(p) {
  if (p.status === 'running') return p.run_state === 'executing' ? 'running' : 'waiting'
  // « Terminé » serait faux : la tâche a rendu la main faute d'une décision qui
  // n'appartenait qu'à l'utilisateur, et reprendra dès qu'il aura répondu.
  if (isAsking(p)) return 'asking'
  return p.status
}

export function ordinal(n) { return n === 1 ? '1er' : `${n}e` }

/** Première ligne utile d'un texte, pour les aperçus repliés. */
export function firstLine(text, max = 170) {
  const t = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Date courte et lisible d'un item terminé (« 4 août, 14:07 »). */
export function shortDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function StatusPill({ p }) {
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
      {state === 'asking' && <HelpCircle size={11} className="inline mr-1" />}
      {STATUS_LABELS[state] || state}{suffix}
    </span>
  )
}

/**
 * Question de Claude : les choix proposés. Le texte de la question vit dans le fil
 * (dernier message) sur la page Travaux ; le panneau rapide, lui, n'affiche pas le
 * fil — d'où `showQuestion`, qui rappelle la question au-dessus des choix.
 * Un clic répond ET relance la tâche.
 */
export function QuestionChoices({ p, onAnswer, showQuestion = false }) {
  const [answering, setAnswering] = useState(false)
  const options = p.pending_question?.options || []
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2.5" data-testid="travaux-question">
      <div className="text-xs font-medium text-violet-800 inline-flex items-center gap-1.5">
        <HelpCircle size={13} /> Claude attend ta réponse pour continuer
      </div>
      {showQuestion && (
        <p className="mt-1.5 text-sm text-violet-900 whitespace-pre-wrap">{p.pending_question.question}</p>
      )}
      {!!options.length && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {options.map((opt, i) => (
            <button
              key={i}
              className="px-2.5 py-1 text-sm rounded-lg bg-white border border-violet-300 text-violet-900 hover:bg-violet-100 disabled:opacity-50 text-left"
              data-testid="travaux-question-option"
              disabled={answering}
              onClick={async () => { setAnswering(true); try { await onAnswer(opt) } finally { setAnswering(false) } }}
            >{opt}</button>
          ))}
        </div>
      )}
      <p className="text-xs text-violet-700/70 mt-2">
        Un choix relance le travail avec ta réponse. Tu peux aussi répondre librement ci-dessous.
      </p>
    </div>
  )
}

/**
 * Zone de réponse d'un fil. Boutons assumés (pas d'autosave) : envoyer RELANCE
 * l'exécution de la tâche — action à effet réel, elle ne doit pas partir d'un blur.
 * Deux départs possibles : au DÉBUT de la file (la tâche repart tout de suite,
 * avant le reste) ou à la FIN (la réponse est enregistrée, la tâche reprendra
 * quand son tour reviendra).
 */
export function ReplyBox({ onSend, autoFocus, rows = 2 }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(null)   // 'front' | 'back' | null
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  const send = async (placement) => {
    if (!text.trim() || sending) return
    setSending(placement)
    try {
      await onSend(text.trim(), placement)
      setText('')
    } finally { setSending(null) }
  }
  return (
    <div>
      <textarea
        ref={ref}
        data-testid="travaux-reply-input"
        className={`${inputCls} w-full`}
        rows={rows}
        placeholder="Répondre à Claude — ta réponse relance la tâche…"
        value={text}
        onChange={e => setText(e.target.value)}
        // Cmd/Ctrl+Entrée envoie (au début de la file) : Entrée seule sert aux retours à la ligne.
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send('front') }}
      />
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <button
          className={btnPrimary} data-testid="travaux-reply-front"
          onClick={() => send('front')} disabled={!!sending || !text.trim()}
          title="La tâche repart tout de suite, avant le reste de la file"
        >
          {sending === 'front' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Relancer au début de la file
        </button>
        <button
          className={btnCls} data-testid="travaux-reply-back"
          onClick={() => send('back')} disabled={!!sending || !text.trim()}
          title="La réponse est enregistrée et la tâche retourne en fin de file — elle reprendra quand son tour reviendra"
        >
          {sending === 'back' ? <Loader2 size={14} className="animate-spin" /> : <ChevronsDown size={14} />} À la fin de la file
        </button>
        <span className="text-xs text-slate-400">⌘/Ctrl + Entrée</span>
      </div>
    </div>
  )
}

/**
 * Où la tâche qu'on est en train d'écrire ira se déposer : au début ou à la fin
 * de la file. Bouton discret (une bascule, pas deux contrôles) posé à côté du
 * bouton d'envoi.
 *
 * Un seul composant pour les TROIS endroits d'où l'on dépose une tâche — page
 * /travaux, panneau rapide, FAB « Modifier le système » — donc le même geste et
 * le même vocabulaire partout dans l'app. Le bouton dit l'état courant (« à la
 * fin de la file ») ; cliquer le bascule, il n'y a rien d'autre à comprendre.
 *
 * Défaut : la fin de file — c'est le comportement historique, et le seul qui
 * respecte l'ordre déjà décidé pour le reste de la file.
 */
export function PlacementToggle({ value, onChange, testId = 'travaux-placement', className = '' }) {
  const first = value === 'first'
  return (
    <button
      type="button"
      data-testid={testId}
      data-placement={first ? 'first' : 'last'}
      aria-pressed={first}
      onClick={() => onChange(first ? 'last' : 'first')}
      title={first
        ? 'Se dépose au début de la file — cliquer pour la mettre plutôt à la fin'
        : 'Se dépose à la fin de la file — cliquer pour la passer au début'}
      className={`inline-flex items-center gap-1 text-xs font-medium transition-colors ${
        first ? 'text-brand-600 hover:text-brand-700' : 'text-slate-400 hover:text-slate-600'
      } ${className}`}
    >
      {first ? <ChevronsUp size={12} /> : <ChevronsDown size={12} />}
      {first ? 'Au début de la file' : 'À la fin de la file'}
    </button>
  )
}

/** Voie d'exécution d'un item — même règle que le serveur (`laneOf`). */
function laneOf(p) { return p.lane || ((p.mode === 'question' && !p.same_context) ? 'question' : 'exec') }

/**
 * « Passer en premier », joué localement — exactement ce que le serveur va faire :
 * l'item repasse en file (un item de côté y revient), les items de SA voie déjà
 * remis à l'ordonnanceur mais pas démarrés lui sont repris, et il se place en tête.
 * Les rangs d'attente de la voie glissent d'un cran, sinon deux cartes afficheraient
 * « 1er » le temps de l'aller-retour.
 */
function liftToFront(prompts, id) {
  const target = prompts.find(p => p.id === id)
  if (!target || !['queued', 'paused'].includes(target.status)) return prompts
  const lane = laneOf(target)
  const from = target.wait_rank || Infinity
  const rest = prompts.filter(p => p.id !== id).map(p => {
    if (laneOf(p) !== lane) return p
    // Remis à l'ordonnanceur mais pas démarré : le serveur le lui reprend pour que
    // « premier » ne mente pas — l'écran doit le dire aussi (une exécution
    // réellement en cours, elle, n'est jamais touchée).
    const reclaimed = p.status === 'running' && p.run_state !== 'executing' && p.space === target.space
    const rank = p.wait_rank && p.wait_rank < from ? p.wait_rank + 1 : p.wait_rank
    if (!reclaimed && rank === p.wait_rank) return p
    return { ...p, wait_rank: rank, ...(reclaimed ? { status: 'queued', run_state: null } : null) }
  })
  return [{ ...target, status: 'queued', wait_rank: 1 }, ...rest]
}

const EMPTY_QUEUE = {
  prompts: [], agent_enabled: true, runner_busy: false, running_questions: 0, max_parallel_questions: 2,
  queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
}

/**
 * Lecture temps réel de la file de prompts.
 *
 * - `activeOnly` : ne demande que les items vivants (en cours, en file, de côté,
 *   en attente de réponse) — la réponse complète embarque tout l'historique et ses
 *   fils, trop lourde pour un panneau ouvert depuis n'importe quelle page.
 * - `pollMs` : filet lent (l'exécution en cours n'émet pas d'événement à chaque
 *   étape) ; 0 le désactive.
 * - Rafraîchir pendant que l'utilisateur écrit re-rend la liste sous ses doigts :
 *   on note qu'un rafraîchissement est dû (`flushStale`) et on le passe quand le
 *   champ perd le focus.
 */
export function useTravauxPrompts({ activeOnly = false, pollMs = 20_000, enabled = true, onError } = {}) {
  const [data, setData] = useState(EMPTY_QUEUE)
  const [loading, setLoading] = useState(true)

  const errRef = useRef(onError)
  errRef.current = onError

  // Plusieurs chargements peuvent être en vol en même temps (temps réel + sondage +
  // rechargement après une action). Sans numéro d'ordre, une réponse partie AVANT un
  // réordonnancement pouvait arriver APRÈS et remettre la liste dans l'ordre d'avant.
  const seq = useRef(0)

  // Suppression : la carte doit partir AU CLIC et ne jamais revenir. Le serveur, lui,
  // supprime tout de suite ; ce qui la ramenait, c'est une réponse de liste PARTIE
  // avant la suppression et arrivée après (sondage, temps réel) — la ligne
  // réapparaissait alors telle quelle. D'où cette pierre tombale locale : les ids
  // retirés sont filtrés de TOUTE réponse, pas seulement de l'état courant.
  const dropped = useRef(new Set())

  // « Passer en premier » : même problème, même remède. Le serveur tranche en
  // quelques dizaines de ms, mais la liste complète (une centaine de Ko : tout
  // l'historique et ses fils) met le reste de la seconde à revenir et à se
  // re-rendre — la carte ne bougeait pas d'ici là. Le mouvement est donc appliqué
  // AU CLIC, et ré-appliqué à toute réponse tant qu'il n'est pas confirmé : une
  // liste partie avant le clic et arrivée après ferait sinon redescendre la carte.
  const lifted = useRef(new Set())

  const strip = useCallback(d => {
    const before = d.prompts || []
    let prompts = before
    if (dropped.current.size) prompts = prompts.filter(p => !dropped.current.has(p.id))
    for (const id of lifted.current) prompts = liftToFront(prompts, id)
    return prompts === before ? d : { ...d, prompts }
  }, [])

  const load = useCallback(async () => {
    if (!enabled) return
    const mine = ++seq.current
    try {
      const fresh = await api.travaux.listPrompts(activeOnly ? { active: 1 } : {})
      if (mine === seq.current) setData(strip(fresh))
    }
    catch (e) { errRef.current?.(e) }
    finally { setLoading(false) }
  }, [enabled, activeOnly, strip])

  /** Retire une ligne sur-le-champ, avant même la réponse du serveur. */
  const dropPrompt = useCallback(id => {
    dropped.current.add(id)
    setData(d => strip(d))
  }, [strip])
  /** La suppression a échoué : la ligne a le droit de revenir au prochain chargement. */
  const undropPrompt = useCallback(id => { dropped.current.delete(id) }, [])

  /** Remonte une ligne en tête de file sur-le-champ, avant la réponse du serveur. */
  const liftPrompt = useCallback(id => {
    lifted.current.add(id)
    setData(d => strip(d))
  }, [strip])
  /** Le serveur a rendu son verdict (ou a refusé) : la liste reprend la main. */
  const unliftPrompt = useCallback(id => { lifted.current.delete(id) }, [])

  const stale = useRef(false)
  const softLoad = useCallback(() => {
    const el = document.activeElement
    const typing = !!(el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.closest('[data-prompt-id], [data-travaux-composer]'))
    if (typing) { stale.current = true; return }
    load()
  }, [load])
  const flushStale = useCallback(() => {
    if (!stale.current) return
    stale.current = false
    load()
  }, [load])

  useEffect(() => { if (enabled) load() }, [enabled, load])
  useEffect(() => {
    if (!enabled) return undefined
    const onEvt = () => softLoad()
    // Le passage « en attente → en cours » se joue côté ordonnanceur : il n'émet pas
    // d'événement de file, seulement une mise à jour de tâche. Sans cette écoute, la
    // carte resterait « En attente » jusqu'au rafraîchissement lent.
    const onTask = (e) => { if (e.detail?.kind === 'queue') softLoad() }
    window.addEventListener('travaux:prompts:updated', onEvt)
    window.addEventListener('agent:task:updated', onTask)
    const t = pollMs ? setInterval(softLoad, pollMs) : null
    return () => {
      window.removeEventListener('travaux:prompts:updated', onEvt)
      window.removeEventListener('agent:task:updated', onTask)
      if (t) clearInterval(t)
    }
  }, [enabled, softLoad, pollMs])

  return { data, setData, loading, load, softLoad, flushStale, dropPrompt, undropPrompt, liftPrompt, unliftPrompt }
}
```

## `lib/pageContext.jsx`

```jsx
// Contexte de page joint aux demandes envoyées à l'agent — mécanisme UNIQUE,
// partagé par le FAB « Modifier le système » (FeedbackFab) et le panneau rapide
// de la file de travaux (TravauxQuickPanel).
//
// Trois briques :
//   1. `describeElement` — description compacte d'un élément DOM (ancres
//      exploitables : data-testid, id, aria…) pour que l'agent le retrouve dans
//      le code sans que l'utilisateur ait à le décrire.
//   2. `useElementPicker` — le mode « cliquer sur un élément » (bandeau appelant,
//      surbrillance au survol, clics de la page neutralisés).
//   3. `currentRecordLabel` / `buildPageContext` — la ligne de contexte finale :
//      route courante, fiche affichée, élément ciblé.
import { useEffect, useRef } from 'react'
import { MousePointerClick, X } from 'lucide-react'

/**
 * Description compacte de l'élément DOM cliqué, jointe en contexte de la demande.
 * Priorise les ancres exploitables (data-testid, id, aria).
 */
export function describeElement(el) {
  if (!(el instanceof Element)) return ''
  const attrs = []
  for (const name of ['data-testid', 'id', 'aria-label', 'placeholder', 'title', 'name']) {
    const v = el.getAttribute(name)
    if (v) attrs.push(`${name}="${v}"`)
  }
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
  if (cls) attrs.push(`class="${cls}"`)
  let desc = `<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (text) desc += ` « ${text} »`
  // Ancre ancêtre identifiable la plus proche (repère supplémentaire dans le code).
  for (let anc = el.parentElement; anc && anc !== document.body; anc = anc.parentElement) {
    const tid = anc.getAttribute('data-testid')
    if (tid || anc.id) {
      desc += ` — dans <${anc.tagName.toLowerCase()} ${tid ? `data-testid="${tid}"` : `id="${anc.id}"`}>`
      break
    }
  }
  return desc.slice(0, 400)
}

/**
 * Libellé du record affiché quand la page est une fiche détail (`/factures/123`,
 * `/companies/42`…) : le titre `h1` de la page, c'est-à-dire ce que l'utilisateur
 * lit à l'écran. Une page de liste (`/orders`) n'a pas de record affiché — son
 * titre est le nom de la section, la route le dit déjà.
 */
export function currentRecordLabel(pathname = '') {
  if (typeof document === 'undefined') return ''
  const segments = String(pathname).split('/').filter(Boolean)
  if (segments.length < 2) return ''
  const h1 = document.querySelector('main h1') || document.querySelector('h1')
  const text = (h1?.innerText || '').trim().replace(/\s+/g, ' ')
  return text.slice(0, 120)
}

/**
 * Ligne de contexte jointe à la demande. Sans `record` ni `element`, c'est la
 * simple route courante — le format historique du FAB, que la page Agent affiche
 * telle quelle en pastille.
 */
export function buildPageContext({ pathname = '', search = '', element = '', record = '', appWide = false } = {}) {
  const page = `${pathname}${search || ''}`
  return (appWide
    ? `Demande concernant l'ensemble de l'application (pas seulement la page ${page})`
    : page)
    + (record ? ` — fiche affichée : « ${record} »` : '')
    + (element ? ` — élément ciblé par l'utilisateur : ${element}` : '')
}

/**
 * Bandeau flottant de l'étape « cliquer sur un élément ». Il porte
 * `data-feedback-picker` : ses propres boutons restent cliquables pendant que le
 * reste de la page est neutralisé.
 */
export function PickerBanner({ onSkip, onCancel, skipLabel = 'Demande générale', testIdPrefix = 'feedback' }) {
  return (
    <div
      data-feedback-picker
      data-testid={`${testIdPrefix}-pick-banner`}
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[9991] flex items-center gap-3 bg-slate-900 text-white
        rounded-xl shadow-2xl pl-4 pr-2 py-2 text-sm max-w-[calc(100vw-2rem)]"
    >
      <MousePointerClick size={16} className="text-brand-400 flex-shrink-0" />
      <span className="whitespace-nowrap truncate">
        Cliquez sur l'élément concerné par votre demande
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          data-testid={`${testIdPrefix}-skip-pick`}
          onClick={onSkip}
          className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium transition-colors"
        >
          {skipLabel}
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-cancel-pick`}
          onClick={onCancel}
          aria-label="Annuler"
          title="Annuler (Échap)"
          className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * Mode « picking » : capture des événements au niveau document (phase capture)
 * pour intercepter le clic AVANT les handlers de la page (aucune navigation /
 * action ne doit se déclencher). Surbrillance de l'élément survolé via un overlay
 * non interactif repositionné au survol et au scroll.
 *
 * Les éléments portant `data-feedback-picker` (bandeau, FAB, panneau appelant)
 * gardent leur comportement normal — ce sont les commandes du picking lui-même.
 *
 * `onPick(description)` : un élément a été choisi. `onCancel()` : Échap.
 */
export function useElementPicker(picking, { onPick, onCancel } = {}) {
  // Les callbacks passent par une ref : l'effet ne doit dépendre que de `picking`,
  // sinon il se remonte à chaque render de l'appelant (surbrillance qui saute).
  const cb = useRef({ onPick, onCancel })
  cb.current = { onPick, onCancel }

  useEffect(() => {
    if (!picking) return
    const hl = document.createElement('div')
    hl.style.cssText = 'position:fixed;z-index:9990;pointer-events:none;display:none;' +
      'border:2px solid #21B14B;background:rgba(33,177,75,0.10);border-radius:4px;transition:all 60ms ease-out'
    document.body.appendChild(hl)
    const style = document.createElement('style')
    style.textContent = 'body.__feedback-picking *{cursor:crosshair!important}' +
      '[data-feedback-picker], [data-feedback-picker] *{cursor:default!important}' +
      '[data-feedback-picker] button{cursor:pointer!important}'
    document.head.appendChild(style)
    document.body.classList.add('__feedback-picking')

    let hoverEl = null
    const inPicker = t => t instanceof Element && t.closest('[data-feedback-picker]')
    function position(t) {
      const r = t.getBoundingClientRect()
      hl.style.display = 'block'
      hl.style.left = `${r.left - 2}px`
      hl.style.top = `${r.top - 2}px`
      hl.style.width = `${r.width}px`
      hl.style.height = `${r.height}px`
    }
    function onMove(e) {
      const t = e.target
      if (!(t instanceof Element) || inPicker(t) || t === document.body || t === document.documentElement) {
        hoverEl = null
        hl.style.display = 'none'
        return
      }
      hoverEl = t
      position(t)
    }
    function onScroll() { if (hoverEl) position(hoverEl) }
    function onDown(e) {
      if (inPicker(e.target)) return
      e.preventDefault()
      e.stopPropagation()
    }
    function onClick(e) {
      if (inPicker(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      const target = hoverEl || (e.target instanceof Element ? e.target : null)
      cb.current.onPick?.(describeElement(target))
    }
    function onKey(e) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      cb.current.onCancel?.()
    }
    document.addEventListener('mouseover', onMove, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mouseover', onMove, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey, true)
      hl.remove()
      style.remove()
      document.body.classList.remove('__feedback-picking')
    }
  }, [picking])
}
```

## Branchement

```jsx
// App.jsx — une seule fois, AU-DESSUS des routes
import { TravauxQuickProvider } from './components/TravauxQuickPanel.jsx'

<TravauxQuickProvider>
  <Routes>…</Routes>
</TravauxQuickProvider>
```

```jsx
// Layout.jsx — le bouton, dans l'en-tête de la barre de gauche
import { TravauxQuickButton } from './TravauxQuickPanel.jsx'

<div className="flex items-center h-14 px-3 border-b border-slate-100 flex-shrink-0 gap-2">
  <NavLink to="/dashboard" className="flex items-center gap-2 min-w-0">
    <img src="/erp/favicon.png" alt="Orisha ERP" className="h-7 w-auto" />
    <span className="text-[15px] font-semibold text-slate-800 tracking-tight">Orisha</span>
  </NavLink>
  {/* File de travaux : joignable depuis n'importe quelle page (⌘/Ctrl + /). */}
  <TravauxQuickButton className="ml-auto" />
</div>

{/* Rail replié et en-tête mobile : même bouton, variante dense */}
<TravauxQuickButton compact />
```

## Le lien « Ouvrir la page » (le cœur de la demande)

```jsx
<Link
  to="/travaux"
  onClick={onClose}                 // le panneau se referme : on va voir plus grand
  data-testid="travaux-quick-open-page"
  className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
>Ouvrir la page <ArrowRight size={12} /></Link>
```

`ml-auto` le pousse à droite du titre, le bouton de fermeture reste le dernier
élément de la barre. Discret (`text-xs`), coloré brand : c'est une sortie, pas
l'action principale du panneau.
