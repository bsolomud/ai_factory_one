# Stage: PLAN

Produce an implementation plan good enough that IMPLEMENT is mechanical. The
plan's `## Affected files` becomes the enforced write boundary — be complete.

## Inputs
1. `artifacts/01-context.md` (approved — including the developer's answers).
2. The knowledge layer (same routing as CONTEXT; cite what you consult).
3. The existing code you intend to change — read it, do not guess signatures.
4. Similar merged changes in history, when discoverable — how this team solves
   adjacent problems.

## Output
`artifacts/02-plan.md`. Required sections: Approach, Affected files, Risks,
Subtasks, Testing strategy, Open questions.

## Procedure
- Choose the approach and justify it against repo conventions. Add confidence
  notes: curated-doc-backed vs inference.
- `## Affected files`: every file you expect to touch, backticked, one per
  line; files the plan creates are marked `(new)`. Validators check the
  non-new ones exist — no hallucinated paths.
- `## Subtasks`: numbered; each reviewable as ONE diff and committed as ONE
  commit.
- `## Testing strategy`: per subtask, which test type per repo conventions.
- `## Risks`: each risk here must be answerable in TEST's risk-to-test map.

## Critic loop
After drafting, spawn the **pipeline-critic** subagent (fresh context) with
`stages/plan-critic.md` plus the plan and context artifacts. Then:
- Record the round: `pipeline set-substate critic_round=<n>`.
- **Blocking findings** → revise the plan, re-run the critic. Hard cap: 2
  rounds; still blocking after round 2 → attach both artifacts' positions to
  `## Open questions` and escalate to the developer at the gate.
- **Advisory findings** → append under `## Risks` or `## Open questions`.
- Store the critique as `artifacts/02-plan-critique.md`.

## Done when
Critic clean (or escalated), sections complete, `status: complete` set LAST;
run `pipeline advance`; report gate status to the developer and STOP. The
approved plan is FROZEN — later changes are appended amendments, never rewrites.
