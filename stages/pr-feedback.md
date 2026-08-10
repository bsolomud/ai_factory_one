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
