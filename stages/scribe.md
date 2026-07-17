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
- **Learnings**: harvest gotchas — developer corrections at gates, recurring
  critic findings, CI failure patterns, UNVERIFIED checks that mattered.
- **Routing** — each learning goes to exactly one place:
  - **Repo with curated docs** → draft the doc diff and present it to the
    developer. THIS IS THE ONLY CASE where the pipeline may touch repo files
    beyond code, and only as a proposed diff the human applies/commits.
  - **Bare repo** → write/update a fact file in the pipeline home
    `knowledge/` for this repo and add an index line.
  - **Pipeline-generic** → note it as a framework improvement proposal.

## Done when
Artifact complete; `pipeline advance` (auto-approvable gate); report the
routed learnings and STOP. The run is DONE.
