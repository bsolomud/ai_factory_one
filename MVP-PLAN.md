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
- [x] A7 `src/cli.js` + `bin/pipeline` — `status | new-run | advance | approve | set-substate | reconcile`, JSON verdicts, exit 0/1, per-subtask gate loop (commands since extended — see Post-MVP delivered)
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
| VC4 | Gate discipline: `advance` cannot pass an unapproved required gate; `approve` advances; in `express` autonomy the quality gates self-approve once validators pass while `human_required` gates (PR/CI) still stop | e2e + unit |
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
| VC4 | ✅ PASS | unapproved gate blocks `advance`; `approve` loops subtasks then advances; `express` auto-approves quality gates once validators pass but still stops at PR (`human_required`); still BLOCKs on red |
| VC5 | ✅ PASS | guard denies push/approve/no_touch/state-writes with explanatory stderr (exit 2); fail-open verified for: non-repo, no-profile, no-run, unparseable hook input |
| VC6 | ✅ PASS | after the full run: working tree clean; `master...HEAD` diff contains exactly the 2 planned files; ≥10 gate events + block events in the audit log |
| VC7 | ✅ PASS | agnostic lint over `pipeline.yml` + `stages/`; second repo with a shell-script "toolchain" (line-budget lint) runs the same graph, its own lint enforced |
| VC8 | ✅ PASS | sandbox install: layout + hook merge idempotent, pre-existing hooks preserved; `dist/pipeline` + `dist/guard` smoke-tested with `node_modules` removed (status/new-run/advance-block/guard-deny) |

## Post-MVP — delivered (beyond the original A/B/C scope)

All shipped and test-covered (51/51 as of 2026-07-20); see Progress log for commits.

- [x] **`/pipeline onboard`** — repo analysis + three-mode skill-binding interview
  (all-from-repo / replace-all / per-skill), content-hashed bindings → `PROFILE_STALE`
  on edit, re-onboard prefills from the existing profile.
- [x] **Context isolation** — main session is a thin dispatcher; every stage (and
  onboarding) runs in a fresh-context agent via a self-contained handoff; interactive
  steps are two-phase. Nine specialist agents.
- [x] **Branded home + any-folder + multi-repo tracking** — `~/.ai_factory_one/`
  (`$AI_FACTORY_HOME`); `repos` registry, `--repo <slug>` and `NO_REPO` so `/pipeline`
  works from anywhere; multiple runs coexist, selected by `--run`.
- [x] **Chat-confirmed `/pipeline approve`** — replaced the `! pipeline approve` shell form.
- [x] **Uninstall** — `./install.sh --uninstall [--purge]`; reverses install precisely,
  keeps user work by default.
- [x] **Frictionless permissions** — install merges allow-rules for the pipeline's own
  CLI + home; command-hygiene rule so agents run plain commands (no expansion → no prompt).
- [x] **Pilot readiness** — `metrics` (first-pass-green + gate-edit rates, from
  `events.jsonl`), `feedback`, `doctor` (profile schema), `show`, `abort`, `agent-start`
  (spawn ceiling), `approve --edited`; `PILOT.md` playbook.
- [x] **Express (Fast fix) autonomy** — `gated | express`; express auto-approves quality
  gates once validators pass, keeps `human_required` gates (PR/CI); `set-autonomy`,
  `approve --express`.
- [x] **Backward transitions (`pipeline reopen <stage>`)** — sanctioned late-change path
  discovered at a post-code stage: moves the run back, drops later gate approvals, resets
  downstream artifacts to draft so TEST/REVIEW/PR re-run; guard stays correct.

## Post-MVP — planned / future (not started)

- [ ] **Live smoke run on a real ticket** (review suggestion #2) — the key next step;
  developer-triggered. Everything above only proves the substrate, not AI output quality.
- [ ] **Critic/reviewer calibration** (review suggestion #6) — done during the first live run.
- [ ] **Parallel tickets via isolated working trees.** Today the run/state model is fully
  multi-run (many tickets coexist, selected by `--run`), and tickets in non-code stages or
  in *different* repos are already parallel-safe. But two runs *actively coding* in the
  **same clone** collide: git gives one working tree/branch per checkout, and
  `guard.activeRun()` currently returns the *first* non-DONE run (directory order), so with
  ≥2 active runs it keys its write/commit/push rules off an arbitrary run. Plan:
  1. **Make the guard run-aware** — resolve the applicable run by the current branch (or
     cwd/worktree) instead of "first active", so its stage-based write rules match the run
     the developer is actually in. (Prerequisite; land before relying on concurrency.)
  2. **First-class git worktrees** — one worktree (or clone) per ticket, each with its own
     branch and working tree; the pipeline home stays shared and keyed by run id, so states
     remain isolated. Likely `pipeline worktree <run>` to create/track the tree, and record
     its path in the run so `--repo`/reconcile resolve to the right tree.
  3. Document the "one worktree per ticket" workflow in `PILOT.md`.
  Rough effort ~1 day; #1 alone removes the correctness gap even before full worktree support.
- [ ] **Onboarding auto-detection (`detect.js`)** — infer lint/test/hook commands from
  lockfiles/configs instead of the manual interview (plan P2.1–P2.5).
- [ ] **`connectors.yml` guided ticket fetch** — Jira/GitHub token setup + fetch (plan P2.6);
  today ticket input is a pasted id/link/text.
- [ ] **Profile-derived permission allow-rules** — after onboarding, add allow-rules for the
  repo's *own* verified commands (replaces the static toolchain list currently in user settings).
- [ ] **True per-agent token metrics** — the CLI can't see harness token counts; `agents_spawned`
  is the proxy. Needs harness-level instrumentation to close.
- [ ] **Multi-repo linked runs** — one feature spanning several repos with linked run ids and
  per-repo plans (descoped from pilot v1; currently run each repo as a separate ticket).

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
- 2026-07-20 — **Branding + any-folder + multi-repo tracking + chat approve** (`b501a3a`):
  home renamed `~/.ai_factory_one`; repo registry, `--repo <slug>`, `NO_REPO`; `/pipeline
  approve` replaces `! pipeline approve`; multi-repo descoped to post-pilot.
- 2026-07-20 — **Uninstall** (`8b59c89`): `./install.sh --uninstall [--purge]`, reverses
  precisely, keeps user work by default.
- 2026-07-20 — **Pilot-readiness (suggestions #1,#3,#4,#5,#8,#10)** (`2448e3b`): removed
  dry_run; `metrics`, `feedback`, `doctor`, `show`, `abort`, `agent-start`, `approve --edited`;
  PILOT.md. 50/50 tests.
- 2026-07-20 — **Express (Fast fix) autonomy** (`78f4de1`): two modes, gated | express.
  Express auto-approves quality gates once validators pass; PR and CI gates flagged
  human_required stay human (push is irreversible); validators still BLOCK on red. AI
  recommends the mode at the CONTEXT gate; set-autonomy switches mid-run; approve --express.
  Dropped auto_low_risk. 51/51 tests.
- 2026-07-20 — **Frictionless permissions** (`95235e9`, `9e695ac`): install merges allow-rules
  for the pipeline CLI + home; command-hygiene rule so agents issue plain commands.
- 2026-07-20 — Reconciled this plan with shipped state: added Post-MVP delivered/future
  sections incl. **parallel-tickets-via-worktrees**; corrected VC4 (express, not auto_low_risk).
- 2026-07-20 — **Backward transitions** (`pipeline reopen <stage>`): surfaced by a live
  portal run stuck at PR needing a one-line code change (guard correctly blocked the write).
  Backward-only; drops gate approvals from the target stage onward; resets downstream
  artifacts to draft so TEST/REVIEW/PR re-run instead of sailing past stale `complete`
  stamps. SKILL documents it as the late-change path. 52/52 tests; rebuilt + reinstalled live.
- 2026-07-20 — **First full live run (portal MB-46498)** reached SCRIBE + PR #988. Metrics:
  first-pass-green 0.89 (8/9), gate-edit-rate 0.06 (1/18), critic caught 2 real bugs (race
  window in atomic-disable, spec not reproducing the named crash frame), 26 agents, ~2.8h wall.
  Two feedback gaps both ALREADY shipped (express, reopen). Fixed from this run's evidence:
  (1) metrics undercounted critic_rounds (said 0; critic ran 2 rounds) — now derives from
  critic agent spawns + adds agents_by_label; (2) test_targeted 'no files' skip reworded as
  benign + split checks_skipped into no_command (real gap) vs no_target (bookkeeping). 54 tests.
