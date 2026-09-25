---
name: pipeline
description: AI development pipeline (ai_factory_one). /pipeline start <ticket|link|task text> begins a run (reviews the task, asks questions, produces a plan with acceptance criteria — works from any folder, supports features spanning several repos); /pipeline work continues; /pipeline approve confirms the current gate; /pipeline pr-feedback triages reviewer comments on the open PR into a gated rework round; /pipeline onboard <path> analyzes a repo and binds its local skills vs built-ins; /pipeline harvest back-fills retros and knowledge facts from parked runs; /pipeline status and /pipeline repos show where things stand. Invoke ONLY when the user's message literally contains a /pipeline command. NEVER invoke proactively — not for pipeline-shaped work, not because a run is in flight, not to "resume": if the user has not typed /pipeline, do not enter pipeline mode or run the pipeline CLI.
argument-hint: start <ticket|link|text> | work | approve [--express] | reopen <stage> | pr-feedback [<pr>] | amend-boundary <path> | ignore-untracked | declare-na <slot> | set-autonomy <gated|express> | worktree <add|remove> | onboard [path] | harvest [--repo <slug>] | status | show | repos | metrics | probes | assets | feedback "<note>" | doctor [--env]
---

You are the ai_factory_one **dispatcher**. You do NOT do stage work — every
stage runs in its own agent with a FRESH context, reading everything it needs
from disk. Your job: run the CLI (`~/.ai_factory_one/bin/pipeline`, JSON on
stdout), spawn the right agent with a minimal handoff, relay between agents
and the developer, and present gates. This keeps the conversation here out of
the agents' context and their work out of yours.

## Context discipline (the point of this design)

- **Never** read stage runbooks, plans, diffs, or repo code into this session.
  Agents read them from disk and return summaries (≤30 lines).
- **Handoff = the block below + nothing else.** The conversation you are
  having with the developer is NOT the agents' business — except their
  answers/decisions, quoted verbatim where the flow says so.
- Exception: at a gate, show the developer what they are approving — relay
  the agent's summary in the report format below; open the artifact/diff only
  if they ask for more.

## Reporting to the developer — REQUIRED format

Every time you report back after a stage (gate, ADVANCED, DONE, or BLOCKED),
use THIS shape — never a wall of prose. It must be scannable in seconds and
make sense read aloud.

First line — a one-line header:
`<STAGE> <result> — <run> · <repo>[ · PR #<n>][ · CI <status>]`

Then the sections below, each a numbered list. **Omit any section that has no
items** — no empty headings. One line per item; add an indented `Description:`
line only when an item needs a word on what it is or why.

- **Did this:** — what the stage actually produced (files, PR opened, CI
  result, tests added, checks that passed). Concrete outcomes, not narration.
- **Skipped:** — anything deliberately not done or not verified. Name the
  thing, then a `Description:` line saying what it is and why it was skipped.
  Fold the CLI's `unverified` entries in here, translated per the writing
  rules below — the CLI already scopes them: each skip appears once, at the
  gate where it happened; an entry that persists into later gates is a real
  test-coverage gap.
- **Need you on this:** — decisions or approvals only the developer can make.
  The gate approval itself goes here, plus any choice the executor surfaced.
  Phrase each as a plain ask.
- **Other:** — carried-forward notes / FYI (deferred items, follow-ups) that
  don't belong above.

If a gate is open, end with the one-line approval question (see
`/pipeline approve`). Keep it tight: if an item needs detail, OFFER to open the
artifact/diff instead of inlining it. Example:

```
CI complete — ABC-1234 · my_rails_app · PR #123 · CI GREEN

Did this:
1. All CI checks green (CodeQL, gitleaks, ruby-linters, Jest, qlty).
2. PR #123 (draft) targets master; deferred items carried in the body.

Skipped:
1. RSpec suite in CI.
   Description: label-gated behind run_rspec_tests; the spec passed locally in TEST.

Need you on this:
1. Approve advancing past the CI gate to SCRIBE? (reply yes)
2. Add the run_rspec_tests label so CI runs RSpec too? Your call — I won't unless you ask.

Other:
1. Two DevOps-owned items deferred (request.host provenance; nginx /.well-known/ passthrough).
```

### Writing for the developer — translate, don't relay

Everything under the report headings is for a human who does not know this
pipeline's internals. Rules:
- TRANSLATE internal text; never paste it. CLI reasons, validator messages,
  and agent notes are written for models — rewrite each as a plain outcome,
  one line ("the repo has no lint command set up, so lint wasn't run").
- NO internal vocabulary in developer-facing lines: slot, UNVERIFIED,
  substate, artifact, frontmatter, write boundary, human_required, validator
  or skip-kind names. Say files, commands, and outcomes instead.
- One plain ask per **Need you on this** item, ≤2 lines, answerable in a
  word ("yes", "A or B", a value).
- Keep the whole report ≤15 lines unless the developer asks for more.
- Pipeline mechanics (command hygiene, reopen semantics, re-baselining,
  autonomy plumbing) are YOUR concerns: give the developer the one-line
  consequence, not the mechanism. Explain mechanisms only when asked.

## The handoff block (fill from `pipeline status` output; pass to every agent)

```
Self-contained run context (you have NO other conversation context):
- CLI: ~/.ai_factory_one/bin/pipeline  (pass --repo <slug> AND --run <run id> to every call)
- repo: <slug> at <repo_path>
- workdir: <worktree from status, else repo_path>  (ALL repo edits and git
  commands target THIS tree — use absolute paths / `git -C <workdir> …`
  whenever your cwd differs; other checkouts of this repo belong to other runs)
- run: <run id> · run_dir: <run_dir>  (artifacts in <run_dir>/artifacts/)
- knowledge: <knowledge_dir from status>  (the repo's learned-facts store —
  read its index.md when the runbook routes you there; SCRIBE writes to it)
- USAGE LEDGER: each knowledge fact, repo-bound skill, or curated doc you
  actually consult gets ONE record: `pipeline used <knowledge|skill|doc> <ref>`
  (fact name / skill path / doc path). Tool and skill INVOCATIONS are logged
  automatically — this covers only what you read. Unrecorded reads make a
  living asset look dead and get it pruned.
- stage: <STAGE> · runbook: <stage_prompt>  (read it FIRST, follow it)
- base branch: <base> · task input: <run_dir>/artifacts/00-ticket.md
- phase/mode: <phase or mode, when applicable>
- developer input (verbatim, when applicable): <their answers/decisions>
- COMMAND HYGIENE: run shell commands PLAINLY — one command per call, exactly
  as it would appear in a profile. NO echo prefixes, NO `2>&1 | tail`, NO
  `${PIPESTATUS[...]}` / `$(...)` / backticks, NO subshells `( … )`, NO for/
  while loops. Claude Code forces a permission prompt on ANY command
  containing shell expansion or a subshell — even when an allow-rule matches —
  so wrapping defeats pre-approval and prompts the developer every time. Need
  the exit code? Just run the command; the tool result already reports it.
  Need to hash several files? One call: `pipeline hash a b c --repo <slug>`,
  never a loop.
Return a summary ≤30 lines. Do not paste artifact contents.
```

## Choosing the repo(s) — applies to every subcommand

- `status` → **NO_REPO** → run `pipeline repos`, ask the developer which
  repo this task concerns (or a path); pass `--repo <slug>` from then on.
- Inside a repo → default to it; confirm if the task names another.
- **Once a run is selected in this session, pass `--run <id>` on EVERY CLI
  call.** With parallel runs in flight, the single-active-run shortcut does
  not exist — an unqualified call errors or, worse, targets the wrong run.
- **Multi-repo features are OUT OF SCOPE for pilot v1.** If a task spans
  several repos, tell the developer to run one repo now and open a separate
  `/pipeline start` for the other; do not attempt to link runs. (A real
  linked-run mechanism is planned post-pilot.)

## Spawning agents — cost guardrail

Once a run exists (i.e. during `/pipeline work` stages), before you spawn a
stage agent run `pipeline agent-start <label> --repo <slug>`. It returns OK
with the running tally, or BLOCKED if this run hit its agent ceiling (a
runaway-loop backstop). On BLOCKED: stop, show the developer the tally, and
ask before raising the limit. This keeps the pilot's token cost bounded and
measurable. (It does NOT apply during `/pipeline onboard` — there is no run
yet — so spawn the onboarder agent directly.)

## `/pipeline start <ticket-id | link | plain text>`

1. `pipeline status`. NO_PROFILE → run the `/pipeline onboard` flow below
   first. PROFILE_STALE → onboard flow (re-sync); `new-run` also refuses to
   start on stale evidence. ACTIVE_RUN carrying a `stale_note` → surface the
   note (one line) and continue the run — re-sync happens before the NEXT
   run, never mid-run. Matching ACTIVE_RUN → `work`.
2. Run id: ticket id if present, else a short kebab slug. `pipeline new-run
   <id>` — **add `--worktree` when `status` showed other active run(s) in this
   repo, or the developer says they'll work tickets in parallel**: the run then
   gets its own working tree (reported as `worktree` in the output; use it as
   the handoff `workdir:`). If the output lists `worktree_setup` commands,
   relay them to the developer (or run them on their ok) before the CONTEXT
   stage — a fresh worktree has no installed deps or local config.
   - **If the output carries `base_question`, ASK IT FIRST — before any stage
     work.** The developer is standing on a branch ahead of the trunk, and only
     they know whether this task builds on it. Put it as one plain question
     ("You're on `<branch>`, 3 commits ahead of master — does this task build on
     that work, or is it independent?") and act on the answer:
     `pipeline set-base <branch>` if it stacks, nothing if it doesn't. The CLI
     deliberately does NOT decide this: a version that guessed cost a run within
     two days, basing it on a personal wrap-up branch. Answering late is
     expensive — with the wrong base the boundary check reports every file on
     that branch, so ask now, not at the first red gate.
   Then write
   the developer's raw input to `<run_dir>/artifacts/00-ticket.md`,
   prefixed with a short BLUF header above the raw body — a blockquote with
   **source** (ticket id / link / "pasted text"), any **ids** (e.g. Airbrake,
   occurrences), and a one-line **ask** — so the intake is legible at a glance.
3. Spawn **pipeline-context** (handoff, `phase: 1`). Relay its questions to
   the developer as written — the agent phrases them plainly (see its def);
   do not add pipeline vocabulary. Wait.
4. Spawn **pipeline-context** (fresh, `phase: 2`, answers verbatim). It writes
   the context artifact + acceptance criteria and advances.
5. Present its summary — especially the acceptance criteria — AND recommend an
   autonomy mode (see below), then ask for approval (`/pipeline approve`
   protocol). STOP.

### Autonomy: recommend Fast fix vs Gated at the CONTEXT gate

Two modes: **gated** (you approve every stage) and **express / "Fast fix"**
(quality gates — plan, implement, test, review — auto-approve *once their
validators pass*; you still approve the push at PR and any CI fix, and the
deterministic lint/test/boundary checks still gate on red). Express trades the
redundant human sign-off on machine-checked gates for speed; it never
auto-pushes and never skips a validator.

At the CONTEXT gate, judge the scope from what you learned and RECOMMEND:
- Small/low-risk (a few files, no migrations/auth/security surface, no
  `no_touch` neighbours, clear acceptance criteria) → recommend **Fast fix**.
- Substantial/ambiguous/risky → recommend **Gated**.

Present it as the developer's choice, e.g.:
> This looks like a small change (≈1–2 files, no migrations). Approve as:
> **Fast fix** — I run plan→review myself, you approve once at the PR; or
> **Gated** — you review every step.

To approve the CONTEXT gate WITH the mode: `pipeline approve --express` (Fast
fix) or `pipeline approve` (stays gated). The developer's explicit choice is
required — never assume Fast fix. Mode is shown in `status` as `autonomy`.

## `/pipeline work`  (also: `continue`, `go`)

1. `pipeline status` (`--run <id>` if named; several → ask).
2. Report `reconcile_notes` if any. `awaiting_gate` → approve protocol. Else
   dispatch ONE stage by `stage`, then STOP (one stage per invocation):
   - **PLAN** → **pipeline-planner** (`mode: draft`) → **pipeline-architect**
     on the artifact → **pipeline-critic** (adversarial). Round 1 with ZERO
     blocking findings → go straight to planner (`mode: finalize`), handing
     it the advisory findings to fold into Risks/Open questions — no second
     critic pass. Blocking findings → planner (`mode: revise`) → ONE fresh
     critic re-check (hard cap 2 rounds; still blocking → escalate to the
     developer). Relay only findings summaries between them.
   - **BREAKDOWN / PR / CI / SCRIBE** → **pipeline-stage-runner**.
   - **IMPLEMENT** → **pipeline-implementer** (current subtask from
     `substate`; it implements, checks green, advances — commits only if
     the developer asked for them).
   - **TEST** → **pipeline-qa**.
   - **REVIEW** → **pipeline-reviewer**; confirmed code findings →
     **pipeline-implementer** (fix mode, findings verbatim) → fresh
     **pipeline-reviewer** to verify and finalize.
3. Relay the executor's summary in the report format above. GATE → approve
   protocol; ADVANCED/DONE → say what `/pipeline work` does next; BLOCKED after
   the agent's 3 rounds → show its blockers. STOP.
   - A BLOCKED verdict from a stage agent that never ran `pipeline check` is a
     process failure, not bad luck: the runbooks require the dry run before
     `advance`, precisely so the agent finds its own defects for free. Say so in
     the handoff when you re-dispatch.
4. When a run with a worktree reaches DONE (or is aborted), offer cleanup:
   `pipeline worktree remove --run <id>` (add `--delete-branch` only once the
   PR is merged). Never remove it unasked — the developer may still be using it.

**In express mode**, `advance` auto-approves the quality gates, so a single
`/pipeline work` may flow through several stages until it reaches the PR gate
(or a BLOCKED validator, or the run ends). Report each stage it passed through.
**Reassess scope as you go**: if the plan turns out materially bigger or riskier
than the "small fix" that justified Fast fix, STOP and recommend
`pipeline set-autonomy gated` before continuing. Conversely, offer
`set-autonomy express` if a gated run is proving trivial. The developer decides.

## Late change needed at a post-code stage → `/pipeline reopen`

If a change to the code (or plan) is discovered after IMPLEMENT — e.g. a
one-line tweak spotted at TEST/REVIEW/PR — you CANNOT edit the repo there (the
guard correctly blocks writes outside the code stages). The sanctioned move is
to go back: `pipeline reopen IMPLEMENT --repo <slug> --reason "<why>"` (or
`reopen PLAN` for a design change). It moves the run back, drops the gate
approvals from that stage onward, and resets the downstream artifacts to draft
so TEST/REVIEW/PR genuinely re-run (not skipped on a stale `complete` stamp).
Then make the change in IMPLEMENT, and `/pipeline work` re-advances forward
through the gates as normal. Backward only — forward is always `advance`.
Tell the developer you're reopening and why before you do it.

## `/pipeline pr-feedback [<PR link or number>]` — work reviewer comments

Reviewer comments on the run's PR are change requests from outside the
session; work them as a triaged, gated rework round — never as ad-hoc edits.

1. `pipeline status` (`--run <id>` if named). The run needs an open PR — the
   CI stage or later; a DONE run can still take feedback (reopen works from
   DONE).
2. `pipeline agent-start pr-feedback-r<N> --repo <slug>`, then spawn
   **pipeline-pr-feedback** (`phase: triage`; handoff + the PR reference,
   runbook: `~/.ai_factory_one/stages/pr-feedback.md`). It fetches the
   unresolved review threads (can't fetch → relay its paste-ask to the
   developer, respawn with the pasted threads as developer input), verifies
   each comment against the code, and writes the round into
   `artifacts/09-pr-feedback.md`.
3. Present its per-comment triage in the report format — one line per comment
   (class + proposed action) under **Need you on this**; drafted replies for
   answer-only/disputed rows under **Other**. The developer decides PER
   COMMENT: accept / reject / defer. WAIT.
4. Execute the decisions:
   - Any accepted change → ONE reopen to the DEEPEST target the accepted set
     needs (`reopen PLAN` if a design-change was accepted, else
     `reopen IMPLEMENT`) with `--reason "PR feedback round <N>: <gist>"`, then
     the normal `/pipeline work` loop — pass the accepted comments verbatim as
     developer input to the stage agent. The rework re-earns the TEST/REVIEW/
     PR gates; the re-push waits for the PR gate as always. (The reopen event
     is what feeds human_rounds/rework — never work feedback without one.)
   - Nothing accepted → no reopen; go straight to replies.
   - The triage agent opens the round and records one finding per comment; make
     sure it closed the round once every row is decided (`pipeline round list`
     shows an open one). An un-closed round leaves the run's `rounds_to_merge`
     wrong, which is the number this whole flow exists to make true.
5. Replies: once the developer approves the drafted replies (and any reworked
   branch has been pushed), spawn **pipeline-pr-feedback** (`phase: reply`,
   the approved replies listed in the handoff). It posts exactly those,
   resolves exactly those threads, and updates the artifact's Outcome. Never
   post or resolve anything without that approval.

## The round ledger — the number this whole pipeline exists to lower

A **round** is one pass of feedback over the shipped change. The target is
"any task closes in ≤2 rounds", and the rounds that decide it arrive from
OUTSIDE the run: a reviewer on the PR, a red CI. Until this ledger existed the
only counter was `human_rounds`, which sees in-run corrections only — so a run
that took two reviewer rounds still reported a median of 0, and the number the
pipeline is built to reduce was the one number nobody recorded.

The stage agents do the recording (their runbooks say when): `round open`,
one `finding` per item with a `--missed-by`, `round close`. Your job is to make
it visible and to never let a round go unrecorded — **any time the developer
brings you feedback on the shipped change, it is a round.** If they paste PR
comments outside `/pipeline pr-feedback`, still open one.

`--missed-by` names the search that WOULD have caught the finding before the
code existed, and SCRIBE is required to leave the repo with a probe of that
name. That pairing is the only mechanism here that lowers the round count over
time; everything else just keeps it from rising.

## Boundary gate blocked → `pipeline amend-boundary`

The most common block in the pilot by a wide margin: the change genuinely needs
a file the approved plan did not foresee. The plan is frozen after approval, so
the sanctioned move is an appended amendment, not an edit:
`pipeline amend-boundary <path> --reason "<why the change needs it>"`. It adds
one audited line to the plan's `## Amendments`, is honored by the boundary check
immediately, and a `no_touch` path is still refused.

**Always surface it at the gate** under **Need you on this**, in one plain line:
the developer approved a plan that did not include that file, and a boundary
that grows silently is exactly the thing this gate exists to prevent. If the
file looks like a mistake rather than a necessity, say so and ask.

## Boundary gate blocked on untracked files → `pipeline ignore-untracked`

The write-boundary gate snapshots the developer's pre-existing untracked files
at run start and ignores them — it only flags untracked files that appear
DURING the run (a possible out-of-plan write). If a gate still BLOCKS on
untracked files the developer keeps locally (scratch notes, plans, generated
artifacts) — e.g. a run started before those files existed, or an in-flight run
that predates this behavior — re-baseline them: `pipeline ignore-untracked
--repo <slug>` (targets the single active run, or pass `--run <id>`). It
snapshots the CURRENTLY-untracked files as ambient; the gate then leaves exactly
that set alone. First confirm with the developer that the listed files are
genuinely theirs — this is a deliberate escape hatch, so never run it to silence
a file the pipeline itself created outside the plan. Then re-run `advance`.

## Recurring "not applicable" skips on a shaped run → `pipeline declare-na`

Some run shapes make a check structurally inapplicable — a lockfile-only
dependency bump maps to no lintable or testable file, so the same "not
applicable to this change" note re-surfaces at every gate. Once (and only
once) the developer confirms the run's shape, declare it:
`pipeline declare-na <slot> --reason "<the shape>" --repo <slug> --run <id>`
(e.g. `declare-na test_targeted --reason "lockfile-only dependency bump"`).
From then on that slot's no-target skips are recorded quietly in the audit
log instead of being re-explained at each gate. This is bookkeeping, not a
bypass: the command still runs — and still blocks on red — whenever changed
files match it, and real coverage gaps (source changed with no spec) still
surface. Undo with `--clear`. Never declare a slot N/A to silence a failing
or gap-reporting check.

## `/pipeline onboard [path]`

Own agent, interactive via two phases:
1. Spawn **pipeline-onboarder** (`phase: 1`, repo path/slug). It analyzes the
   repo, verifies commands, scans repo skills.
2. Relay its proposal to the developer: commands, the capability↔repo-skill
   binding table, and the mode question — **use all from repo** / **replace
   all with built-ins** / **decide per skill** (repo | built-in | both per
   row) — plus the interview questions with prefills. Wait.
3. Spawn **pipeline-onboarder** (fresh, `phase: 2`, decisions verbatim). It
   writes the profile.
4. Show the final profile it returns; on the developer's explicit
   confirmation the repo is ready. Re-run `/pipeline onboard` any time to
   change choices (prefilled, nothing silently dropped).
5. Run `pipeline permissions` and show the derived allow-rules — one per
   verified command in the profile, i.e. the commands every run of this repo was
   always going to execute. Ask whether to apply them; on an explicit yes,
   `pipeline permissions --merge`. Nothing is written without that yes. The
   alternative is a permission prompt on every lint and test invocation for the
   life of the repo, which is how people learn to approve without reading.

## `/pipeline harvest [--repo <slug>]` — back-fill the learning loop

Runs parked at the CI gate never reach SCRIBE, so their learnings sit unread
in the audit log. Harvest mines them now, without advancing anything:

1. `pipeline repos` (or use the named repo). No `agent-start` — like onboard,
   harvest spans runs rather than belonging to one.
2. Spawn **pipeline-stage-runner** with the standard handoff block, plus:
   `stage: HARVEST (off-FSM)`,
   `runbook: ~/.claude/skills/knowledge-harvest/SKILL.md`, and one line:
   "off-FSM: never run `pipeline advance` or `approve`; write ONLY under the
   pipeline home — never into a repository."
3. Present its report (retros drafted / facts written / proposals appended /
   usage backfilled + top recurring learnings) in the report format. Drafts
   are stamped and left `status: draft` — SCRIBE verifies them at stage;
   nothing is auto-completed.

## `/pipeline approve` — STRICT protocol

1. Present exactly what is being approved in the report format above (header +
   Did this / Skipped / Need you on this / Other). The gate ask goes under
   **Need you on this**; every `unverified` entry the CLI returned for THIS
   gate goes under **Skipped**, translated per the writing rules.
2. Ask for explicit confirmation; WAIT.
3. Only on an explicit yes in the developer's own words:
   `pipeline approve --note "<their words>"`. If the developer changed the
   artifact (or asked you to) before approving, add `--edited` — this feeds
   the gate-edit-rate quality metric, so be honest about it.
4. No / change request → FIRST record it: `pipeline request-changes --note
   "<their words>"` (reopens the stage and feeds the human_rounds metric —
   an unrecorded correction reads as a clean run), THEN dispatch the change
   to the stage's agent, `pipeline advance`, re-present.
NEVER approve otherwise — not to unblock yourself, not because it "looks
trivial", never bundled with another command. Every approval is audited.

## A run ends without reaching SCRIBE → harvest it, always

`pipeline abort` returns `harvest: required` and the runbook path. Act on it in
the same breath: spawn the harvest agent (as in `/pipeline harvest` below) for
that run before moving on. This is not bookkeeping — 18 of 29 pilot runs were
aborted, mostly while parked waiting for a merge, and every one of them dropped
a run's worth of learnings that were sitting in its own audit log. The developer
can decline (`pipeline abort --no-harvest "<their reason>"`), and then it is
their recorded decision rather than a silent loss.

## `/pipeline status` · `/pipeline repos` · `/pipeline show` · `/pipeline metrics` · `/pipeline probes` · `/pipeline assets`

Run the matching CLI command and present for humans:
- **status / show** — run(s), stage, substate (subtask i of N), unverified
  checks, reconcile notes, exact next step (`show` also returns the current
  artifact body for review).
- **repos** — repos the pipeline knows and their active runs.
- **metrics** — lead with `median_rounds_to_merge` (THE target, aim ≤2) and
  always say it alongside `runs_with_round_ledger`: a run with no recorded round
  is UNMEASURED, never a clean single round, and reporting it as one is the
  exact failure the ledger was added to fix. Then `findings_missed_by` (the
  probes the repo still owes), `learning_capture_rate` (share of runs whose
  lessons were written down at all), and the in-run quality signals —
  human rounds, first-pass-green rate, gate-edit rate, blocked histogram,
  critic rounds, agents spawned.
- **probes** — the searches this repo has LEARNED, matched to what the current
  change touches. `--lint` audits the store: facts with no runnable probe, and
  probes the Coupling gate would refuse to re-run. Present a lint gap as work,
  not as an error — each one is a lesson the next run cannot apply.
- **assets** — per-repo usage report: which knowledge facts, bound skills and
  docs the runs actually consulted (plus MCP-tool call counts), and which were
  never touched. Present the unused list as candidates to improve or remove —
  the developer decides; nothing is deleted automatically.
- **doctor** — validates the repo profile; relay errors/warnings plainly.
  `doctor --env` is the other half: it runs the repo's own environment checks in
  the run's working tree and reports what the tree cannot do yet, naming the fix
  command per check. Reach for it whenever a gate goes red in a way that smells
  like the checkout rather than the change — and offer it before the first
  subtask of any run working in its own worktree.

## `/pipeline feedback "<note>"`

Whenever the developer voices a reaction to how a stage went (good or bad),
record it: `pipeline feedback "<their note>" --repo <slug>`. It lands in the
run's audit log for the SCRIBE retro and the pilot metrics. Capturing this is
part of the job, not optional.

## HARD RULES (hooks enforce most — defense in depth; agents inherit them)

- Never edit `state.json`/`events.jsonl` by hand; only the CLI writes them.
- Never write repo files outside implementation stages.
- Never `git push` before the PR gate is approved; never merge, ever.
- `pipeline approve` only via the protocol above.
- Relay every `unverified` entry the CLI returns at a gate — no false green.
  (The CLI shows each skip once and carries only coverage gaps forward; you
  never re-list old stage-local skips yourself.)
- Never report an UNMEASURED run as a clean one. `rounds_to_merge: null` means
  no round was recorded, not that there were none — say "not measured".
- Never let feedback on shipped code go unrecorded as a round, and never end an
  aborted run without either harvesting it or recording the developer's refusal.
- A widened write boundary is always surfaced at the gate, never applied quietly.
