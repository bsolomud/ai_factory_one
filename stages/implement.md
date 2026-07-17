# Stage: IMPLEMENT (loops once per subtask)

Work on EXACTLY ONE subtask: the one at `substate.subtask` (see
`pipeline status`). The developer gates every diff. This may be a re-entry:
reconcile notes in `status` tell you if the current subtask has partial
uncommitted work — review it against the plan and continue rather than
starting over.

## Inputs
1. `artifacts/02-plan.md` (approved, incl. `## Amendments`) — the contract.
2. `artifacts/03-progress.md` — what's done so far.
3. The repo's pattern/convention docs via the profile's bindings.

## Procedure
- Before writing code: search for existing helpers/methods that already do the
  job — never reinvent what the codebase provides.
- Implement ONLY the current subtask, matching surrounding code style.
- Stay inside the plan's `## Affected files` (plus their tests). The write
  boundary is enforced; needing a file outside it means: pause, append a plan
  amendment, get it approved at this gate first.
- A deviation beyond mechanical detail → record under `## Deviations` and
  propose an amendment; do not silently diverge.
- Run the profile's `lint_changed` and `test_targeted` commands yourself as
  you go — plus anything else you judge relevant to this change (the profile
  is a floor, not a ceiling). The developer must never see red.
- Commit the subtask as ONE commit (recovery depends on one-commit-per-subtask).
- Update `03-progress.md`: check the subtask off, note what was done + commit.

## Done when
The subtask is committed and `03-progress.md` updated; run `pipeline advance`
(it re-runs the profile checks and the write-boundary check — its exit code is
the certification, not your claim). On GATE: present the diff to the developer
with a short rationale per change, then STOP. Approval moves the cursor to the
next subtask (a later session picks it up) or on to TEST after the last one.
