# Gaze-layer coverage test — findings

**Status:** DONE 2026-08-26
**Type:** Investigation report. No code changed, no schema touched, no pipeline built.

Companion to [`gaze-layer-coverage-test.md`](gaze-layer-coverage-test.md) (the plan this executes).

---

## Why this exists, in one paragraph

The two prior investigations proved dialogue-only reading works for the **relational** skeleton of a
film (script-coverage: subtitles cover 100% of the corpus; calibration: a free model rebuilt the
real patterns from subtitles alone). But that pass missed the expert's sharpest concept for this kind
of film — the **"pornography of negation"**: suffering staged as spectacle, the camera *lingering on a
wound*, the viewer made into an audience to a character's own refusal. That lives in the **image** —
what the camera does, what it holds on — not in spoken words. Subtitles are blind to it. So this task
asks one question: **is there a free, legitimate TEXT source that describes what the camera does, across
this corpus?** Nothing here is built. We only checked whether such sources exist and how far they reach.

## The candidate sources, in the order the plan ranked them

1. **Audio description (AD)** tracks — the narration written for blind viewers ("he presses the blade
   against his palm, calm, ritualistic"). Closest match to the gaze layer. The plan's first hope.
2. **Screenplay action lines** — the non-dialogue stage directions. Already known to cover ~40% of the
   corpus and skew English; this pass checks specifically for *visual staging*, not just "a script exists."
3. **Long-form critical essays / close readings** — Criterion, BFI, Senses of Cinema, academic. Free,
   and often written *precisely* about the camera.
4. **Detailed shot-level synopses / recaps** — richer than a one-paragraph plot summary.

---

## Sample: 15 films, deliberately over-weighted to the hard half

The real corpus (`queue-server/data-seed/fmcns_ontology.json`, `filmsIndex`, 199 films) is ~13%
non-English. Following the script-coverage sample's logic, this sample is **73% non-English (11 of 15)**
— inverted on purpose, so the result reports on the hard arthouse/foreign half, not the easy 87%. Every
film was also chosen because it is the *kind* where the gaze layer matters: body, wound, gesture,
held-silence films (Piano Teacher, Realm of Senses, Blue, Wetlands, Handmaiden, Antichrist) and
arthouse slow films where composition *is* the meaning (Winter Light, Dersu Uzala, Portrait, Girl with
the Needle, Death of Lazarescu, A Separation, The Piano).

| # | Film | Cluster | Language | Why in sample |
|---|---|---|---|---|
| 1 | The Piano Teacher | I | French | Self-harm held in shot; Haneke's static camera |
| 2 | In the Realm of the Senses | II | Japanese | Body as spectacle; Oshima's camera discipline |
| 3 | Blue Is the Warmest Color | II | French | Body/gaze; Kechiche long takes |
| 4 | Portrait of a Lady on Fire | X | French | Entire film *about* the gaze |
| 5 | A Separation | III | Persian | Essay-rich; translated screenplay exists |
| 6 | Winter Light | I | Swedish | Bergman/Criterion; camera "lingers" |
| 7 | The Death of Mr. Lazarescu | IV | Romanian | Long-take realism; handheld on dying body |
| 8 | Dersu Uzala | V | Russian | Kurosawa/Criterion; eye-level landscape |
| 9 | The Handmaiden | II | Korean | Labyrinth of gazes; Park |
| 10 | The Girl with the Needle | IV | Danish | 2024; B&W; camera "comes to linger" |
| 11 | Wetlands | II | German | Extreme close-ups on the body |
| 12 | Taxi Driver | I | English (control) | Mainstream; AD likely on streaming |
| 13 | First Reformed | I | English (control) | Calibration film; screenplay action lines |
| 14 | Antichrist | I | English/Danish | Genital self-mutilation in close-up |
| 15 | The Piano | X | English (control) | Campion; touch as spectacle |

---

## Per-film results

**Method.** Web searches + direct page fetches only. No source text was downloaded or stored — only
confirmed a listing/source exists and quoted the handful of lines used in the taste test. AD was checked
by searching each film + "audio description / audio described / transcript." Screenplay action lines were
checked against IMSDb / Script Slug / published-screenplay hosts / fan transcripts. Essays were checked
against Criterion, BFI, Senses of Cinema, academic PDFs, and major critics. Synopses against Wikipedia
and critic recaps.

**Legend.** AD = audio-description free text. SPL = screenplay action lines. ESS = essay/close reading.
SYN = shot-level synopsis. Status: **Found** / **Not found (free)** / **Could-not-check**.

| Film | AD (free text) | SPL action lines | ESS essay/close reading | SYN synopsis |
|---|---|---|---|---|
| The Piano Teacher | Not found (free) | Not found (free, this pass)¹ | **Found** (Senses of Cinema ×2, Bright Lights, Artforum, USF thesis) | **Found** (Wikipedia + critic recaps) |
| In the Realm of the Senses | Not found (free) | Not found (free, this pass) | **Found** (Criterion: Richie + Oshima essays) | **Found** (Wikipedia) |
| Blue Is the Warmest Color | Not found (free) | Not found (free, this pass) | **Found** (Wikipedia visual-symbolism + criticism) | **Found** (Wikipedia) |
| Portrait of a Lady on Fire | Not found (free) | **Found** (Plain Archive edition published; fan EN translation w/ camera-direction shorthand)² | **Found** (Criterion, Indiewire, Red, Swarthmore) | **Found** (Wikipedia + fan transcript w/ stage dirs) |
| A Separation | Not found (free) | **Found** (Script Slug, translated shooting script) | **Found** (Wikipedia + academic) | **Found** (Wikipedia) |
| Winter Light | Not found (free) | Not found (free, this pass)³ | **Found** (photogénie, Senses of Cinema, Reverse Shot, samkris) | **Found** (Wikipedia) |
| The Death of Mr. Lazarescu | Not found (free) | Not found (free, this pass) | **Found** (Senses of Cinema, academic PDFs on camera/mise-en-scène) | **Found** (Wikipedia) |
| Dersu Uzala | Not found (free) | Not found (free, this pass) | **Found** (Criterion essay, Richie — describes camera) | **Found** (Wikipedia) |
| The Handmaiden | Not found (free) | Not found (free, this pass) | **Found** (academic "Acoustic Mirror" essay, The Big Picture) | **Found** (Wikipedia) |
| The Girl with the Needle | Not found (free) | Not found (free, this pass) | **Found** (Variety Camerimage, reviews describe camera) | **Found** (Wikipedia + Variety recap) |
| Wetlands | Not found (free) | Not found (free, this pass) | **Found** (Film Comment, Roger Ebert, Indiewire) | **Found** (Wikipedia + Ebert recap) |
| Taxi Driver | Not found (free)⁴ | **Found** (IMSDb — "CAMERA begins to CLOSE IN on one taxi") | **Found** (StudioBinder camera analysis + criticism) | **Found** (Wikipedia) |
| First Reformed | Not found (free) | **Found** (screenplay PDF — "revealed in degrees of shadow") | **Found** (script-analysis + criticism) | **Found** (Wikipedia) |
| Antichrist | Not found (free) | **Found** (script PDF — "SCENE 1, INT. APARTMENT") | **Found** (academic essays on body/sound) | **Found** (Wikipedia) |
| The Piano | Not found (free) | **Found** (Campion's published, Oscar-winning script; widely hosted) | **Found** (Criterion, Senses of Cinema, Cineaste) | **Found** (Wikipedia) |

¹ Haneke's screenplay is published in print; no free hosted copy with action lines was fetched this
pass. Treated as not-found-free rather than confirmed-absent.
² The translator's note explicitly says the published script "includes camera directions that may be her
personal shorthand cues to convey the visual or emotional gist of the scene" — i.e. it carries staging
description, not just dialogue.
³ Bergman's screenplays are published (Norstedts 34-volume edition; Reverse Shot cites "the published
screenplays of Ingmar Bergman's 'religious trilogy'"). No free hosted copy with action lines fetched this
pass.
⁴ A BBC iPlayer "Audio Described" version of *Taxi Driver* exists (accessibility track on a
geo-restricted, account-required streaming service). The AD **text** is not freely downloadable. This is
the only film where an AD *track* was confirmed to exist at all; for the other 14, even track existence
on streaming was **could-not-check** (I did not hold BBC/Netflix/etc. accounts to verify).

---

## Per-source coverage across the sample

| Source | Found | Coverage | Language split |
|---|---|---|---|
| **AD (free text)** | 0 / 15 | **0%** | N/A — no free text found for any film, English or not |
| **Screenplay action lines** | 6 / 15 | **40%** | English: 4/4 (100%) · Non-English: 2/11 (18%) |
| **Essay / close reading** | 15 / 15 | **100%** (depth uneven) | Strongest for Criterion/arthouse; covers both languages |
| **Shot-level synopsis** | 15 / 15 | **100%** as plot summary; ~5/15 genuinely shot-level | Even |

### Reading the numbers

- **AD is a dead end as a free text source.** Not one of the 15 films has a freely downloadable AD
  transcript/script. The only AD *track* I could confirm at all is *Taxi Driver* on BBC iPlayer, behind a
  UK account/geo wall — its text is not retrievable without the audio. There is no free AD-text repository
  comparable to the subtitle sites that made the script-coverage test 100%. **This is the plan's headline
  question, and the answer is no.**
- **Screenplay action lines behave exactly like the prior script-coverage finding:** an English-language
  phenomenon. 100% of the English controls had a free screenplay with real staging description; only 2 of
  11 non-English films did (A Separation via a translated shooting script; Portrait via a *published*
  Plain Archive edition — both exceptions, not the rule). When present, the action lines do carry the gaze
  layer ("revealed in degrees of shadow"; "CAMERA begins to CLOSE IN"). But coverage caps near 40% and is
  structurally English.
- **Essays are the one source that actually reaches the gaze layer for free, and reaches the non-English
  half.** Every sampled film has at least Wikipedia-level material, and the arthouse/Criterion titles have
  rich close readings written *about the camera*: Portrait's gaze analysis, Piano Teacher's static long
  take on the wound, Realm of Senses' "camera on a tripod, restrained, above the actors," Winter Light's
  "camera lingers" criticism, Dersu Uzala's eye-level compositions. Coverage is high but **not guaranteed
  and not uniform** — an obscure title may have only a thin Wikipedia note, and gaze-density varies by
  writer. This is a usable source, not a systematic one.
- **Shot-level synopses** exist for all (Wikipedia) but are mostly plot summaries; only a subset (Girl
  with the Needle's Variety recap, Wetlands' Ebert recap, Piano Teacher) describe blocking/visual beats
  enough to count as "shot-level." Useful as a supplement, not a primary gaze source.

---

## Recommendation

**Is there a free way to reach the gaze layer? Yes — but not via audio description, and not via
screenplays alone.**

- **Primary free source: long-form critical essays / close readings**, with screenplay action lines as a
  bonus where they exist. AD should be dropped from consideration: it is not freely retrievable as text for
  this corpus, and building a pipeline that depends on scraping streaming AD tracks would mean paid/geo-
  restricted access plus transcription work — outside "free source" by definition.
- **The language split persists for screenplays** (English 100% vs non-English 18% in-sample) — exactly the
  prior finding — **but essays partially compensate for the non-English arthouse half**, because Criterion
  and the arthouse press carry many of these films in both languages (Portrait, Realm of Senses, Dersu
  Uzala, Winter Light, The Piano). So the gaze layer is *more* reachable for the non-English arthouse half
  via essays than the relational layer was via screenplays — a genuinely better situation than the
  script-coverage test feared.
- **Caveat that decides any future use:** essay coverage is **not systematic**. It is excellent for famous
  festival/arthouse titles and thin-to-absent for obscure ones (e.g. Holy Hell, Silent Running-class films
  in the wider corpus). A gaze-layer ingest built on essays would need a per-title fallback and would
  inherit each critic's vocabulary and interpretive slant — it would not be the clean, verbatim,
  dialogue-anchored mirror the calibration test produced. That is acceptable for *supplementing* the
  dialogue layer with image-awareness; it is not a substitute for it.

---

## Optional taste test — DONE (a usable source existed, so the plan said do it)

Picked **The Piano Teacher** (clearest "camera on the wound" case) with supporting quotes from **In the
Realm of the Senses** and **Portrait of a Lady on Fire**. Every line below is quoted verbatim from a page
fetched during this investigation (sources named). These are the patterns a dialogue-only pass could not
have produced — they are about the *camera*, not the words.

**The Piano Teacher** — sources: Senses of Cinema ("The Avoidance of Love," Alison Taylor), USF thesis
(Morgan Jennings), Bright Lights Film ("Undoing Oedipus," John Champagne).

1. **camera-refuses-to-fetishize** — the body shown at distance, not fragmented.
   > "Scenes of Erika at the piano are filmed full-body or at middle distance, unlike typical portrayals
   > in which close-ups of hands are used to suture in musician body doubles." (Bright Lights)

2. **wound-held-in-static-take (the "pornography of negation" inverse)** — the self-cut is shown, but the
   camera will not spectacularize it; it lingers on the empty façade instead.
   > "Alone in the Conservatory's grand foyer, her eyes welling with tears, Erika removes a knife from her
   > handbag. With an astounding grimace, she drives the blade into her shoulder… which instantly shoots
   > out blood… Haneke leaves us to contemplate the Conservatory's façade. Cars pass by. Erika disappears
   > out of view." (Senses of Cinema)
   > "The knife should dig into her heart and twist around!… Erika Kohut stabs a place on her shoulder,
   > which instantly shoots out blood. The wound is harmless… The world, unwounded, does not stand still."
   > (Jelinek, quoted in Senses of Cinema)

3. **restraint-as-distance** — the slight agitation is the only visible feeling; the camera stays far.
   > "Captured in static long takes, the slightest of agitations are observable, betraying a simultaneous
   > longing to abandon herself…" (Senses of Cinema)

4. **camera-lingers-on-a-face** — the viewer caught looking, until it repels.
   > "The camera lingers on his expression long enough that it becomes quite repulsive." (USF thesis, on
   > the opera-singer close-up)

5. **viewer-made-audience-to-refused-desire** — the film withholds the body yet displays porn; the spectator
   is positioned as the one who wants to see.
   > "the film's almost total withholding of characters' nudity combined with its inclusion of graphic
   > scenes from actual porn films." (Bright Lights)

**In the Realm of the Senses** — source: Criterion ("Some Notes on Oshima and Pornography," Donald Richie).
Directly answers "how does the camera look at the body":

6. **camera-discipline-vs-fragmentation** — the opposite of a pornographic gaze; the whole body kept in frame.
   > "Rather than employ an excited camera that wildly roams over the copulating bodies… Oshima employs
   > static shots. The camera is on a tripod, restrained. Often, too, it is some distance from the actors.
   > We see all of them, not just their sexual organs… The camera is usually above the actors, looking down
   > on them." (Criterion)

**Portrait of a Lady on Fire** — sources: Indiewire/Red Digital Cinema (Claire Mathon), Swarthmore film
essay. The film is explicitly about the gaze:

7. **camera-as-a-look** — the cinematographer names the camera's job as looking.
   > "Filming the language of their gazes, the force of attraction between the two women, was one of the
   > subjects of my work… I had to try to be a camera that looks, that peers." (Mathon, Indiewire)
   > "the 'looker'… is framed in a close-up or medium close-up shot while the 'looked-at'… is framed in a
   > long shot or medium long shot." (Swarthmore)

**Verdict of the taste test.** The gaze layer — camera distance, lingering, the wound shown without
spectacle, the viewer positioned as audience — is recoverable from free essays, and surfaces material the
dialogue-only calibration pass could not. It is messier and critic-shaped, but it is real and free.

---

## What could not be checked, and why

- **AD text for any film:** no free, downloadable AD transcript/script was found for any of the 15. I did
  not hold BBC iPlayer / Netflix / Apple TV accounts, so for 14 of 15 films even *track existence* on
  streaming is **could-not-check**, not confirmed-absent. The one confirmed AD track (Taxi Driver, BBC
  iPlayer) is behind a UK account + geo wall, so its text is still not freely retrievable. Conclusion:
  AD is **not a viable free text source** — stated as "not found as free text," explicitly *not* as "AD
  does not exist."
- **Screenplay action lines for 9 non-English films:** no free hosted screenplay with action lines was
  fetched this pass (Haneke, Oshima, Kechiche, Bergman, Puiu, Kurosawa, Park, von Horn, Wnendt). These
  screenplays exist in print/archive but were not verified free, so they are "not found (free, this pass),"
  consistent with the prior 6% non-English screenplay figure — not asserted absent.
- **Essay depth is uneven and not exhaustively mapped.** All 15 have *some* essay/material, but I did not
  read every academic piece; a few "Found" marks rest on a single strong source (e.g. Blue Is the Warmest
  Color on Wikipedia visual-symbolism + general criticism rather than a dedicated Criterion essay).
- **No bulk download, no pipeline, no schema change** — per the plan's hard limits. Only listings and a
  handful of verbatim quotes were touched.

---

## How to verify this report (self-check against the plan's "How to verify")

- Every sampled film has a definite status for all four source types — yes (table above).
- Per-source coverage percentages present — yes (section "Per-source coverage").
- Could-not-check is never conflated with not-available — yes (AD and 9 screenplays explicitly flagged).
- Recommendation directly answers "is there a free way to reach the gaze layer, and with what coverage" —
  yes (section "Recommendation": essays primary, screenplays bonus, AD dropped, ~100% essay / ~40%
  screenplay, language split softened by Criterion for non-English arthouse).
- Taste test included; every quote is verbatim from a fetched page, sources named — yes (section above).
