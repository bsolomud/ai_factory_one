# Stage: CI (loops per red run)

Diagnose red CI with discipline. The loop lives inside this stage — the stage
advances only when CI is green and the human has merged.

## Inputs
1. Failed run logs: via the CI provider recorded in the profile, or ask the
   developer to paste the logs (the universal fallback).
2. The branch diff and `artifacts/02-plan.md`.
3. Repo debugging playbooks via bindings, when present.

## Output
`artifacts/07-ci-analysis.md` — APPEND one entry per analyzed run. Required
sections: Runs analyzed, Classification, Fixes, Outcome.

## Procedure — hard discipline, repo-independent
- Classify each failure with evidence: **deterministic** (maps to the diff →
  propose a fix) / **suspected flake or order dependence** (reproduce FIRST;
  use repo tooling when documented) / **lint** (targeted fix) /
  **infrastructure** (recommend re-run; never invent code fixes).
- **Reproduce before fixing.** An unreproduced fix is a guess.
- **One hypothesis per CI run.** Multiple changes make results unreadable.
- **After 2 failed fix attempts: STOP.** Build diagnostics (logging, a
  reproduction script) instead of pushing a third guess.
- Every proposed fix goes to the developer at the gate BEFORE it is applied
  and pushed.

## Done when
CI green and the developer has merged (merging is a human act — never merge).
Update `## Outcome`, set `status: complete`, `pipeline advance`, STOP.
