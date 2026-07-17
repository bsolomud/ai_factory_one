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

All state lives in `~/.ai-pipeline/` (override: `$AI_PIPELINE_HOME`) — **never
inside a target repo**: profiles per repo slug, runs with `state.json` +
append-only `events.jsonl` + numbered artifacts.

## Install

```bash
npm install && npm run build
./adapters/claude-code/install.sh
```

Then in any repo, in a Claude Code session: `/pipeline`.
- No profile yet → onboarding (hand-written `profile.yml` for now — see
  `stages/onboard.md`; auto-detection is post-MVP).
- Active run → resumes exactly where it left off, after crash/interrupt too
  (`git > artifacts > state.json` — every session reconstructs from disk).
- Gates are yours: when the CLI says `GATE`, you review and type
  `! pipeline approve`. The model is physically denied `pipeline approve`,
  `git push` before the PR gate, writes to `no_touch` paths, and edits to
  state files (PreToolUse hooks, fail-open when no run is active).

## Per-repo profile (`~/.ai-pipeline/repos/<slug>/profile.yml`)

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
