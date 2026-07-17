# ai_factory_one

A **repo-agnostic AI development pipeline**: ticket → context → critiqued plan →
gated implementation → tests → pre-PR review → draft PR → CI loop → retro,
driven from Claude Code (first host) with a developer approving every gate.

**Core principle — model proposes, code disposes.** The model does all judgment
work; a small deterministic CLI certifies stage transitions. `advance` re-runs
the stage's validators and refuses to move the state machine unless they exit 0.
The model can claim anything; the FSM only believes exit codes.

Design docs: `mb_rails4/pipeline-roadmap.md` (what/why),
`mb_rails4/pipeline-implementation-plan.md` (full architecture),
[`MVP-PLAN.md`](MVP-PLAN.md) (this MVP's scope + verification criteria).

## Layout

```
pipeline.yml      the state graph (FSM in data; capability slots only, no tool names)
src/              the CLI: state, validators, reconcile, guard (~6 generic verbs)
stages/           11 runbooks — the per-stage instructions the model follows
templates/        artifact skeletons with required sections
adapters/claude-code/   SKILL.md, critic/reviewer agents, guard hooks, install.sh
dist/             self-contained bundles (no node_modules at runtime)
test/             the verification suite (VC1–VC8 in MVP-PLAN.md)
```

All state lives in `~/.ai_factory_one/` (override: `$AI_FACTORY_HOME`) — **never
inside a target repo**: profiles per repo slug, runs with `state.json` +
append-only `events.jsonl` + numbered artifacts.

## Install

```bash
./install.sh --claude
```

That's it — it installs dependencies, builds the self-contained CLI, registers
the `/pipeline` skill, the six specialist agents (**planner, architect,
critic, implementer, qa, reviewer**), and the gate-guard hooks.

## Use — everything is `/pipeline ...`, typed in a Claude Code session

```
/pipeline start MB-12345            # or a link, or plain text:
/pipeline start fix the login redirect looping on expired sessions
```

Works **from any folder**: if you're not inside a repo, it lists the repos it
knows and asks which one(s) the task concerns. A feature spanning several
repos (e.g. backend + SDK) gets a linked run — and a plan — **in each repo**,
with context questions asked once and work ordered by dependency.

The pipeline reviews the task, reads the repo's knowledge, **asks you the
questions it needs answered in chat**, and writes up requirements + agreed
**acceptance criteria**. You review and say "approve" (or request changes).

```
/pipeline work
```

Each `work` invocation advances one stage, delegating to the specialists:
**planner** drafts the plan → **architect** vets the design → **critic**
attacks it (fresh context) → you approve → breakdown into subtasks →
**implementer** codes one gated subtask at a time (lint + targeted tests must
exit 0 — the CLI certifies, not the model) → **qa** maps every risk and
acceptance criterion to a test → **reviewer** does the pre-PR review → draft
PR → CI loop → retro.

```
/pipeline approve                   # shows you exactly what's under review,
                                    # waits for your explicit yes, records it
/pipeline status                    # where am I, what's next
/pipeline repos                     # repos the pipeline knows, active runs
```

Every approval requires your explicit confirmation in chat and is recorded —
with your words — in the run's audit log (`events.jsonl`).

Interruptions don't matter: kill the laptop mid-subtask and `/pipeline work`
reconstructs everything from disk (`git > artifacts > state.json`).

The model is hook-denied: `git push` before the PR gate is approved, writes to
`no_touch` paths, and edits to state files (fail-open when no pipeline run is
active — normal Claude usage is untouched).

Repo profiles are hand-written for now (see `stages/onboard.md` — the
onboarding interview runs on first `/pipeline start`; command auto-detection
is post-MVP).

## Per-repo profile (`~/.ai_factory_one/repos/<slug>/profile.yml`)

```yaml
commands:                 # capability slots — every value verified by running it
  lint_changed: "<lint command> {changed_files}"
  test_targeted: "<test command> {targeted_specs}"
  post_change_hooks:
    - { when: "generated/**", run: "<regen command>" }
test_layout: { "src/**": "tests/" }   # changed file → its tests
conventions: { base_branch: master, branch_pattern: "T-<id>" }
no_touch: ["vendored/**", "locales/!(en)/**"]
```

Empty slot → the check is skipped and recorded as **UNVERIFIED** in state and
at every gate (honesty ledger) — degrade gracefully, never fail on a missing asset.

## Development

```bash
npm test          # full suite incl. the no-AI end-to-end fake run
npm run build     # bundle dist/pipeline + dist/guard
```
