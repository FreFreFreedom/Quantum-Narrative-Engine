# Calibration Test Findings — Film Mirrors for FMCNS

## Purpose & method

This document is the deliverable of the calibration pass described in the queue plan
"Calibration test: read 3 films, write a patterns report." The goal: build a set of
**detection patterns** — recognizable human states, each anchored to a verbatim line
from a film — that the system can later use as *mirrors*. If Antoine's language matches
a pattern, the corresponding film (and its archetypal stance) becomes a candidate lens
for the response.

- **Corpus:** three films, each reduced to its `.srt` transcript.
  - `fr/First_Reformed_2017…srt` — *First Reformed* (2017)
  - `td/Taxi_Driver_(1976)23.976_fps.srt` — *Taxi Driver* (1976)
  - `itw/Into_the_Wild_(2007).eng.SDH.srt` — *Into the Wild* (2007)
- **Units:** 10–15 patterns per film. Each pattern = a hyphenated slug, a one-line
  description of the *state it detects*, and a **verbatim quote + SRT timestamp**.
- **Timestamps** are `HH:MM:SS` positions from the specific SRT release used here. They
  drift slightly across releases; treat them as anchors, not absolutes.
- **Verbatim guarantee:** every quote below was cut directly from the subtitle file. No
  line was reconstructed from memory. Two famous "quotes" that are *not* in the
  transcripts are flagged in Caveats so we never match on a meme.

---

## Film 1 — *First Reformed* (2017)

Themes: faith as self-torture, ecological grief, the church captured by capital,
refusal of comfort, the body as traitor.

1. **longhand-self-examination** — the journal used not to heal but to flay.
   - *"When writing about oneself, one should show no mercy."* (00:03:36)
   - *"This journal brings me no peace. It's self-pity. Nothing more."* (00:46:50)
   - *"My hands shake as I write these lines."* (00:37:48)

2. **borrowed-certainty** — reciting doctrine to hold a drowning self afloat.
   - *"What is thy only comfort in life and death?"* (00:04:16)

3. **self-annihilation-via-disclosure** — the diary must be destroyed so the truth dies with him.
   - *"and at the end of that time, it will be destroyed."* (00:03:45)
   - *"Shredded, then burnt."* (00:03:48)

4. **overlapping-grief** — unresolved loss looping as counterpoint (a 15-minute experimental
   montage where two voices repeat *"I'm going to kill myself"* / *"She's pregnant"* /
   *"I'm not going to be a father"*). Treat as ONE pattern, not many.
   - Block spans ~00:17:02 → ~00:32:00 (e.g. *"I'm going to kill myself."* at 00:17:02;
     *"I'm not going to be a father."* at 00:17:08).

5. **ecclesiastical-captivity** — the church owned by its donor; dissent suppressed for the gift.
   - *"he's underwritten the whole thing, paid to have the organ fixed."* (00:51:55)
   - *"Can we just agree to keep politics out of the reconsecration service?"* (00:58:57)

6. **institutional-self-protection** — the powerful close ranks around the founder's suicide.
   - *"get rid of it. Burn it, bury it."* (00:42:36)
   - *"There's no reason to bring disrepute on that cause."* (00:42:47)
   - *"you found the body, correct?"* (00:59:18)

7. **environmental-despair** — apocalyptic grief for the world worn as identity.
   - *"Michael cared about this world. Perhaps too much."* (00:53:16)
   - *"destroying the destroyers of the earth."* — Revelations 11:18 (01:16:47)

8. **counterfeit-prayer** — prosperity/anesthetic faith as a sedative.
   - *"If happiness came in pill size, it would have JC stamped on it."* (00:48:17)
   - *"There's no dollar sign on His pulpit. There's no American flag either."* (00:49:35)

9. **refusal-of-comfort** — love offered, then violently refused.
   - *"You need someone to take care of you."* (00:32:06) →
     *"For what? Love? You're not made for love?"* (00:32:10)
   - *"I despise you. I despise what you bring out in me."* (01:12:37)

10. **somatic-neglect** — the body as betrayer, ignored until it forces the issue.
    - *"We'd like to do a gastroscopic exam… We'd like to check for evidence of malignancy."* (01:09:26)
    - *"Cancer."* (01:09:42)
    - *"I'm hungry, I eat."* (01:10:38) — the shrug at his own decline.

11. **wounded-counselor** — the helper who cannot help himself, prayed *with* by the bereaved.
    - *"would you… pray with me?"* (01:04:00)
    - *"I was the one who asked him to come. I was raised in the church and I never could quite let it go."* (01:03:26)

12. **inverted-ministry** — performing holiness for an empty room.
    - *"You are a minister at a tourist church that no one attends."* (01:36:38)
    - *"You're always in the Garden… For you, every hour is the darkest hour."* (01:35:16–01:35:19)

13. **sacramental-smallness** — God rediscovered through the mundane (the only relief he finds).
    - *"Mary and I rode the park trail… the simple, curative power of exercise. It's God-given."* (01:00:55)
    - *"Every act of preservation is an act of creation."* (01:32:40)

14. **the-veil-of-denial** — cruelty followed by a claimed sudden wellness.
    - *"I suddenly feel much better."* (01:12:58, immediately after lashing out at Esther)

---

## Film 2 — *Taxi Driver* (1976)

Themes: insomnia-alienation, purity-as-morality, purification-through-violence, the
savior fantasy, sexual shame, political disillusion, the loner's grandiose plan.

1. **sleepless-alienation** — a man outside the rhythms of others.
   - *"I can't sleep nights."* (00:02:33)

2. **cleanliness-as-morality** — scrubbing the outside to absolve the inside.
   - *"It's real clean, like my conscience."* (00:03:08)

3. **purification-fantasy** — rain as apocalypse that will wash the city clean.
   - *"Someday, a real rain will come and wash all this scum off the streets."* (00:06:16)

4. **god's-lonely-man** — isolation claimed as a divine appointment.
   - *"I'm God's lonely man."* (00:53:20)

5. **mirror-rehearsal** — practicing potency to an empty mirror before acting.
   - *"You talking to me?"* (01:06:37; again 01:06:41; 01:06:45)

6. **weaponized-intimacy** — violence narrated as erotic spectacle.
   - *"I'm gonna kill her with a .44 Magnum pistol."* (00:42:52)
   - *"Did you ever see what a .44 Magnum can do to a woman's face?"* (00:43:15)

7. **sexual-shame-projection** — desire routed through disgust at the object of desire.
   - *"There's porno theaters for that."* (00:02:35)
   - *"This is a dirty movie."* (00:34:47, the Betsy date implosion)

8. **savior-complex** — rescuing a child-victim to rescue himself.
   - *"She's 12 years old. You ain't…"* (01:16:45, Sport on Iris)
   - *"Are you really twelve?"* (01:19:43, Travis to Iris)

9. **infantilized-victim** — the saved one addressed as "baby," never a person.
   - *"Come to me, baby."* (01:30:36) / *"Baby, I never wanted you…"* (01:29:46)

10. **political-disillusion** — the candidate as empty slogan.
    - *"We are the people."* (00:11:06, Palantine campaign)
    - *"the next president of the U.S., Senator Charles Palantine."* (01:34:21)

11. **the-performativity-of-threat** — menace staged for an audience that isn't there.
    - repeated *"You talking to me?"* across the mirror scene (01:06:37–01:06:45)

12. **the-massacre-as-release** — catharsis through carnage, then instant respectability.
    - *"You're dead."* (01:07:42, during the shoot-out)
    - *"Ladies and gentlemen…"* (01:34:20, the closing cab fantasy)

13. **pimp-as-system** — the exploiter named casually, as infrastructure.
    - *"Hey, Sport."* (00:52:25) / *"This here's Easy Andy."* (00:53:59) / *"Iris."* (01:20:22)

---

## Film 3 — *Into the Wild* (2007)

Themes: the shattered family myth, ascetic freedom, burning the past, the lonely
path, the offered family refused, the impossibility of pure solitude, death by idealism.

1. **the-found-lie** — the parents' love story revealed as adultery and bigamy.
   - *"He discovered that our parents' stories of how they fell in love and got married…"* (00:52:47)
   - *"When they met, Dad was already married."* (00:52:56)
   - *"to whom he was still legally married."* (00:53:07)
   - *"And Mom, in the shame and embarrassment of a young mistress,"* (00:53:28)

2. **the-wrong-woman-wrong-man** — the parents' union read retroactively as a mistake.
   - *"She's the wrong woman, he's the wrong man."* (00:16:01)

3. **ultimate-freedom** — the open road as total self-erasure of the past.
   - *"Two years he walks the earth."* (00:11:28)
   - *"Ultimate freedom."* (00:11:59)
   - *"Christopher Johnson McCandless."* (00:14:33)

4. **burning-the-past** — money/identity literally set on fire.
   - *"but he decided to burn all of his money."* (00:28:59)

5. **rejection-of-career** — work as the cage of the 20th century.
   - *"I think careers are a 20th century…"* (01:54:22, voiceover letter)

6. **the-lonely-path** — solitude claimed as strength, named by the film as a trap.
   - *"a relentlessly lonely path"* (00:20:29, narration)

7. **reach-or-lose** — the elder's gospel of grasping.
   - *"if you want something in life, reach out and grab it."* (01:43:25, Wayne)

8. **offered-family** — love proposed as adoption, and refused.
   - *"What do you say you let me adopt you?"* (02:13:48, Ron Franz)

9. **loneliness-of-the-loved** — the one who loved him, left behind and writing into the void.
   - *"I hope you're not lonely without me"* (01:16:45; 01:17:27; 01:17:39, Ron Franz's letters)
   - *"Get out of that lonely house,"* (02:00:40, Ron Franz)

10. **happiness-only-in-sharing** — the famous closing insight, **not** in its meme form (see Caveats).
    - *"and now I think I have found what is needed for happiness."* (01:46:28)
    - *"Such is my idea of happiness."* (01:47:08)

11. **alaska-as-pure-self** — the wilderness as the only place the self can be real.
    - *"I'm going to Alaska."* (00:45:56)

12. **death-by-ideal** — the nature that was supposed to save him kills him.
    - *"Hedysarum alpinum is wild potato root. Wild potato root."* (02:05:19, the misidentified food)

13. **measured-against-family** — the sister's frame: he judged himself by an impossible standard.
    - *"Chris measured himself…"* (00:20:23, Carine narration)

---

## Cross-film shared patterns

These states recur across all three and are the strongest universal mirrors:

- **the-lonely-man** — isolation as identity: FR *"a tourist church that no one attends"*
  (01:36:38); TD *"I'm God's lonely man"* (00:53:20); ITW *"a relentlessly lonely path"* (00:20:29).
- **purity-as-survival** — cleanliness standing in for worth: FR *"another form of prayer"*
  (01:33:40); TD *"real clean, like my conscience"* (00:03:08); ITW ascetic burning (00:28:59).
- **the-found-lie** — the trusted institution/person revealed false: FR church owned by Balq
  (00:51:55); TD Palantine as empty slogan (00:11:06); ITW the parents' bigamy (00:52:56).
- **savior-vs-destroyer ambiguity** — the same act framed as rescue or annihilation: FR Toller's
  vest; TD Travis "saving" Iris; ITW Chris "freeing" himself and dying.
- **somatic-neglect** — the body ignored until it forces the plot: FR cancer (01:09:42);
  TD insomnia (00:02:33); ITW starvation/poisoning (02:05:19).
- **refusal-of-comfort** — love turned away at the threshold: FR Esther (00:32:06);
  ITW Ron Franz's adoption refused (02:13:48); TD Betsy at the theater (00:34:47).

---

## Caveats

1. **"Happiness only real when shared" is NOT in the transcript.** The film's actual closing
   lines are *"and now I think I have found what is needed for happiness"* (01:46:28) and
   *"Such is my idea of happiness"* (01:47:08). Do **not** match on the meme phrase — it will
   false-positive on the internet's version, not the film's text.
2. **First Reformed's montage is one block, not many.** The overlapping *"I'm going to kill
   myself" / "She's pregnant"* voices repeat from ~00:17 to ~00:32. Count it as the single
   `overlapping-grief` pattern.
3. **"Ernst" is the protagonist, not a second character.** Reverend **Ernst** Toller is the
   lead (the name appears at 01:48:03 when Mary calls him). Do not build a separate "Ernst"
   mirror — there is no recruiter named Ernst and no "I need you to join me in my crusade" line
   in this film. That line belongs to a different movie and was wrongly attributed in earlier
   notes; it is excluded here.
4. **Timestamps are release-specific.** They come from the SRTs in `subs/`. A different Blu-ray
   release will shift them by seconds; patterns should match on the *text*, not the timecode.
5. **Subtitle text ≠ exact script.** SDH/English subs compress; quote them as heard in the
   transcript, not as the published screenplay.
6. **The "vest" / "I made this for you" scene is not cleanly captioned** in this SRT — Toller's
   discovery of Michael's explosives is shown but the dialogue is minimal. Pattern 5
   (environmental-despair) and the Revelation justification (01:16:47) carry that arc instead of
   a fabricated line.
