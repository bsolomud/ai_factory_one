# Stage: SCRIBE (cycle end)

Make the next run on this repo smarter. The knowledge layer is the product.

## Inputs
Every artifact of this run + `events.jsonl` (gate notes, blocked reasons,
skipped checks, asset usage) + the cross-run usage report: `pipeline assets` +
**the round ledger**: `pipeline round list` and the run's
`findings_missed_by` in `pipeline metrics --run <id>`. That last one is the work
list — every `missed_by` name that is not `none` is a probe this repo owes.

## Output
`artifacts/08-retro.md`. Required sections: Plan-vs-shipped, Learnings, Routing.

## Procedure
- **Plan-vs-shipped**: diff the approved plan (with amendments) against what
  shipped. Substantive deviations = planner/critic improvement candidates or
  missing knowledge facts.
- **Learnings** (as a table: Learning | Type | Routed to | Status): harvest
  gotchas — developer corrections at gates, recurring critic findings, CI
  failure patterns, UNVERIFIED checks that mattered. A prior
  `knowledge-harvest` pass may have pre-drafted rows and facts (stamped
  `Drafted by knowledge-harvest`) — verify each drafted row against this
  run's events, then route it; update existing facts rather than duplicating.
- **Harvest every review finding into a PROBE** (the half that has to grow).
  A strong reviewer is a learning institution: on a pilot repo the review skill
  carries ~3,250 lines across 17 files, backed by a knowledge corpus of ~31,000
  lines, and **397 of its rules cite the number of the PR that taught them** —
  one of its own files says outright that they *"accrete one per retrospective,
  which is why they are the half that grows"*. The implementing side accretes
  nothing, so the reviewer gets sharper every PR and the gap widens forever.
  That asymmetry, not code quality, is what makes the round count permanent.
  So: every finding this run RECEIVED — from the pre-PR review, from the
  critic, from a human on the PR — becomes a fact of the form
  **"a change of shape X needs check Y, run like this"**, with the PR or run id
  that taught it. Write it as a runnable probe, not as advice to remember: the
  next run's `## Coupling` table can only cite a command, so a learning that
  cannot be phrased as one is a learning that will not be applied. Route it
  like any other learning (repo docs → proposed diff; bare repo → knowledge
  store; generic → framework proposals).

  **This is now mechanical, not aspirational.** Work the run's
  `findings_missed_by` tally: every name that is not `none` must exist as a
  probe in the knowledge store when this stage ends. Then run
  `pipeline probes --lint` — it reports every fact that carries no runnable
  probe, and every probe the Coupling gate would refuse to re-run. Measured
  before this was enforced: 10 facts across 29 runs, and not one of them
  carrying a command, so the store could not be cited by a single `## Coupling`
  row it was written to inform.
- **Asset audit**: run `pipeline assets`. A knowledge fact or bound skill with
  zero uses across runs is a pruning candidate (stale? unfindable index hook?
  genuinely dead?) — and an asset that was consulted but proved wrong or thin
  is an improvement candidate. Route each such observation as a learning like
  any other (proposed removals/rewrites go to the developer, never applied
  unilaterally).
- **Routing** — each learning goes to exactly one place:
  - **Repo with curated docs** → draft the doc diff and present it to the
    developer. THIS IS THE ONLY CASE where the pipeline may touch repo files
    beyond code, and only as a proposed diff the human applies/commits.
  - **Bare repo** → write the fact into this repo's store (the
    `knowledge_dir` reported by `pipeline status`). WRITE it now — routing a
    fact without writing it is the failure mode this stage exists to prevent.
    Format: one fact per file, kebab-case name (`<topic>.md`), built from
    `templates/knowledge-fact.md`: frontmatter carrying the machine-readable
    `probe:` (its `when:` globs, the read-only `run:` command, and the `asks:`
    question a hit answers — a **search** whose count becomes a `## Coupling`
    row, or an **inspection** that answers a question no search can) plus
    `taught_by:`, then the fact in 1-3 sentences,
    then `## Why` (the consequence of not knowing it) and `## Evidence` (this
    run id + the file/PR/event that proves it). The frontmatter is what
    `pipeline probes` reads, so a fact whose probe is missing or is not a
    read-only search is a fact no future run can use — `pipeline probes --lint`
    names both. A fact with genuinely no searchable shape declares
    `probe: none` plus `probe_none: "<why>"`; the reason is what makes it a
    decision rather than an oversight. If a file for the topic already exists,
    update it instead of duplicating.
    LAST, append one line to `knowledge_dir/index.md`:
    `- [<topic>](<topic>.md) — <one-line hook>` (create the index if missing).
    CONTEXT and PLAN read the index first, so the hook line decides whether
    the fact is ever found again.
  - **Pipeline-generic** → append it to `~/.ai_factory_one/framework-proposals.md`
    (create if missing): a dated `## <date> · <run id> — <title>` heading plus
    the proposal in a few lines. Never leave a framework proposal only as
    prose in this retro — that file is where the pipeline's maintainer
    harvests them.

## Done when
`pipeline probes --lint` reports no fact this run added without a runnable
probe, and every non-`none` `missed_by` from the round ledger exists as one.
Fill the BLUF header at the top (Outcome, TL;DR, Needs you). Artifact complete;
`pipeline advance` (auto-approvable gate); report the
routed learnings — and the probes now in the store — and STOP. The run is DONE.
