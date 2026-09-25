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
- **Check before you claim.** Run `pipeline check` when the subtask looks done:
  same validators as the gate, nothing recorded, no round-trip. `advance` is for
  certifying finished work, not for finding out what is wrong with it.
- The subtask genuinely needs a file the approved plan never listed → do NOT
  hand-edit the approved plan (it is frozen) and do NOT quietly work around the
  boundary. Widen it on the record:
  `pipeline amend-boundary <path> --reason "<why this change needs it>"`. That
  appends one line to the plan's `## Amendments`, is audit-logged, and is
  honored by the boundary check immediately. Then record it under
  `## Deviations` in `03-progress.md` and **surface it at this gate** — the
  developer approved a plan that did not include this file, and they get to see
  that it grew. A `no_touch` path is refused outright; no amendment overrides it.
- If the implementer returns a **deviation beyond mechanical detail** (a design
  change, not just an extra file): do NOT proceed — append the amendment to the
  plan's `## Amendments`, record it under `## Deviations`, and surface it at this
  gate for the developer to approve.
- Update `03-progress.md`: check the subtask off, note what was done (+ the
  commit reference, if one was made).
- The profile is a floor, not a ceiling: also run anything else you judge
  relevant to this change. The developer must never see red.
- **Before your FIRST change when this run has its own worktree**, run
  `pipeline doctor --env`. A fresh tree that cannot build assets or find a
  generated config fails a gate in the language of a broken change, and
  diagnosing that from inside a stage has cost real runs whole sessions. Repair
  the tree first (the report names the fix command per check); a red gate after
  a green env report is about your diff.
- A boundary block carrying a **BASE CHECK** line is not about your diff: it
  means files you never touched are being reported because the run's base is
  behind the branch this work sits on. Do not revert them and do not widen the
  boundary around them — fix the base (`pipeline set-base <branch>`) and
  re-advance; the reasons disappear with it.
- If `advance` blocks on a profile check for reasons you cannot map to your
  own diff, follow the pipeline's **gate-triage** skill
  (`~/.claude/skills/gate-triage/SKILL.md`): reproduce, classify, then act.
  Never hand-tune around an unclassified red.

## Done when
The subtask's code is done, `pipeline check` is green, and `03-progress.md`
updated (keep the BLUF header's
subtask count current); run `pipeline advance`
(it re-runs the profile checks and the write-boundary check — its exit code is
the certification, not your claim). On GATE: present the diff to the developer
with a short rationale per change, then STOP. Approval moves the cursor to the
next subtask (a later session picks it up) or on to TEST after the last one.
