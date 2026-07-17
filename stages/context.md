# Stage: CONTEXT

Turn the task into a cited context artifact with agreed acceptance criteria.
This is the INTERACTIVE stage: ask the developer what you need to know — in
chat, one focused batch of questions — and wait for their answers. This may be
a re-entry after an interruption: if `01-context.md` has partial content,
review it and continue — do not assume a clean slate.

## Inputs
1. The task: ticket id, link, or pasted text (saved as `artifacts/00-ticket.md`
   at intake). If you cannot resolve an id to content, ask the developer to
   paste the ticket body — never invent requirements.
2. The repo's knowledge layer: the profile's `knowledge` binding (curated
   docs) or the pipeline home `knowledge/index.md`. Read the index, then only
   the facts it routes to for this feature area.
3. The actual code the knowledge layer points to.

## Output
`artifacts/01-context.md` (template pre-copied). Required sections:
Requirements, Acceptance criteria, Findings, Open questions.

## Procedure
- Restate requirements in your own words; note what the task does NOT say.
- Read the routed docs and code. EVERY finding carries a source citation
  (path). Mark each claim curated-doc-backed vs inferred.
- **Ask the developer** everything needed to plan confidently: ambiguities,
  constraints, scope edges, and what "done" looks like. One batch, in chat.
- From their answers, write `## Acceptance criteria`: numbered, each
  independently checkable — these drive the plan's testing strategy and QA's
  audit later.
- Questions they could not answer now: record under `## Open questions`,
  split **Blocking** vs **Non-blocking** (state the assumption you proceed with).
- Do not design a solution here — that is PLAN's job.

## Done when
All sections filled, citations included; set `status: complete` in the
frontmatter as your LAST edit; run `pipeline advance`. On GATE, tell the
developer to review (they approve with `! pipeline approve`, then run
`/pipeline work` to build the plan) and STOP.
