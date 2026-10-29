---
name: pipeline-retro
description: Review retro for the ai_factory_one pipeline itself — reads what reviewers said on the closed PRs of pipeline runs, sets it against what the pipeline's own review found, and turns every miss into a generic, NDA-clean proposal to change the pipeline. Run by hand with /pipeline-retro [--since YYYY-MM-DD] [--repo <slug>]. Standalone — never touches a run, a stage, a project repo or the pipeline's source. NEVER invoke proactively, and never from inside a /pipeline run.
argument-hint: [--since YYYY-MM-DD] [--repo <slug>] [--again]
---

# /pipeline-retro — teach the pipeline from its reviews

Reviewers keep finding things on the pipeline's PRs. Each one is either a
lesson about the PROJECT (its code, its conventions — that is the per-repo
knowledge SCRIBE keeps, and it stays with the project) or a lesson about the
PIPELINE: a stage that did not look, a check that let something through, a
fix proven on one input instead of its class. This retro harvests the second
kind, in words that hold for any project, so the tool gets better everywhere
it runs.

## What it may and may not touch

- **Reads**: the batch `pipeline retro collect` writes, the runs' artifacts
  and events, the project checkouts (read-only, only to understand a comment),
  the pipeline's own files.
- **Writes**: only under `~/.ai_factory_one/retro/`: the batch's private
  `analysis.md`, and `proposals.md`.
- **Never**: run `/pipeline` or any pipeline command that changes a run
  (`advance`, `approve`, `reopen`, `round`, `finding`, …); edit a run's
  `state.json`, `events.jsonl` or artifacts; write into a project repo or
  worktree; edit the pipeline's source. Proposals are decided by the developer
  and implemented in a separate ai_factory_one session, with tests.
- **NDA**: `proposals.md` is about the tool, never the project. No ticket ids,
  PR numbers, repo/org/product/people names, file paths, identifiers, code,
  links or domain terms. `pipeline nda-check` enforces it mechanically and
  `pipeline retro finish` refuses until it is clean. The private
  `analysis.md` may carry project detail: it stays on this machine.

## Procedure

1. `pipeline retro collect [--since …] [--repo …] [--again]`. It prints the
   batch, the PRs and comment counts, and what it skipped (open PRs, missing
   checkouts). `NOTHING_NEW` → say so and stop.
2. Spawn **pipeline-retro** (fresh context) with one handoff line each:
   `batch: <batch_file>`, `proposals: ~/.ai_factory_one/retro/proposals.md`,
   `pipeline: <the ai_factory_one package dir, or ~/.ai_factory_one>`. It
   writes `analysis.md` next to the batch and appends one dated section to
   `proposals.md`.
3. `pipeline nda-check`. Violations → send them back to the agent (or fix the
   lines yourself) until clean. Never weaken a line by deleting the evidence
   count; rephrase it generically.
4. Show the developer the new section of `proposals.md`: one line per
   proposal (title, weight, component) and ask which to accept. Record each
   answer in its `- Status:` line — `accepted`, `declined (<why>)`, or leave
   `proposed`.
5. `pipeline retro finish <batch>` — records the PRs as looked at, so the next
   retro starts after them.
6. Report: PRs read, comments read, how many the pipeline had caught before
   the PR, the proposals and their statuses, and that accepted ones are built
   in an ai_factory_one session ("implement retro proposal <date> #n").

`pipeline retro list` shows how many PRs the retros have covered.
