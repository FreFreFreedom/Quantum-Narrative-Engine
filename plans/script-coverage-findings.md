# Script coverage test — findings

**Status:** DONE 2026-08-26
**Type:** Investigation report. No code changed, no schema touched, nothing built.

Companion to [`script-coverage-test.md`](script-coverage-test.md) (the plan this executes).

---

## Correction to the plan's premise, found while doing this

The plan describes the corpus as "heavy with... Tarkovsky, Bresson, Dreyer, Béla Tarr,
Haneke, Cavalier, Zvyagintsev, Bergman" and names *Nostalghia*, *The Turin Horse*, *Diary of
a Country Priest*, *Thérèse*, *Elena*, and *The Passion of Joan of Arc* as titles that must
be in the sample.

I read the actual source of truth, `queue-server/data-seed/fmcns_ontology.json`'s
`filmsIndex` (199 films, confirmed count). **None of those titles or directors are in the
corpus except Haneke** (`The Piano Teacher`, `Antichrist`-adjacent — actually just *The Piano
Teacher*) and Bergman (`Winter Light`, `Scenes from a Marriage`). I grepped the raw JSON for
every name and title above and got exactly two hits, both "Haneke." This is not a sampling
miss — the file does not contain these films at all.

The real corpus is 199 films dominated by English-language American/British cinema (Coens,
Scorsese, Hitchcock, Spielberg, Kubrick, Aronofsky, von Trier's English-language work, etc.)
with a genuine but smaller and differently-shaped non-English contingent: French arthouse
(Breillat, Beineix, Melville, Sciamma, Dolan), Korean (Park Chan-wook, Kim Ki-young),
Japanese (Oshima, Kore-eda), Scandinavian (Bergman, von Horn), Persian (Farhadi), Romanian
(Puiu), Hebrew (Folman), and a couple of Soviet/Latin American outliers (Kurosawa's *Dersu
Uzala*, *Embrace of the Serpent*). Slow, austere European art cinema of the Tarkovsky/Bresson/
Béla Tarr kind is essentially absent from this particular corpus.

I proceeded with the real data. The task's actual question — "does perception work equally
well on the non-English/arthouse slice of *this* corpus?" — still stands and is still worth
answering; I just answered it about the corpus that exists, not the one described in the plan.
**If the plan's authors intended a different/larger corpus than `filmsIndex`, that needs
reconciling separately — flagging it here rather than silently substituting a different film
list.**

## Sample: 30 films, stratified across all 12 clusters, non-English titles over-weighted

The actual corpus is roughly 13% non-English (25-ish of 199 films, by hand count). The
sample below is 57% non-English (17 of 30) — deliberately inverted, per the plan's
instruction, so the sample doesn't just report on the easy 87%. Each cluster gets 1–5 films
depending on its size and how many non-English titles it contains; every cluster that has a
non-English title got at least one in the sample. One clear, well-known English title per
cluster is kept as a control, to make relative coverage visible rather than just absolute.

| # | Film | Original title | Cluster | Language |
|---|---|---|---|---|
| 1 | Winter Light | Nattvardsgästerna | I | Swedish |
| 2 | The Piano Teacher | La Pianiste | I | French |
| 3 | Taxi Driver | — | I | English (control) |
| 4 | Betty Blue | 37°2 le matin | II | French |
| 5 | In the Realm of the Senses | Ai no Korīda | II | Japanese |
| 6 | The Handmaiden | Agassi | II | Korean |
| 7 | Fat Girl | À ma sœur! | II | French |
| 8 | Eyes Wide Shut | — | II | English (control) |
| 9 | Scenes from a Marriage | Scener ur ett äktenskap | III | Swedish |
| 10 | A Separation | Jodaeiye Nader az Simin | III | Persian |
| 11 | Marriage Story | — | III | English (control) |
| 12 | The Death of Mr. Lazarescu | Moartea domnului Lăzărescu | IV | Romanian |
| 13 | The Girl with the Needle | Pigen med nålen | IV | Danish |
| 14 | Manchester by the Sea | — | IV | English (control) |
| 15 | Dersu Uzala | Дерсу Узала | V | Russian |
| 16 | Embrace of the Serpent | El abrazo de la serpiente | V | Spanish/Portuguese/indigenous |
| 17 | No Country for Old Men | — | V | English (control) |
| 18 | Waltz with Bashir | Vals Im Bashir | VI | Hebrew |
| 19 | Apocalypse Now | — | VI | English (control) |
| 20 | Holy Hell | — | VII | English (documentary, obscure) |
| 21 | The Apostle | — | VII | English (control) |
| 22 | Le Samouraï | — | VIII | French |
| 23 | Vertigo | — | VIII | English (control) |
| 24 | Silent Running | — | IX | English (obscure) |
| 25 | Blade Runner | — | IX | English (control) |
| 26 | The Housemaid | Hanyeo | X | Korean |
| 27 | Portrait of a Lady on Fire | Portrait de la jeune fille en feu | X | French |
| 28 | I Killed My Mother | J'ai tué ma mère | X | French |
| 29 | Kingdom of Heaven | — | XI | English (all-English cluster) |
| 30 | Waking Life | — | XII | English (all-English cluster) |

Clusters IX, XI, XII contain no non-English titles at all in this corpus, so their entries
are English by necessity, not a stratification miss.

## Per-film results

Method: for each film, checked IMSDb, Script Slug, Simply Scripts (formal screenplay
archives), and OpenSubtitles/Subscene/SubtitleCat/SUBDL-type subtitle sites (dialogue via
subtitles), via web search plus a small number of direct page fetches. **No script or
subtitle text was downloaded or stored** — only confirmed a listing exists.

Legend for "format": **Screenplay** = a real script hosted on a recognized archive.
**Transcript** = an unofficial fan-made prose dialogue transcript (not a formal script).
**Subtitles** = timed subtitle files, found on at least one legitimate subtitle site.

| Film | Cluster | Any dialogue source found? | Best format | Source(s) | Language of source |
|---|---|---|---|---|---|
| Winter Light | I | Yes | Subtitles (+ unverified transcript listing) | OpenSubtitles/Subscene/SUBDL; subslikescript page seen but not content-verified (JS-rendered) | English |
| The Piano Teacher | I | Yes | Subtitles + fan transcript | OpenSubtitles (178 files); Forever Dreaming; scripts.com | English |
| Taxi Driver | I | Yes | **Screenplay** | IMSDb, Script Slug | English (original) |
| Betty Blue | II | Yes | Subtitles only | OpenSubtitles, SUBDL, elSubtitle, SRTFiles | English |
| In the Realm of the Senses | II | Yes | Subtitles only | OpenSubtitles, SubtitleCat, SRTFiles | English |
| The Handmaiden | II | Yes | Subtitles + fan transcript | OpenSubtitles (203 files); Forever Dreaming; scripts.com | English |
| Fat Girl | II | Yes (weak) | Subtitles only, one listing | OpenSubtitles (single "tmp"-quality entry) | English |
| Eyes Wide Shut | II | Yes | **Screenplay** | IMSDb | English (original) |
| Scenes from a Marriage | III | Yes | Subtitles only | OpenSubtitles (note: listings overlap with the 2021 HBO remake — needs manual disambiguation) | English |
| A Separation | III | Yes | **Screenplay** (translated) | Script Slug | English (translated) |
| Marriage Story | III | Yes | **Screenplay** | Script Slug | English (original) |
| The Death of Mr. Lazarescu | IV | Yes | Subtitles only | OpenSubtitles, SUBDL, SubtitleCat | English |
| The Girl with the Needle | IV | Yes | Subtitles only | OpenSubtitles, SubSource, SubtitleCat | English |
| Manchester by the Sea | IV | Yes | **Screenplay** | Simply Scripts (studio FYC PDF) | English (original) |
| Dersu Uzala | V | Yes (weak) | Subtitles + informal transcript | OpenSubtitles (202 listings); scripts.com fan transcript | English |
| Embrace of the Serpent | V | Yes (weak) | Subtitles + informal transcript | OpenSubtitles (63 listings); scripts.com fan transcript | English |
| No Country for Old Men | V | Yes | **Screenplay** | IMSDb | English (original) |
| Waltz with Bashir | VI | Yes (weak) | Fan transcript + subtitles | Forever Dreaming; scripts.com; OpenSubtitles | English |
| Apocalypse Now | VI | Yes | **Screenplay** | IMSDb, dailyscript.com (Redux) | English (original) |
| Holy Hell | VII | Yes | Subtitles only (documentary — no traditional script exists) | OpenSubtitles (13 listings) | English |
| The Apostle | VII | Yes | Subtitles only (script exists but only behind paid sites) | OpenSubtitles, SUBDL | English |
| Le Samouraï | VIII | Yes | Subtitles + fan transcript | OpenSubtitles (155 listings); subslikescript | English |
| Vertigo | VIII | Yes | **Screenplay** | IMSDb | English (original) |
| Silent Running | IX | Yes | Fan transcript + subtitles (no formal screenplay found free) | subslikescript; SUBDL, SRTFiles | English |
| Blade Runner | IX | Yes | **Screenplay** | IMSDb, Script Slug | English (original) |
| The Housemaid | X | Yes | Subtitles only | SubtitleCat confirmed; broader OpenSubtitles/Subscene listing could not be directly verified (treated as could-not-check for that specific claim, not absent) | English |
| Portrait of a Lady on Fire | X | Yes | Subtitles + unofficial fan transcript | OpenSubtitles (120+ files); Scribd/CourseHero/pdfcoffee fan translations | English |
| I Killed My Mother | X | Yes | Subtitles only | OpenSubtitles (~9 English of 71-84 listings) | English |
| Kingdom of Heaven | XI | Yes | **Screenplay** | Simply Scripts | English (original) |
| Waking Life | XII | Yes | **Screenplay** | IMSDb | English (original) |

## Per-cluster coverage

"Any source" = subtitles, transcript, or screenplay — the minimum needed to get dialogue text
at all. "Screenplay" = a formal script specifically.

| Cluster | Sampled | Any source found | Screenplay found |
|---|---|---|---|
| I | 3 | 3/3 (100%) | 1/3 (33%) |
| II | 5 | 5/5 (100%) | 1/5 (20%) |
| III | 3 | 3/3 (100%) | 2/3 (67%) |
| IV | 3 | 3/3 (100%) | 1/3 (33%) |
| V | 3 | 3/3 (100%) | 1/3 (33%) |
| VI | 2 | 2/2 (100%) | 1/2 (50%) |
| VII | 2 | 2/2 (100%) | 0/2 (0%) |
| VIII | 2 | 2/2 (100%) | 1/2 (50%) |
| IX | 2 | 2/2 (100%) | 1/2 (50%) |
| X | 3 | 3/3 (100%) | 0/3 (0%) |
| XI | 1 | 1/1 (100%) | 1/1 (100%) |
| XII | 1 | 1/1 (100%) | 1/1 (100%) |
| **Overall** | **30** | **30/30 (100%)** | **11/30 (37%)** |

## English vs non-English split — the number that actually decides this

| | Sample size | Any source | Screenplay |
|---|---|---|---|
| English-language titles | 13 | 13/13 (100%) | 10/13 (77%) |
| Non-English titles | 17 | 17/17 (100%) | 1/17 (6%) — only *A Separation*, via a translated shooting script |

This is the clean result the task was designed to surface: **formal screenplays are almost
entirely an English-language phenomenon** (77% vs 6%), exactly as the plan worried. But
**subtitle coverage does not follow that pattern at all** — every single film in the sample,
without exception, including the obscurest non-English arthouse titles (*Dersu Uzala* from
1975, *The Housemaid* from 1960, a 2024 Danish festival film), had English-subtitle listings
findable on at least one legitimate free site. Several non-English titles also had informal
fan-made prose transcripts as a bonus on top of subtitles (Piano Teacher, Handmaiden, Dersu
Uzala, Embrace of the Serpent, Waltz with Bashir, Le Samouraï, Portrait of a Lady on Fire).

## Recommendation

**Subtitles must be the primary source; screenplays are a bonus, not a foundation.** A
pipeline built around IMSDb/Script Slug-style screenplay scraping would only ever reach the
English-language ~40% of this corpus (11/30 in-sample, and structurally capped near there
corpus-wide, since screenplay sites simply do not carry non-English/older/small-release
titles). A pipeline built around subtitle sources reached 100% of the sample regardless of
language, obscurity, or age. This directly resolves the plan's central question: perception
does **not** have to go blind on the arthouse half of the corpus, provided the ingestion path
is subtitles-first, with a screenplay used opportunistically when one happens to exist (it
adds scene direction and speaker attribution that raw subtitles lack, which is real value
when available — just not something to depend on).

## What could not be checked, and why

- **No OpenSubtitles API key was available or used.** Every "found" result above comes from
  the public web-search-indexed listing pages of OpenSubtitles and equivalent sites
  (OpenSubtitles.org/.com, Subscene, SubtitleCat, SUBDL, SubSource), not from OpenSubtitles'
  actual API. A listing page existing is strong evidence a subtitle file exists, but it is
  not the same as confirming programmatic access via the API works or is free — if a future
  pipeline is built on the API specifically, that needs its own, separate access check before
  anything is designed around it.
- One direct `WebFetch` of an `opensubtitles.org` page returned HTTP 403 (bot-blocked); the
  same listing was independently confirmed via a search-engine-indexed snippet, so it is
  counted as "found," not "could not check" — but a bulk/automated ingestion pipeline hitting
  that same page directly would likely hit the same 403, which the search-snippet method
  sidesteps but a real scraper would not.
- **Winter Light**'s subslikescript transcript page loaded as a blank "Loading…" placeholder
  under direct fetch (JS-rendered content) — its subtitle availability is solid and was
  confirmed elsewhere, but the transcript-specific claim for that one film is weaker than the
  rest of the table and is flagged as such above.
- **The Housemaid (1960)** — a direct OpenSubtitles/Subscene listing page could not be
  independently surfaced by search; SubtitleCat confirmed a listing so the film is still
  "found," but the broader subtitle-site claim for this specific title is thinner than for
  the other 29 and is flagged as such above.
- **Scenes from a Marriage (1973)** — OpenSubtitles listings for this title are mixed in
  with the 2021 HBO remake of the same name; a real ingestion pipeline would need to
  disambiguate by year/runtime, not just title, before trusting a match.
- No site outright refused every query with a persistent block/CAPTCHA across the whole run
  — the 403 above was the only such event, and it was on one page of one film, not a whole
  source going dark. Nothing was reported as "not found" as cover for a site being
  unreachable; the only true 0% cells in the coverage table are "screenplay" cells, where the
  absence is real (checked directly against IMSDb/Script Slug/Simply Scripts, not inferred
  from a site being down).
