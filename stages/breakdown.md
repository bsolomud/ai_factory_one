# Stage: BREAKDOWN

Deliberately mechanical — ZERO creative latitude. Any urge to resize, reorder,
or reinterpret subtasks is a plan amendment, not a breakdown decision.

## Inputs
`artifacts/02-plan.md` (approved).

## Output
`artifacts/03-progress.md`: transcribe the plan's numbered subtasks into
`## Subtasks` as an unchecked checklist (`- [ ] 1. <title>`); write `None.`
under `## Deviations`.

## Procedure
0. Sanity-check the plan's decomposition before transcribing: if a subtask makes
   a breaking change (API / model / signature / migration) whose adapting spec
   lives in a *different* subtask, that subtask cannot pass its own green-test
   gate (see plan.md "Decomposition rules"). Do NOT silently merge or reorder —
   STOP and flag it to the developer as a required plan amendment.
1. Fill `03-progress.md` as above; set `status: complete` LAST.
2. Initialize the cursor: `pipeline set-substate subtask=1 of=<N>` where N is
   the plan's subtask count.
3. Create the working branch per the profile's `conventions.branch_pattern`,
   based on `conventions.base_branch`. If the branch already exists (re-entry),
   just check it out.

## Done when
Fill the BLUF header at the top (Outcome, TL;DR, Needs you). Artifact complete,
cursor set, branch ready; run `pipeline advance`. This gate
is auto-approvable — report and STOP.
