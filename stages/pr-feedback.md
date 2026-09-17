# Procedure: PR feedback (off-FSM — reviewer comments on the run's PR)

NOT a pipeline stage: no `advance`, no gate of its own. This is the triage
procedure for human review comments on the open PR. You classify and propose;
the developer decides per comment; accepted changes are executed through the
FSM's sanctioned rework path (`pipeline reopen` → re-advance through the
gates). This artifact records the round so feedback never reads as a clean run.

## Inputs
1. The PR's unresolved review threads — comment body, author, file:line, plus
   any request-changes review verdicts: via the code-hosting provider the PR
   lives on, or ask the developer to paste them (the universal fallback).
2. The branch diff, `artifacts/01-context.md` (scope + acceptance criteria),
   `artifacts/02-plan.md` (the decisions reviewers may be challenging).

## Output
`artifacts/09-pr-feedback.md`, one round per feedback batch, from the matching
template in `templates/`. Required sections: Comments, Replies, Outcome.

## Procedure — verify, then classify; never assume the reviewer is right
- Read every unresolved thread. Check each claim against the actual code and
  diff before classifying — reviewers misread diffs too.
- Classify each comment with evidence:
  - **code-change** — correct, needs code: propose the exact change.
  - **design-change** — invalidates a plan decision: name the decision and
    what would replace it (this implies reopening PLAN, not just IMPLEMENT).
  - **answer-only** — a question or discussion: draft the reply, no rework.
  - **out-of-scope** — real, but beyond this run's acceptance criteria:
    propose a follow-up ticket, never silent scope creep.
  - **disputed** — you believe the reviewer is mistaken: draft the
    counter-argument with evidence; the developer arbitrates.
- Fill `## Comments` as a table, one row per thread, with the proposed action.

## Rework rigor — the rule this procedure exists to enforce
Measured on two pilot PRs: 23 reviewer findings, **12 of them on code written to
fix the other 11**. The first round would have been the last if the fixes had
not carried new defects. A fix is a change like any other, and it is produced
under worse conditions than the original code: no plan, no coupling analysis, no
blind review, and a review comment standing in as a spec that is narrower than
the truth. Treat an accepted comment as a small change that earns the same
machinery, not as an edit:
- **Never batch nits with blockers.** In a pilot PR a round-1 nit ("name the
  record via its global id") was fixed alongside the blockers, and its fix was
  the round-2 correctness bug. Nits ride through on the blockers' attention.
- **Each accepted `code-change` gets a `## Coupling` row** in the review
  artifact before it is implemented — who else writes/reads what this touches.
  A one-line fix has a blast radius; that is precisely how it stays unmeasured.
- **Re-prove, never re-stamp.** A fix inside the plan's `## Affected files`
  expires the proof ledger, and `ac_proofs` will block until the proofs are
  re-run. That gate is the whole defense against a later fix silently making an
  earlier round's test non-load-bearing — which is a thing that happened.
- **Reopen to PLAN, not IMPLEMENT, when the fix changes a decision.** A
  `design-change` that re-enters at IMPLEMENT skips the critic and the coupling
  ledger, which are the two stages that would have caught it.
- Draft replies (verbatim, ready to post) for answer-only and disputed rows.
- On a later round: archive the prior round's Comments / Replies / Outcome
  into `## History` under a collapsed `<details>` block; keep the sections
  above reflecting the CURRENT round.

## Done when
Artifact written for this round; summary returned INCLUDING one verdict line
per comment (# · class · proposed action) — the developer decides per comment
from that summary. Do NOT reopen anything, do NOT edit the repo, do NOT post
replies or resolve threads: execution happens only after the developer's
per-comment decisions, per the dispatcher flow.
