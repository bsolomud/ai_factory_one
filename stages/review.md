# Stage: REVIEW (pre-PR)

Catch issues while fixing them is private and cheap — before a PR exists.

## Inputs
1. The FULL branch diff vs the base branch (not per-subtask).
2. The profile's `review` binding: **if a repo review skill is bound, use it
   as-is** — it is the single source of truth (it may match a CI reviewer).
   Otherwise use the built-in passes below.
3. `artifacts/02-plan.md` for the architecture check.

## Output
`artifacts/05-review.md`. Required sections: Findings, Fixes applied,
Disputed, Plan-vs-shipped check.

## Procedure (executed by `pipeline-reviewer`, fresh context; fixes by `pipeline-implementer`)
- Review the full diff with the bound skill's instructions or the built-in
  passes: logic/correctness, security, performance,
  style-consistency-with-surrounding-code. Verification-before-flagging: a
  finding without checked evidence is noise — drop it.
- **Confirmed findings** → the dispatcher hands them to the implementer (fix
  mode: stay inside the plan boundary; amend the plan if a fix requires it,
  commit), then a fresh reviewer verifies and records them under
  `## Fixes applied`. Max 2 reviewer rounds, then escalate leftovers.
- **Disputed findings** → record both sides under `## Disputed`; the developer
  arbitrates at the gate.
- **Plan-vs-shipped check**: does the final shape still match the approved
  plan + amendments? Each drift becomes an amendment or an explicit decision.

## Done when
Artifact complete, fixes committed, checks green via `pipeline advance`;
present findings summary and STOP.
