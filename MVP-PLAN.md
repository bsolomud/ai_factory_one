# ai_factory_one — MVP Plan

MVP of the AI development pipeline specified in
`mb_rails4/pipeline-implementation-plan.md` (the *how*) and `mb_rails4/pipeline-roadmap.md`
(the *what/why*). This repo is the **standalone, repo-agnostic** framework — it is never
installed inside a target repo and writes nothing into one.

**Status legend:** `[ ]` to do · `[x]` done (acceptance check passed) · `[~]` in progress

## MVP scope

**In:** implementation-plan Phase 0 (walking skeleton — the full FSM drivable with no AI
involved) + Phase 1 adapter assets (Claude Code skill, agents, guard hook, installer) +
a verification harness proving every criterion below.

**Out (deliberately, tracked for later):** onboarding auto-detection (`detect.js`, plan
P2.1–P2.5), `connectors.yml` guided setup (P2.6), live-pilot metrics (P3+). Until
onboarding exists, a per-repo `profile.yml` is written by hand (plan P1.5 allows this).

## Architecture recap (1 paragraph)

No orchestrator. A per-run `state.json` (written ONLY by the CLI) points at the current
stage; the `/pipeline` skill loads that stage's runbook from `stages/`; the runbook tells
the model what to do and ends with `pipeline advance`, which re-runs the stage's
validators and refuses to move the FSM unless they pass (*model proposes, code disposes*).
All state lives in the pipeline home (`~/.ai_factory_one/`, overridable via
`$AI_FACTORY_HOME`), never in the target repo.

## Phases & tasks

### Phase A — Walking skeleton (plan P0)

- [x] A1 Package scaffold: `package.json` (ESM, `yaml` dep), layout per plan §2.1
- [x] A2 `src/state.js` — schema-validated read, atomic write (tmp+rename), `events.jsonl` append
- [x] A3 `pipeline.yml` — full CONTEXT→SCRIBE graph exactly per plan §3.4
- [x] A4 `src/config.js` + `src/profile.js` — load graph/profile, slot resolution, `{placeholder}` substitution, glob→regex for `no_touch`
- [x] A5 `src/validators.js` — all 7 verbs (`artifact_complete`, `sections`, `files_exist_in_repo`, `profile_command`, `git_clean_within`, `min_commits_per_subtask`, `substate_set`); actionable failure messages; empty slot → skip + UNVERIFIED
- [x] A6 `src/reconcile.js` — rebuild-from-artifacts, completion-stamp detection, git-aware subtask check
- [x] A7 `src/cli.js` + `bin/pipeline` — `status | new-run | advance | approve | set-substate | reconcile`, JSON verdicts, exit 0/1, per-subtask gate loop
- [x] A8 `templates/` — 8 artifact skeletons (frontmatter + required sections matching the graph's validators)

### Phase B — Claude Code adapter (plan P1)

- [x] B1 `src/guard.js` + `bin/guard` — PreToolUse hook: deny `git push` before PR-gate approval, deny `pipeline approve` from the model, deny `git commit` outside IMPLEMENT/TEST, deny writes to `no_touch`/state files/repo-outside-write-stages; **fail open when no active run**
- [x] B2 `stages/*.md` — all 11 runbooks (capability references only, idempotent re-entry)
- [x] B3 `adapters/claude-code/` — `SKILL.md` (per plan §4), `pipeline-critic.md` + `pipeline-reviewer.md` agents, `hooks.json`
- [x] B4 `install.sh` — copy core to home, symlink skill+agents, **merge** hooks into `settings.json`; honors `$AI_FACTORY_HOME`/`$CLAUDE_HOME` so it is testable in a sandbox
- [x] B5 `npm run build` — esbuild bundles `dist/pipeline` + `dist/guard` (single files, no node_modules at runtime)

### Phase C — Verification harness

- [x] C1 Unit tests (`node --test`): state atomicity, every validator incl. failure wording, reconcile fixtures, guard rules incl. fail-open
- [x] C2 E2E fake-run test: scripted walk of the ENTIRE graph against a scratch git repo with hand-written artifacts — no AI involved
- [x] C3 Repo-agnosticism lint as a test: `pipeline.yml` + `stages/` contain no concrete tool names
- [x] C4 Install test: `install.sh` into sandbox HOME produces the expected layout; re-run is idempotent; existing `settings.json` hooks are merged, not clobbered

## Verification criteria (the MVP is "done" only when ALL pass)

| # | Criterion | Verified by |
| --- | --- | --- |
| VC1 | All unit + integration tests green | `npm test` (CI-able) |
| VC2 | A full fake run (CONTEXT→…→DONE) is drivable by CLI alone; `advance` BLOCKS with an actionable reason on incomplete artifacts, missing sections, hallucinated file paths, failing profile commands, and out-of-plan writes | `test/e2e-fake-run.test.js` |
| VC3 | Crash recovery: delete `state.json` mid-run → `status` reconstructs the correct stage from artifacts + events; kill mid-IMPLEMENT → reconcile reports the partial subtask from git | `test/reconcile.test.js` + e2e |
| VC4 | Gate discipline: `advance` cannot pass an unapproved required gate; `approve` advances; `auto_approvable` gates self-approve only when `autonomy=auto_low_risk` | e2e + unit |
| VC5 | Guard: denies `git push` pre-approval, `pipeline approve` from the model, `no_touch` writes, state-file writes; **allows everything when no run is active** (fail-open); denial message tells the model why | `test/guard.test.js` |
| VC6 | Zero repo footprint: after the full fake run, `git status --porcelain` in the target repo shows only the intended code/test files — no pipeline files | asserted inside e2e |
| VC7 | Repo-agnostic: the global layer names no tools; the same graph runs a second fake repo with a different (hand-written) profile without edits | `test/agnostic-lint.test.js` + e2e second repo |
| VC8 | Installability: sandbox install produces working `/pipeline` skill layout + merged hooks; bundled `dist/pipeline` runs the e2e with `node_modules` removed | `test/install.test.js` + build step |

**Not machine-verifiable in the MVP (manual follow-up):** a live Claude Code session
driving a real ticket (plan P1.6) — requires a human at the gates. The MVP proves the
substrate; run the live toy ticket after `install.sh`.

## Verification results (2026-07-17)

| # | Result | Evidence |
| --- | --- | --- |
| VC1 | ✅ PASS | `npm test`: **37/37** tests green (state 5, validators 13, reconcile 7, guard 5, e2e 3, lints 3, install 1) |
| VC2 | ✅ PASS | e2e walks CONTEXT→DONE via CLI only; asserted BLOCKED (exit 1) on: draft artifact, empty section, hallucinated plan path, red lint, out-of-plan write, missing commit — each with an actionable reason |
| VC3 | ✅ PASS | `state.json` deleted mid-IMPLEMENT → `status` rebuilds stage + subtask cursor from artifacts/events; interrupted-subtask and uncommitted-work notes from git |
| VC4 | ✅ PASS | unapproved gate blocks `advance`; `approve` loops subtasks then advances; `auto_low_risk` auto-approves CONTEXT but NOT the PLAN gate |
| VC5 | ✅ PASS | guard denies push/approve/no_touch/state-writes with explanatory stderr (exit 2); fail-open verified for: non-repo, no-profile, no-run, unparseable hook input |
| VC6 | ✅ PASS | after the full run: working tree clean; `master...HEAD` diff contains exactly the 2 planned files; ≥10 gate events + block events in the audit log |
| VC7 | ✅ PASS | agnostic lint over `pipeline.yml` + `stages/`; second repo with a shell-script "toolchain" (line-budget lint) runs the same graph, its own lint enforced |
| VC8 | ✅ PASS | sandbox install: layout + hook merge idempotent, pre-existing hooks preserved; `dist/pipeline` + `dist/guard` smoke-tested with `node_modules` removed (status/new-run/advance-block/guard-deny) |

## Progress log

- 2026-07-17 — repo scaffolded, plan written.
- 2026-07-17 — Phases A, B, C implemented; all 8 verification criteria pass (37/37 tests).
  Fixed during verification: runs with deleted `state.json` were invisible to `status`
  (listRuns filtered them out before reconcile could rebuild); guard path comparison broke
  on macOS `/var`→`/private/var` symlinks; `!(x)` glob negation anchored to string end
  instead of segment end; duplicated shebang in esbuild bundles.
- 2026-07-17 — **UX layer**: single-command install (`./install.sh --claude`), `/pipeline`
  subcommands (`start <ticket|link|text>` / `work` / `status` / `approve`), interactive
  CONTEXT stage with a required **Acceptance criteria** section, and the six-agent roster
  (planner, architect, critic, implementer, qa, reviewer) wired into the stage runbooks.
  37/37 tests still green; sandbox install verified end-to-end.
- **Next (post-MVP):** live toy ticket through CONTEXT→PLAN in a real Claude Code session
  (plan P1.6), then onboarding auto-detection (P2).
- 2026-07-17 — **/pipeline onboard**: CLI `onboard`+`hash` commands, mechanical asset scan
  (repo skills/commands/agent docs/knowledge dirs), three-mode skill-binding interview
  (all-from-repo / replace-all / per-skill incl. 'both'), content-hashed bindings →
  PROFILE_STALE on edit, re-onboarding prefills from the existing profile. 42/42 tests.
- 2026-07-17 — **Context isolation**: main session is a thin dispatcher; every stage (and
  onboarding) runs in its own fresh-context agent via a self-contained handoff block;
  interactive steps are two-phase (agent returns questions → developer answers → fresh
  agent writes). New agents: onboarder, context, stage-runner; planner/reviewer now write
  their artifacts directly. 42/42 tests.
- 2026-07-20 — **Pilot-readiness (suggestions #1,#3,#4,#5,#8,#10)**: removed dry_run;
  `pipeline metrics` (first-pass-green + gate-edit rates, blocked histogram, critic rounds,
  agents, feedback — from events.jsonl); `feedback`, `doctor` (profile schema), `show`,
  `abort`, `agent-start` (per-run spawn ceiling); `approve --edited` for the edit signal;
  PILOT.md playbook; multi-repo descoped to post-pilot. 50/50 tests.
- 2026-07-20 — **Express (Fast fix) autonomy**: two modes, gated | express. Express
  auto-approves quality gates (CONTEXT/PLAN/BREAKDOWN/IMPLEMENT/TEST/REVIEW) once their
  validators pass; PR and CI gates flagged human_required stay human (push is irreversible);
  validators still BLOCK on red in either mode. AI recommends the mode at the CONTEXT gate
  from scope; set-autonomy switches mid-run; approve --express shortcut. Dropped auto_low_risk.
  51/51 tests.
