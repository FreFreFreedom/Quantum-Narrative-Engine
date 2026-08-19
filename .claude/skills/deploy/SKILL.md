---
name: deploy
description: Deploy a backend change to Railway and confirm it landed. Use whenever pushing queue-server changes or checking a Railway deploy.
---

# Deploying

Railway project `valiant-solace` (id `561b1a1b-bfa0-4e8d-9525-414c3e32b868`), one
service `qne-production`, root directory set to `queue-server`, volume at `/data`.
`DB_PATH=/data/queue.db` is load-bearing — see the memory note before touching
variables.
Required variables: `JWT_SECRET`, `ADMIN_PASSWORD`; see
`queue-server/README.md` for the full variable table.

**There is one branch: `develop`.** It is the trunk, it is what Railway deploys from,
and pushing it *is* the deploy. There is no separate step.

```bash
git push origin develop            # the work AND the deploy
```

Confirm what is live with `git ls-remote origin refs/heads/develop`.
Normal latency is under a minute; give it two before suspecting a problem.

There used to be a second branch, `main`, that Railway watched, so deploying meant
pushing the same commit twice. The two never once diverged in the project's whole
history, so it protected nothing and was purely a step you could forget — and
forgetting it looked exactly like a broken pipeline. Retired 2026-08-19. **Do not
reintroduce `git push origin develop:main`**: it would recreate the branch and, worse,
teach the next reader that a deploy needs two pushes.

Note that the Dispatch Queue also publishes finished tasks by itself (the local runner
commits, `scripts/git-ship.js` pushes the trunk) — so `develop` can move without you.
See AGENTS.md "Git rules".

Workflow for any change:

1. Edit the code.
2. Zero-cost syntax checks: `node --check <file>` on every changed server file,
   and for the frontend extract the inline `<script>` blocks of
   `fmcns_navigator.html` and `node --check` each (no test suite catches syntax
   errors otherwise).
3. Frontend sync (AGENTS.md hard rule): copy `fmcns_navigator.html` over
   `queue-server/public/index.html` and verify the checksums match.
4. Commit and push to `develop` immediately — that is the deploy.

**No local test phase.** Antoine's rule (AGENTS.md "Ship directly"): he reviews
quality by using the app; anything broken after shipping gets reported and fixed
in the next round. Do not boot locally, do not run curl verification, do not
test feature behavior before pushing. The one exception is a single cheap check
that the deploy landed (production serves the new frontend checksum, or the
changed route answers) — that is deploy confirmation, not a test phase.

Past silent-breakage examples (the `DATA_DIR`-not-created bug in
`taskRunner.js`, the entity-panel response-unwrapping bug) are exactly the
mistakes Antoine accepts shipping — he reports them, they get fixed.
