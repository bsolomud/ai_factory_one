# Stage: CI (loops per red run)

Diagnose red CI with discipline. The loop lives inside this stage; the stage
advances when **CI is green** — merging is a separate, human, out-of-session act
and is recorded, not waited for.

> **Why the gate is green CI and not the merge.** It used to be both, and the
> consequence was measured: 18 of 29 pilot runs were aborted and 15 of those sat
> at exactly this gate, because a merge lands hours or days later and nobody
> comes back to a finished session to advance it. SCRIBE — the one stage whose
> entire job is to write down what the run learned — therefore ran on 6 of 29
> runs, and every abort threw away a run's worth of learnings that were sitting
> in its own audit log. A gate that cannot be reached is not a safeguard; it is
> a leak. Record the merge state honestly in `## Outcome` and move on.

## Inputs
1. Failed run logs: via the CI provider recorded in the profile, or ask the
   developer to paste the logs (the universal fallback).
2. The branch diff and `artifacts/02-plan.md`.
3. The profile's `ci` binding: **if a repo CI/debugging skill is bound, use
   it as-is** — it is the single source of truth; record it:
   `pipeline used skill <its path>` (feeds the assets report). Otherwise use
   the pipeline's built-in **ci-triage** skill
   (`~/.claude/skills/ci-triage/SKILL.md`) as the evidence layer under the
   discipline below.

## Output
`artifacts/07-ci-analysis.md` — APPEND one entry per analyzed run. Required
sections: Runs analyzed, Classification, Fixes, Outcome.

## Procedure — hard discipline, repo-independent
- **Pre-flight before classification**: run the bound triage procedure's
  mergeability and expected-vs-ran checks FIRST — green checks on a
  conflicted PR are a false green (the workflows were silently skipped, not
  passed), and a missing workflow must be explained before any log is read.
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
- **On a reopen / re-run that redoes the analysis**: archive the prior round's
  Classification / Fixes / Outcome into `## History` under a collapsed
  `<details>` block, and keep the sections above reflecting the CURRENT round.
  (Per-run rows still accumulate in `## Runs analyzed` — History is for
  superseded whole-round analyses, not individual runs.)

- **A red CI run is a round.** Open it (`pipeline round open ci`), record each
  failure you had to fix as a finding
  (`pipeline finding --class <…> --missed-by <probe | none> --summary "<one line>"`),
  and close it. A CI failure that a local check could have caught is the
  cheapest possible probe to learn, and it is invisible unless recorded.

## Done when
CI is green. Record the merge state in `## Outcome` — merged, or awaiting the
developer's merge with what still has to happen (merging is a human act — never
merge). Update the BLUF header (reflecting the latest run), set
`status: complete`, `pipeline advance`, STOP. Do NOT hold the run open waiting
for a merge: SCRIBE is next, and the learnings are worth more written down now
than perfectly sequenced later. If the merge later needs work, `pipeline reopen`
brings the run back.
