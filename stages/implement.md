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
- Implement ONLY the current subtask inside the plan's write boundary and run
  the profile's checks green. Committing is OPTIONAL and the developer's call:
  never require a commit to proceed, never block on one. If the developer asked
  for commits, one commit per subtask with a message referencing it is the
  convention; otherwise leave the work uncommitted — they review and commit
  themselves.
- If it returns a **proposed plan amendment** (needed a file outside the
  boundary, or a deviation beyond mechanical detail): do NOT proceed — append
  the amendment to the plan's `## Amendments`, record it under
  `## Deviations` in `03-progress.md`, and surface it at this gate for the
  developer to approve.
- Update `03-progress.md`: check the subtask off, note what was done (+ the
  commit reference, if one was made).
- The profile is a floor, not a ceiling: also run anything else you judge
  relevant to this change. The developer must never see red.
- If `advance` blocks on a profile check for reasons you cannot map to your
  own diff — or before your FIRST change when this run has its own worktree —
  follow the pipeline's **gate-triage** skill
  (`~/.claude/skills/gate-triage/SKILL.md`): reproduce, classify, then act.
  Never hand-tune around an unclassified red.

## Done when
The subtask's code is done and `03-progress.md` updated (keep the BLUF header's
subtask count current); run `pipeline advance`
(it re-runs the profile checks and the write-boundary check — its exit code is
the certification, not your claim). On GATE: present the diff to the developer
with a short rationale per change, then STOP. Approval moves the cursor to the
next subtask (a later session picks it up) or on to TEST after the last one.
