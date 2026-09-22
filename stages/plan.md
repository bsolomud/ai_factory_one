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
2. The knowledge layer (same routing as CONTEXT; cite what you consult, and
   record each consulted item: `pipeline used knowledge <fact>` / `used doc <path>`).
3. The existing code to change and similar merged changes in history.

## Output
`artifacts/02-plan.md`. Required sections: Approach, Affected files, Coupling,
Risks, Subtasks, Testing strategy, Open questions.

## The coupling ledger (the section that decides the review round count)
Measured on two pilot PRs: of 23 reviewer findings, the blockers were almost
never "this line is wrong". They were "this is coupled to something outside your
diff" — a sibling integration carrying the identical gap, a downstream reader of
the value you changed, a framework-implicit scope that makes a query lie, state
your change persists and a LATER run reads back, rows already in production that
no writer will ever revisit. Every one of them was findable with a search before
the PR existed. `## Coupling` is that search, written down.

One row per symbol this change writes, removes, or changes the meaning of:
`Subject | Evidence command | Hits | Disposition`. **`advance` re-runs each
command and compares its line count against Hits** — so record a read-only
search (`git grep` / `grep` / `rg`, no shell operators) and the number of lines
it really printed. A claim that cannot survive its own command is not evidence.

**Start from what this repo has already learned**: `pipeline probes` returns the
probes whose file-shape matches this change — searches that cost this repo a
review round once and were written down so they never cost another. Run each,
put the REAL hit count in the table, and dispose of what it returns. It also
prints them pre-formatted as `## Coupling` rows. If it returns nothing, that is
information too: this change is in territory the store has never been burned in.

Then widen with the generic list: the pipeline's **change-probes** skill
(`~/.claude/skills/change-probes/SKILL.md`) carries the six probes with the
command shape and the real finding behind each; use it to build the remaining
rows and record `pipeline used skill change-probes`.

Work the list; give every question that applies a row:
- who else **writes** this? (the sibling path carrying the same gap)
- who **reads** it downstream, and does a stale or absent value break them?
- does the model carry an **implicit scope** (soft-delete, default scope) that
  makes this query quietly answer a different question than you think?
- is the value **persisted** and read back on a later run or another entry point?
- what becomes **newly reachable** — or newly unreachable — because of this?
- what used to fail **loudly** here and would now fail silently?

`Hits: 0` is a real and often decisive answer: it is how you prove nothing else
writes a column, which is how you find out there is no backfill. Disposition
must say what the hits MEAN — an undispositioned hit is an unread caller.

## Decomposition rules (load-bearing — `advance` gates every subtask on green)
A breaking change and the spec that adapts to it MUST be the **same subtask**.
`advance` runs the targeted specs at every subtask gate, so a change and the
test that certifies it have to land together — split them and the breaking
subtask can never pass its own gate in isolation (seen in a pilot run: a model
change and its spec-rewrite were split, and the change subtask blocked repeatedly).
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
   - **Zero blocking findings in round 1** → skip the re-check entirely: pass
     the advisory findings to Finalize and continue. The second round exists
     to verify fixes to blocking findings, not to re-read a clean plan.
   - **Advisory findings** → folded into `## Risks` / `## Open questions`.
   - The critique is stored as `artifacts/02-plan-critique.md`.
4. **Finalize** (`pipeline-planner`, mode finalize): verify traceability —
   every acceptance criterion → a subtask + a testing-strategy entry; every
   non-`(new)` affected file exists. Then **self-certify before declaring done**:
   run `pipeline check` and fix what it reports. It runs the exact validators
   the gate will run, records nothing, and costs no round-trip — where
   `advance` costs a blocked event and a fresh dispatch. Nearly every PLAN
   block in the pilot was a decomposition or path defect this check names for
   free: a file in `## Subtasks` that is not in `## Affected files`, a source
   file whose spec sits in a different subtask, a path that does not exist.

## Done when
`pipeline check` is GREEN apart from the finalization stamp. Fill the BLUF
header at the top (Decision, Files/Subtasks/Critic counts, TL;DR,
Needs you). Critic clean (or escalated), sections complete, `status: complete` set LAST;
run `pipeline advance`; present the plan summary (approach, subtasks, risks,
open questions) — the developer approves with `! pipeline approve`, then
`/pipeline work` starts the breakdown. STOP. The approved plan is FROZEN —
later changes are appended amendments, never rewrites.
