---
name: knowledge-harvest
description: Back-fills the ai_factory_one learning loop for parked and completed runs — drafts retros from recorded events, writes knowledge facts and framework proposals, reconciles the asset usage ledger. Invoke ONLY when dispatched via `/pipeline harvest` (or named as SCRIBE support in a handoff). Writes ONLY under the pipeline home — never into any repository. NEVER invoke proactively.
---

# Knowledge harvest — close the loop without waiting for merges

Most runs park at the CI gate for days awaiting a human merge, so SCRIBE —
the stage that writes the knowledge layer — rarely runs, and the learnings
sit unread in `events.jsonl`. This procedure harvests them NOW, as drafts
and facts, without advancing anything. SCRIBE remains the verifying stage
act; you are its supply line.

## Scope and safety (read first)

- Write ONLY under the pipeline home (`~/.ai_factory_one/`): run artifact
  drafts, `knowledge_dir` facts, `framework-proposals.md`. NEVER write into
  a repository checkout or worktree.
- NEVER run `pipeline advance`, `approve`, `reopen`, or edit
  `state.json`/`events.jsonl`. Read state with the Read tool only.
- Never propose repo-doc diffs — that route needs a live developer at
  SCRIBE. A learning that belongs in a repo's curated docs (this applies to
  the WHOLE store on curated-docs repos) is written to `knowledge_dir` in
  the standard fact format anyway, with one trailing line after
  `## Evidence`: `Candidate for repo doc: <path>` — so SCRIBE can escalate
  it at stage.

## Step 1 — Enumerate

For the target repo (`--repo <slug>` from the handoff, else every repo from
`pipeline repos`): list runs under `~/.ai_factory_one/repos/<slug>/runs/`
whose `artifacts/08-retro.md` is missing, still `status: draft`, or an
unfilled template. Skip runs already carrying the Step 2 stamp. The repo's
knowledge store is at `~/.ai_factory_one/repos/<slug>/knowledge/` — use that
path directly (`pipeline status` reports `knowledge_dir` only when a single
run is addressed).

## Step 2 — Draft retros

For each such run, mine `events.jsonl` and the artifacts into the retro's
Learnings table:

- `feedback` notes — especially structured `[harness]` / `[worktree]` ones;
- `blocked` reasons, `reopened` reasons, `request-changes` notes, gate notes;
- `check_skipped` / `declare-na` entries that recurred;
- `07-ci-analysis.md` classifications (flakes, false-greens, infra noise).

Rules:
- **Every Learnings row cites its evidence** (the event line or artifact
  section that proves it). An uncited learning is a hallucination — drop it.
- Older `blocked` events carry only a reason COUNT (`{"reasons": N}`), no
  texts. Cite them as count-only ("blocked ×N at <stage>, causes not
  recorded") — never invent the causes.
- Stamp the retro on its own line immediately AFTER the BLUF blockquote:
  `> Drafted by knowledge-harvest <date> — SCRIBE verifies at stage.`
  This stamp is the idempotency marker Step 1 checks for.
- Leave `status: draft`. Completing the artifact is SCRIBE's stage act,
  never yours.

## Step 3 — Write knowledge facts

Repo-shaped learnings (gotchas, environment quirks, worktree preconditions,
flaky tests) become facts in `knowledge_dir` — **in the exact format defined
in `~/.ai_factory_one/stages/scribe.md` under Routing → "Bare repo", whose
skeleton is `~/.ai_factory_one/templates/knowledge-fact.md`. Read both first
and follow them; do not improvise a format.** Additionally:

- **Give every fact that has a searchable shape a `probe:` in its
  frontmatter** — `when:` globs, a read-only `run:` command, and the `asks:`
  question a hit answers. This is what `pipeline probes` hands the next
  planner, and the plan's `## Coupling` table can cite ONLY a command: a fact
  written as prose alone is one no run will ever apply. Verify with
  `pipeline probes --lint --repo <slug>` before reporting; it names both
  probe-less facts and commands the Coupling gate would refuse to re-run.
  A fact with genuinely no searchable shape (an environment gotcha, a product
  decision) may omit it — say so in the body so the lint gap reads as a
  decision rather than an oversight.
- **Back-fill the round ledger where the events prove one.** A `reopened`
  event whose reason names PR feedback, or a `09-pr-feedback.md` artifact, is
  a round that happened before the ledger existed. Do NOT write events — you
  never touch `events.jsonl` — but DO surface each one in the retro's
  Learnings table with its `missed_by` classification, so SCRIBE can record
  it and so the probe it implies gets written.
- Dedupe by topic: if a fact file for the topic exists, update it (append
  evidence) instead of duplicating.
- The `index.md` hook line comes LAST, once per fact file, and only for new
  files.
- Two standing topics other skills consume — keep their names exact:
  `worktree-preflight.md` (read by gate-triage Mode 1) and
  `ci-known-flakes.md` (read by ci-triage's flake protocol).

## Step 4 — Framework proposals

Pipeline-generic learnings (validator defects, runbook gaps, metric blind
spots) go to `~/.ai_factory_one/framework-proposals.md` (create if missing)
as dated entries: `## <date> · <run id> — <title>` plus a few lines. If a
retro claims a proposal was filed/proposed/routed (any such wording) but the
file lacks it — or the file doesn't exist at all — reconstruct the entry
from the retro's own text and mark it `(reconstructed)`.

## Step 5 — Ledger reconciliation

Run `pipeline assets --repo <slug>`. For each asset it reports unused:
grep the runs' artifacts for citations of that asset — by path, basename,
AND known aliases (a doc reached through a symlink is recorded under the
symlink's name, e.g. `CLAUDE.md` → `AGENTS.md`).

- Demonstrably cited → backfill:
  `pipeline used <kind> <ref> --repo <slug> --run <run id> --note "backfilled: cited in <artifact>"`
  — one record per run that cited it, never more; if the run already has a
  usage record under an alias of the same file, do NOT add another.
- Genuinely uncited anywhere → leave it; it is a legitimate pruning
  candidate for SCRIBE to route.
- Facts YOU wrote in Step 3 will naturally show as unused — exclude them
  from any pruning observation in your report; they haven't had a run yet.

## Step 6 — Report and idempotency

Return a summary: retros drafted / facts written / proposals appended /
usage records backfilled (counts), plus the top 3 recurring learnings across
runs. Idempotency: the Step 2 stamp is the marker — a stamped retro is
skipped; re-harvest one only when the dispatcher explicitly asks (a rerun on
the same day must not double-append facts or proposals — check before
writing).
