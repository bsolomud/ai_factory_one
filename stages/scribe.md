# Stage: SCRIBE (cycle end)

Make the next run on this repo smarter. The knowledge layer is the product.

## Inputs
Every artifact of this run + `events.jsonl` (gate notes, blocked reasons,
skipped checks).

## Output
`artifacts/08-retro.md`. Required sections: Plan-vs-shipped, Learnings, Routing.

## Procedure
- **Plan-vs-shipped**: diff the approved plan (with amendments) against what
  shipped. Substantive deviations = planner/critic improvement candidates or
  missing knowledge facts.
- **Learnings** (as a table: Learning | Type | Routed to | Status): harvest
  gotchas — developer corrections at gates, recurring critic findings, CI
  failure patterns, UNVERIFIED checks that mattered.
- **Routing** — each learning goes to exactly one place:
  - **Repo with curated docs** → draft the doc diff and present it to the
    developer. THIS IS THE ONLY CASE where the pipeline may touch repo files
    beyond code, and only as a proposed diff the human applies/commits.
  - **Bare repo** → write the fact into this repo's store (the
    `knowledge_dir` reported by `pipeline status`). WRITE it now — routing a
    fact without writing it is the failure mode this stage exists to prevent.
    Format: one fact per file, kebab-case name (`<topic>.md`), containing the
    fact in 1-3 sentences, then `## Why` (the consequence of not knowing it)
    and `## Evidence` (this run id + the file/PR/event that proves it). If a
    file for the topic already exists, update it instead of duplicating.
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
Fill the BLUF header at the top (Outcome, TL;DR, Needs you). Artifact complete;
`pipeline advance` (auto-approvable gate); report the
routed learnings and STOP. The run is DONE.
