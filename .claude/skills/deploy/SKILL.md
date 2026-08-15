---
name: deploy
description: Deploy a backend change to Railway and confirm it landed. Use whenever pushing queue-server changes to main or checking a Railway deploy.
---

# Deploying

Railway project `Quantum-Narrative-Engine`, root directory set to `queue-server`.
Required variables: `JWT_SECRET`, `ADMIN_PASSWORD`; see
`queue-server/README.md` for the full variable table.

Railway deploys automatically from this GitHub repo's `main` branch — there is no
manual "deploy" step beyond pushing. Workflow for any change:

1. Edit the code.
2. Zero-cost syntax checks: `node --check <file>` on every changed server file,
   and for the frontend extract the inline `<script>` blocks of
   `fmcns_navigator.html` and `node --check` each (no test suite catches syntax
   errors otherwise).
3. Frontend sync (AGENTS.md hard rule): copy `fmcns_navigator.html` over
   `queue-server/public/index.html` and verify the checksums match.
4. Commit and push to `main` immediately.

**No local test phase.** Antoine's rule (AGENTS.md "Ship directly"): he reviews
quality by using the app; anything broken after shipping gets reported and fixed
in the next round. Do not boot locally, do not run curl verification, do not
test feature behavior before pushing. The one exception is a single cheap check
that the deploy landed (production serves the new frontend checksum, or the
changed route answers) — that is deploy confirmation, not a test phase.

Past silent-breakage examples (the `DATA_DIR`-not-created bug in
`taskRunner.js`, the entity-panel response-unwrapping bug) are exactly the
mistakes Antoine accepts shipping — he reports them, they get fixed.
