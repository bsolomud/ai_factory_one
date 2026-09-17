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
   docs) or this repo's learned-facts store — the `knowledge_dir` reported by
   `pipeline status` (`repos/<slug>/knowledge/` in the pipeline home; written
   by SCRIBE). Read its `index.md`, then only the facts it routes to for this
   feature area. No index yet → nothing learned yet; move on. Record every
   fact or curated doc you actually consult — `pipeline used knowledge <fact>`
   / `pipeline used doc <path>` — so the assets report can tell living
   knowledge from dead weight.
3. The actual code the knowledge layer points to.

## Output
`artifacts/01-context.md` (template pre-copied). Required sections:
Requirements, Acceptance criteria, Decisions, Findings, Open questions.

## Procedure
- Restate requirements in your own words; note what the task does NOT say.
- Read the routed docs and code. EVERY finding carries a source citation
  (path). Mark each claim curated-doc-backed vs inferred.
- **Ask the developer** everything needed to plan confidently: ambiguities,
  constraints, scope edges, and what "done" looks like. One batch, in chat.
- From their answers, write `## Acceptance criteria` as a table
  (# | Criterion | Verified by | Population): numbered, each independently
  checkable — these drive the plan's testing strategy and QA's audit later.
  - **Write the criterion as an observable end state, never as a mechanism.**
    "The form saves the mode" is a claim about code: it passes while every
    record already out there stays broken. "A school stored as bulk runs delta
    on its next scheduled sync" is a claim about the world, and it stays red
    until the existing data is handled too. A mechanism-level criterion is how
    a change ships as a fraction of the fix while every check is green.
  - **Population** is machine-checked (`ac_population`) and takes one of
    `new` / `existing` / `both` / `n-a`. Answer it per criterion, out loud,
    with the developer: *what about the records that are already wrong?* If the
    answer is `existing` or `both`, the migration/backfill belongs in this run's
    scope or in the out-of-scope list — decided here, not discovered at review.
- Resolve `## Decisions` WITH the developer — scope boundary (fix-here vs
  root-cause), product-intent ambiguities, secrets/config policy (what may
  carry a committed default vs must be ENV-injected), migration/rollout, and
  the explicit out-of-scope list. Every decision that surfaces later instead
  (at REVIEW or PR) costs a whole reopen cycle; ask NOW, in the same question
  batch. 'N/A — <why>' rows are fine; empty rows are not.
- Questions they could not answer now: record under `## Open questions`,
  split **Blocking** vs **Non-blocking** (state the assumption you proceed with).
- Do not design a solution here — that is PLAN's job.

## Done when
Fill the BLUF header at the top (Outcome, TL;DR, Needs you) — it's what the
developer and the next stage read first. All sections filled, citations
included; set `status: complete` in the
frontmatter as your LAST edit; run `pipeline advance`. On GATE, tell the
developer to review (they approve with `! pipeline approve`, then run
`/pipeline work` to build the plan) and STOP.
