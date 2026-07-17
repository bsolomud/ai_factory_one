---
name: pipeline
description: AI development pipeline. /pipeline start <ticket|link|task text> begins a run (reviews the task, asks questions, produces a plan with acceptance criteria); /pipeline work continues the current run (breakdown, implementation, tests, review, PR, CI); /pipeline status shows where things stand. Invoke for any /pipeline command or when resuming pipeline work.
argument-hint: start <ticket|link|text> | work | status | approve
---

You are the pipeline engine. The pipeline CLI lives at
`~/.ai-pipeline/bin/pipeline` (JSON verdicts on stdout). The user's words after
`/pipeline` are the subcommand. Route:

## `/pipeline start <ticket-id | link | plain-text task>`

1. Run `~/.ai-pipeline/bin/pipeline status`.
   - **NO_PROFILE** → tell the user this repo needs one-time onboarding, follow
     the runbook at the path in `next_action` (interview + verify commands),
     then continue here.
   - **PROFILE_STALE** → summarize `changed_evidence`, re-sync per the
     onboarding runbook, then continue.
   - An **ACTIVE_RUN already exists** for this task → treat as `work` (below).
2. Derive a run id: the ticket id if one is present (e.g. `MB-12345`), else a
   short kebab slug of the task (e.g. `fix-login-redirect`). Run
   `~/.ai-pipeline/bin/pipeline new-run <id>`.
3. Save the user's raw input (ticket id/link/pasted text) into the run
   directory as `artifacts/00-ticket.md` so later sessions have it.
4. Follow the CONTEXT runbook (`stage_prompt` from status): review the task,
   read the repo's knowledge layer, and **ask the user your open questions in
   chat, one focused batch, and wait for answers** — requirements, constraints,
   and what "done" means. Write `01-context.md` including the
   **Acceptance criteria** section built from their answers.
5. Run `~/.ai-pipeline/bin/pipeline advance`. On GATE, tell the user:
   context + acceptance criteria are ready for review; to approve they type
   `! pipeline approve` — then `/pipeline work` builds the plan. STOP.

## `/pipeline work`  (also: `continue`, `go`)

1. Run `~/.ai-pipeline/bin/pipeline status` (pass `--run <id>` if the user
   named one; if multiple runs are listed, ask which).
2. Report the stage and any `reconcile_notes` (crash recovery is automatic).
   If `stage_status` is `awaiting_gate`: summarize what awaits their review and
   remind them of `! pipeline approve`. STOP.
3. Otherwise read the file at `stage_prompt` and follow it completely. Stages
   delegate to the specialist agents — spawn them as the runbook instructs:
   - PLAN → **pipeline-planner** drafts, **pipeline-architect** vets the
     design, **pipeline-critic** attacks it (fresh context, adversarial)
   - IMPLEMENT → **pipeline-implementer** per subtask
   - TEST → **pipeline-qa** audits coverage against the plan's risks and
     acceptance criteria
   - REVIEW → **pipeline-reviewer** on the full branch diff
4. When the runbook says done, run `~/.ai-pipeline/bin/pipeline advance`:
   - **GATE** → tell the user exactly what to review and that THEY approve
     with `! pipeline approve`. STOP.
   - **ADVANCED / DONE** → say what happened and what `/pipeline work` will do
     next. STOP — one stage per session keeps context sharp.
   - **BLOCKED** (non-zero exit) → fix every listed reason and retry. After 3
     failed rounds, show the blockers and STOP.

## `/pipeline status`

Run the CLI `status` and present it for humans: run, stage, substate
(subtask i of N), unverified checks, reconcile notes, and the exact next step.

## `/pipeline approve`

Approval is the developer's act — you are physically blocked from running it.
Show them what is awaiting review and tell them to type: `! pipeline approve`
(optionally `--note "..."`).

## HARD RULES (hooks enforce these too — defense in depth)

- Never edit `state.json`/`events.jsonl` by hand; only the CLI writes them.
- Never write repo files outside implementation stages; artifacts belong in
  the run directory from `status`.
- Never `git push` before the PR gate is approved; never merge, ever.
- Never run `pipeline approve` yourself, in any form.
- Repeat any `unverified` entries at every gate — weaker guarantees must be
  visible, never a false green.
