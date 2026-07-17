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

## Procedure (executed by `pipeline-implementer`, fresh context per subtask)
- Implement ONLY the current subtask inside the plan's write boundary, run
  the profile's checks green, and commit it as ONE commit (recovery depends
  on one-commit-per-subtask).
- If it returns a **proposed plan amendment** (needed a file outside the
  boundary, or a deviation beyond mechanical detail): do NOT proceed — append
  the amendment to the plan's `## Amendments`, record it under
  `## Deviations` in `03-progress.md`, and surface it at this gate for the
  developer to approve.
- Update `03-progress.md`: check the subtask off, note what was done + commit.
- The profile is a floor, not a ceiling: also run anything else you judge
  relevant to this change. The developer must never see red.

## Done when
The subtask is committed and `03-progress.md` updated; run `pipeline advance`
(it re-runs the profile checks and the write-boundary check — its exit code is
the certification, not your claim). On GATE: present the diff to the developer
with a short rationale per change, then STOP. Approval moves the cursor to the
next subtask (a later session picks it up) or on to TEST after the last one.
