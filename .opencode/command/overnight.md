---
description: Start an autonomous overnight run of the multi-agent plan. Safe defaults, no questions, never publishes. Optional argument: which build-order steps to implement (default: steps 0-4).
agent: fmcns-overnight
---

You are beginning an autonomous, unattended implementation run of the FMCNS
multi-agent plan. Antoine is asleep — he will not answer you.

Read `plans/multi-agent-development-team.md`. The REVISION section at the top is
authoritative where it conflicts with the baseline. Implement $ARGUMENTS — or,
by default, steps 0–4 of the original build-order table (the foundation: the
Mac execution fix, durable task storage, two parallel workers, and the review
screen groundwork). The steps are independently shippable; do them in order,
verifying each one — but when a step is blocked by a pending product/design
question, skip to the next step that does not depend on it and return to the
blocked step later.

Follow AGENTS.md's "Autonomous overnight runs" contract and the
`fmcns-overnight` agent instructions: never ask, never publish, never destroy.
Decide routine technical details and continue. For product/design questions,
never decide silently — park them in the "Pending Decisions" section of
RUN_LOG.md (with a marked-as-suggestion recommendation and what each one
blocks), continue with independent work, and finish the blocked parts only
after Antoine answers. If a step is genuinely blocked, park it, document why,
and continue with the next step.

Work on branch `overnight/<date>`, committing locally after each verified step.
Do not push.

When the scope is done (or everything is parked), write one concise
plain-English report: what was completed, what could not be completed, every
pending question, and what each one blocks. Pending questions come first. Keep
it short and non-technical.
