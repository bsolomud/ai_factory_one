# Stage: PLAN

Produce an implementation plan good enough that IMPLEMENT is mechanical. Three
specialists collaborate; you orchestrate and own the artifact. The plan's
`## Affected files` becomes the enforced write boundary — be complete.

## Inputs
1. `artifacts/01-context.md` (approved — requirements, acceptance criteria,
   the developer's answers).
2. The knowledge layer (same routing as CONTEXT; cite what you consult).
3. The existing code to change and similar merged changes in history.

## Output
`artifacts/02-plan.md`. Required sections: Approach, Affected files, Risks,
Subtasks, Testing strategy, Open questions.

## Procedure
1. **Draft — spawn `pipeline-planner`** with: the context artifact path, the
   repo root, the knowledge routing. It returns the full plan draft. Write it
   into `02-plan.md` (status stays `draft`).
2. **Design check — spawn `pipeline-architect`** on the draft: pattern fit,
   boundaries, blast radius, simpler-design check. SOUND → continue;
   RECONSIDER → revise the draft (or record the disagreement under
   `## Open questions` for the developer).
3. **Adversarial check — spawn `pipeline-critic`** (fresh context) with
   `stages/plan-critic.md`, the plan, and the context artifact:
   - Record the round: `pipeline set-substate critic_round=<n>`.
   - **Blocking findings** → revise, re-run the critic. Hard cap 2 rounds;
     still blocking → attach both positions to `## Open questions`, escalate.
   - **Advisory findings** → fold into `## Risks` / `## Open questions`.
   - Store the critique as `artifacts/02-plan-critique.md`.
4. Verify traceability yourself: every acceptance criterion → a subtask +
   a testing-strategy entry; every non-`(new)` affected file exists.

## Done when
Critic clean (or escalated), sections complete, `status: complete` set LAST;
run `pipeline advance`; present the plan summary (approach, subtasks, risks,
open questions) — the developer approves with `! pipeline approve`, then
`/pipeline work` starts the breakdown. STOP. The approved plan is FROZEN —
later changes are appended amendments, never rewrites.
