# Stage: PLAN

Produce an implementation plan good enough that IMPLEMENT is mechanical. The
plan's `## Affected files` (a table: Path | Change | New?) becomes the enforced
write boundary — keep every path backticked, and be complete.

**Execution model**: the dispatcher orchestrates three fresh-context
specialists — **pipeline-planner** owns and writes the artifact
(draft → revise → finalize modes), **pipeline-architect** vets the design,
**pipeline-critic** attacks it adversarially. Each agent reads this runbook
and the artifacts from disk; only findings summaries travel between them.

## Inputs
1. `artifacts/01-context.md` (approved — requirements, acceptance criteria,
   the developer's answers).
2. The knowledge layer (same routing as CONTEXT; cite what you consult).
3. The existing code to change and similar merged changes in history.

## Output
`artifacts/02-plan.md`. Required sections: Approach, Affected files, Risks,
Subtasks, Testing strategy, Open questions.

## Decomposition rules (load-bearing — `advance` gates every subtask on green)
A breaking change and the spec that adapts to it MUST be the **same subtask**.
`advance` runs the targeted specs at every subtask gate, so a change and the
test that certifies it have to land together — split them and the breaking
subtask can never pass its own gate in isolation (MB-46745: a model change and
its spec-rewrite were split, and the change subtask blocked repeatedly).
- Never separate an API / model / signature / migration change from the specs it
  breaks. If updating file X forces spec Y to change, X and Y are one subtask.
- Each subtask must be independently green: it compiles, its specs pass, nothing
  downstream is left red waiting for a later subtask.
- Prefer fewer, self-certifying subtasks over many that only pass as a set.
- These rules are machine-checked at `advance` (`subtask_coupling`): write
  `## Subtasks` as a table (# | Subtask | Files) where Files is that subtask's
  slice of `## Affected files`. Every affected file must be claimed by exactly
  one subtask, and a file's mapped spec must sit in the same subtask as the file.

## Procedure (choreography — the dispatcher drives the sequence)
1. **Draft** (`pipeline-planner`, mode draft): write the full plan into
   `02-plan.md` (status stays `draft`), grounded in read code, routed
   knowledge, and merged-change history.
2. **Design check** (`pipeline-architect`): pattern fit, boundaries, blast
   radius, simpler-design check. SOUND → continue; RECONSIDER → planner
   revises (or the disagreement goes under `## Open questions`).
3. **Adversarial check** (`pipeline-critic`, per `stages/plan-critic.md`):
   - The dispatcher records each round: `pipeline set-substate critic_round=<n>`.
   - **Blocking findings** → planner revises (mode revise), fresh critic
     re-checks. Hard cap 2 rounds; still blocking → both positions attached
     to `## Open questions`, escalated to the developer.
   - **Advisory findings** → folded into `## Risks` / `## Open questions`.
   - The critique is stored as `artifacts/02-plan-critique.md`.
4. **Finalize** (`pipeline-planner`, mode finalize): verify traceability —
   every acceptance criterion → a subtask + a testing-strategy entry; every
   non-`(new)` affected file exists.

## Done when
Fill the BLUF header at the top (Decision, Files/Subtasks/Critic counts, TL;DR,
Needs you). Critic clean (or escalated), sections complete, `status: complete` set LAST;
run `pipeline advance`; present the plan summary (approach, subtasks, risks,
open questions) — the developer approves with `! pipeline approve`, then
`/pipeline work` starts the breakdown. STOP. The approved plan is FROZEN —
later changes are appended amendments, never rewrites.
