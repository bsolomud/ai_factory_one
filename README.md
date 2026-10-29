# ai_factory_one

A **repo-agnostic AI development pipeline**: ticket → context → critiqued plan →
gated implementation → tests → pre-PR review → draft PR → CI loop → retro,
driven from Claude Code (first host) with a developer approving every gate.

**Core principle — model proposes, code disposes.** The model does all judgment
work; a small deterministic CLI certifies stage transitions. `advance` re-runs
the stage's validators and refuses to move the state machine unless they exit 0.
The model can claim anything; the FSM only believes exit codes.

**Second principle — the artifact's own claims must be falsifiable.** A pipeline
artifact is a pile of claims; a reviewer arrives with evidence, and the PR review
round is where the two finally meet. So the round count tracks the number of
unproven claims, which code quality does not bound. Measured on two pilot PRs:
23 reviewer findings, of which **12 were on code written to fix the other 11**,
and the blockers were never "this line is wrong" but "this is coupled to
something outside your diff". Three gates close that gap:

| Gate | Stage | What it makes falsifiable |
|------|-------|---------------------------|
| `evidence_verified` | PLAN, REVIEW | The plan's `## Coupling` table — who else writes/reads what you changed. Each row records a read-only search and the count it printed; **`advance` re-runs the command and compares**. A claim that cannot survive its own command is not evidence, and a count that drifted means the ground moved under the claim. |
| `ac_proofs` | TEST | Each acceptance criterion's test was **watched to go red** without the fix (`{ ac, test, mutation }`). `pipeline proof-stamp` hashes the code under test, so the ledger **expires** when that code changes — which is what stops a fix round from inheriting a proof its own change invalidated. |
| `ac_population` | CONTEXT | Every criterion names the population it is about (`new` / `existing` / `both` / `n-a`) — the question that separates a shipped fix from a fix to the writer only. |

REVIEW also runs **blind first**: pass A sees the diff and the repo but not the
plan, because handing a reviewer the implementer's rationale hands it the
implementer's blind spots. The plan is opened only for pass B's plan-vs-shipped
check. The `change-probes` skill turns a diff into the searches that fill
`## Coupling`.

**Third principle — a round you did not record is a round you cannot remove.**
The goal is that any task closes in **≤2 rounds**, and the rounds that decide it
arrive from outside the run: a reviewer on the PR, a red CI. So they are a
first-class ledger (`pipeline round` / `pipeline finding`), and every finding
carries a **`missed_by`** — the name of the search that *would* have caught it
before the code existed. SCRIBE must leave the repo with a probe of that name,
`pipeline probes` hands it to the next planner matched against their diff, and
the plan's `## Coupling` table cites it. That loop is the only mechanism here
that lowers the round count over time; the gates above only stop it rising.

REVIEW itself runs until a round comes back clean (`review_converged`): a fresh
reviewer per round, and advisory or pre-existing findings count, because the PR
reviewer raises them anyway. A finding ends fixed, refuted (`--rejected`), or
deferred by the developer with a sentence the PR carries (`--deferred`,
`deferred_in_pr`). Measured 2026-10-29: the PRs on this team that merge without
comments come from exactly that loop, run before the PR opens.

Its absence was the measurable asymmetry: a repo's review skill accretes a rule
per retrospective (one pilot repo's cites 397 PR numbers), while the
implementing side accreted nothing — 10 knowledge facts across 29 runs, none of
them carrying a command, so not one could be cited by the section it was written
to inform.

Design docs: [`MVP-PLAN.md`](MVP-PLAN.md) (this MVP's scope + verification criteria).

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
the `/pipeline` skill, the nine specialist agents (**onboarder, context,
planner, architect, critic, implementer, qa, reviewer, stage-runner**), and
the gate-guard hooks.

### Addons

```bash
./install.sh --claude --with=codebase-memory-mcp
```

Optional third-party integrations live under `adapters/claude-code/addons/`;
`--with` takes a comma-separated list. Every addon is idempotent — an
already-installed binary or an already-merged setting is detected and
skipped, so `--with` is safe to repeat on every update.

**codebase-memory-mcp** ([DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp))
gives the research agents (context, planner, architect, critic, reviewer, qa)
a local code graph: call-chain tracing, symbol search, diff→affected-symbols
mapping. The addon installs the upstream binary, registers the MCP server in
`~/.claude.json`, and pre-approves ONLY its read-only query tools. Index each
repo once (`codebase-memory-mcp cli index_repository --repo-path <repo>` —
one repo at a time, not a parent folder); the background watcher keeps the
index fresh. Runs work in their own worktrees, which the index does not
cover: `pipeline status` names the main checkout's project as the run's
`code_graph`, with the snapshot commit and how many files the run's tree has
moved since, and the handoff passes that line to every research agent. Agents
fall back to plain grep when a repo isn't indexed, so nothing breaks without
it.

> **`command not found` after installing?** The upstream installer puts the
> binary in `~/.local/bin`, which is NOT on the default macOS PATH. Claude
> sessions are unaffected (the MCP registration uses the absolute path);
> for your own shell run:
> `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bash_profile && source ~/.bash_profile`

### Uninstall

```bash
./install.sh --uninstall           # removes skill, agents, guard hooks, CLI —
                                   # KEEPS your profiles/runs/knowledge
./install.sh --uninstall --purge   # removes everything, including your work
```

Reverses the install exactly: unlinks the skill and `pipeline-*` agents,
removes only *our* guard hooks from `settings.json` (your other hooks and
settings are untouched), and deletes the framework files from
`~/.ai_factory_one/`. By default your work under `~/.ai_factory_one/repos/`
(profiles, runs, learned knowledge) is preserved; `--purge` deletes that too.
Addon permission rules are unmerged as well; addon binaries and their MCP
registrations are left installed — they are user-level tools, usable outside
the pipeline.

**Context isolation by design**: your main session is only a dispatcher —
your conversation never leaks into the agents, and their work never floods
your context. Every stage runs in its own fresh agent that receives a small
self-contained handoff (repo, run id, artifact paths, your answers verbatim
where needed) and reads everything else from disk, returning a ≤30-line
summary. Interactive steps (onboarding, context questions) run in two phases:
the agent returns its questions, you answer in chat, a fresh agent gets your
answers and writes the result.

## Use — everything is `/pipeline ...`, typed in a Claude Code session

```
/pipeline start ABC-12345           # or a link, or plain text:
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

### Two speeds: Gated vs Fast fix

At the context gate the pipeline recommends a mode based on the scope it sees:

- **Gated** (default) — you approve every stage.
- **Fast fix (express)** — the *quality* gates (plan, implement, test, review)
  auto-approve **once their validators pass**, so a small change flows straight
  through; you approve just **once, at the PR gate**, before anything is pushed.

The line is deliberate: express drops the redundant human sign-off on gates the
deterministic checks already enforce (lint/tests/write-boundary still gate on
red — express never bypasses a validator), but keeps you in control of the
irreversible steps — the push at PR and any CI fix are always human-approved,
and merge is never automated. Switch either way mid-run with
`/pipeline set-autonomy` if the scope turns out different than it looked.

Each `work` invocation advances one stage (or several, in express),
delegating to the specialists:
**planner** drafts the plan → **architect** vets the design → **critic**
attacks it (fresh context) → you approve → breakdown into subtasks →
**implementer** codes one gated subtask at a time (lint + targeted tests must
exit 0 — the CLI certifies, not the model) → **qa** maps every risk and
acceptance criterion to a test → **reviewer** does the pre-PR review → draft
PR → CI loop → retro.

```
/pipeline approve [--express]       # approve the gate; --express switches to
                                    # Fast fix (below) as you approve context
/pipeline set-autonomy gated|express   # switch modes any time mid-run
/pipeline request-changes --note "…"   # decline a gate: records the correction
                                       # (human_rounds metric) + reopens the stage
/pipeline pr-feedback [<pr>]        # triage reviewer comments on the open PR:
                                    # accepted → reopen + gated rework;
                                    # rejected/answered → drafted replies
/pipeline onboard <path>            # analyze a repo + bind its skills (below)
/pipeline status                    # where am I, what's next
/pipeline show                      # the current artifact/diff, for review
/pipeline repos                     # repos the pipeline knows, active runs
/pipeline feedback "<note>"         # capture a reaction (feeds retro + metrics)
/pipeline metrics                   # rounds-to-merge and the quality signals
/pipeline probes [--lint]           # searches this repo learned; audit the store
/pipeline doctor [--env]            # validate the profile / the working tree
```

Stage agents also use a few verbs directly, and they matter enough to name here:

| Verb | What it is for |
|------|----------------|
| `pipeline check` | The **dry run**: the gate's own validators, nothing recorded, no round-trip. Every stage runbook requires it before `advance` — 67 of the pilot's 81 blocked events were defects a stage could have found itself, for free. |
| `pipeline amend-boundary <path> --reason` | The change needs a file the approved plan did not foresee. Appends one audited line to `## Amendments` (the approved sections stay frozen) and the boundary check honors it. `no_touch` is still refused. The boundary was **816 of 887** recorded block reasons. |
| `pipeline allow-touch --commit <sha> --reason` | A commit the developer explicitly asked for changed `no_touch` files (e.g. regenerated API docs). Exempts exactly that commit's content from `no_touch` — a later edit is caught again — logged as `touch_allowed` and appended to `## Amendments`. |
| `pipeline pr-opened <url\|number>` | Right after the PR is opened: records its number, url and the head it was opened at; `pipeline status` shows it as `pr` for CI and PR feedback. |
| `pipeline base-health` | A run stacked on a branch other than the trunk: asks the base's own CI whether it is red by itself, so inherited failures read as "base red". TEST requires it on a stacked run. |
| `pipeline decision-changed --was "…" --now "…" --reason "…"` | The developer reversed an earlier decision. Appends it to the plan's `## Amendments`; the PR draft must then state the new decision word for word, and a PR published before the change must be re-published (`pr-opened` again) before the CI gate passes. |
| `pipeline round` / `pipeline finding` | The round ledger above. `--missed-by` names the probe the store owes; `--round <n> --rejected` or `--deferred "<sentence for the PR>"` settles a finding of a closed round. |
| `pipeline retro collect\|finish\|list` | The review retro's data side (see `/pipeline-retro`): gathers reviewer comments on closed run PRs into a private batch, and records them as looked at once the proposals are NDA-clean. |
| `pipeline nda-check [--self <files>]` | The NDA line, mechanically. Default: the retro proposals, strictly. |
| `pipeline permissions [--merge]` | Host allow-rules derived from the repo's own verified commands. Emit-only unless asked. |

Piloting it? See **[PILOT.md](PILOT.md)** for the run-one-ticket playbook and
how to read the metrics.

Every approval requires your explicit confirmation in chat and is recorded —
with your words — in the run's audit log (`events.jsonl`).

Interruptions don't matter: kill the laptop mid-subtask and `/pipeline work`
reconstructs everything from disk (`git > artifacts > state.json`).

The model is hook-denied: `git push` before the PR gate is approved, writes to
`no_touch` paths, and edits to state files (fail-open when no pipeline run is
active — normal Claude usage is untouched).

## Review retro — `/pipeline-retro`, and the NDA line

The per-repo knowledge SCRIBE writes is the project's: its conventions, its
probes, its code. `/pipeline-retro` harvests the other kind of lesson, the one
about the **tool**: what reviewers found on the pipeline's closed PRs, set
against what the pipeline's own review found before each PR opened. For every
miss it decides where the pipeline should have caught it and how (a stage, a
reviewer step, a validator), and writes **generic proposals** to
`~/.ai_factory_one/retro/proposals.md`. You accept or decline each one; the
accepted ones are built in an ai_factory_one session, with tests.

You run it by hand. It is standalone: it never touches a run, a stage, a
project repo or the pipeline's source. Its raw evidence
(`~/.ai_factory_one/retro/batches/`) stays on your machine.

The projects the pipeline runs on are under NDA, and the tool is shared, so
what crosses from a project into the tool is checked by `pipeline nda-check`:
- **Strict** (the retro proposals; `pipeline retro finish` refuses until it
  passes): no ticket ids, PR numbers, addresses, links, code blocks, project
  paths, names of an onboarded org, repo or reviewer, nor any identifier or
  uncommon word that occurs in a project's tracked files and not in the tool's
  own text.
- **`--self <files>`** (the tool's source): ticket ids, PR numbers, addresses
  and the named terms. A test runs the pattern half on every commit; the named
  half needs the projects on the machine, so run `pipeline nda-check --self
  $(git ls-files)` before pushing.
- `~/.ai_factory_one/nda-terms.txt`: your own list of names that must never
  appear (product names, clients), one per line. It never leaves the machine.

## Onboarding — `/pipeline onboard <path to repo>`

One interview makes any repo pipeline-ready (it also runs automatically on the
first `/pipeline start` in an unknown repo). The pipeline analyzes how to work
with the repo (lint/test/hook commands — each verified by actually running
it), scans for **repo-local AI assets** (`.ai/skills/`, `.claude/skills/`,
`.claude/commands/`, `CLAUDE.md`/`AGENTS.md`, `doc/ai/`), and asks you the
binding question per capability (plan, review, test, ci, knowledge):

1. **Use all from repo** — repo skills win wherever they exist
2. **Replace all** — ai_factory_one built-ins everywhere
3. **Decide per skill** — repo / built-in / both, row by row

Bindings are content-hashed: if someone edits a bound repo skill, the next
run reports the profile as stale and asks you to re-confirm. **Re-run
`/pipeline onboard` any time** to change any choice — it prefills from your
current profile and never silently drops an earlier answer.

## Per-repo profile (`~/.ai_factory_one/repos/<slug>/profile.yml`)

```yaml
commands:                 # capability slots — every value verified by running it
  lint_changed: "<lint command> {changed_files}"
  test_targeted: "<test command> {targeted_specs}"
  post_change_hooks:
    - { when: "generated/**", run: "<regen command>" }
  env_checks:             # can this CHECKOUT run the repo at all? (pipeline doctor --env)
    - { name: "built assets present", run: "<cheap check>", fix: "<the repairing command>" }
test_layout: { "src/**": "tests/" }   # changed file → its tests
test_file_pattern: "(_test|_spec|\\.test|\\.spec)\\.[^./]+$"  # optional — what counts as a runnable test file (default shown); helpers/factories under test dirs never run
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

CI (`.github/workflows/ci.yml`) runs the suite on Node 20 and 22, builds the
bundle, and runs it with `node_modules` deleted — the shape every installed copy
actually takes.

**Before adding another validator, pilot the ones already here.** The evidence
gates (`evidence_verified`, `ac_proofs`, `ac_population`) are the newest and the
strongest idea in the repo, and they have run on 3 of 29 recorded runs — they
have no field data yet. Give them five real runs and report what they caught
against what they false-blocked. A gate added on top of an unmeasured gate is
how a pipeline accumulates friction it can never justify removing.
