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
`artifacts/01-context.md` (template pre-copied). Two halves, split by the
`# Pipeline details` line:
- **Above it — for the developer**: What we're doing, Why, What changes,
  Acceptance criteria, and (only when there is one) Questions for you.
- **Below it — for the agents and the gates**: Requirements, Criteria
  population, Decisions, Findings, Open questions.

## Writing the developer's half (machine-checked: human_part, plain_language)
The reader is a junior developer who has never opened this pipeline. Write
for them: product words (user, school, login page, email), no file paths,
no mechanism, none of the pipeline's vocabulary — not "criterion AC#3", not
"population", not "blocking", not "artifact". Under 300 words of prose, no
table cell over 30 words, no line with three bold spans; the gate refuses
more. Evidence, sources, and the reasoning that got you there go below the
marker — the half above states the conclusion, the half below proves it.

- `## What we're doing` — 3–5 sentences: who is affected, what they see
  today, what will change, and what "done" looks like in the developer's words.
- `## Why` — the cause in 1–3 sentences. **When the cause crosses two or more
  systems, or takes three or more steps to tell, draw it** — a mermaid
  `sequenceDiagram` for a flow between systems, a `flowchart` for a decision,
  plain-word labels. A diagram replaces the paragraphs; it does not join them.
- `## What changes` — one bullet per change a person can notice, and what
  does NOT change when someone might assume it does.
- `## Acceptance criteria` — the table below; the numbers are keys the later
  stages use, never renumber.
- `## Questions for you` — only when something needs an answer before
  planning; one bullet per question with your proposed default. Delete the
  section otherwise.

## Procedure
- Restate requirements in your own words; note what the task does NOT say.
- Read the routed docs and code. EVERY finding carries a source citation
  (path). Mark each claim curated-doc-backed vs inferred.
- **Ask the developer** everything needed to plan confidently: ambiguities,
  constraints, scope edges, and what "done" looks like. One batch, in chat.
- From their answers, write `## Acceptance criteria` as a table
  (# | Now | After this ships | How to check): numbered from 1, each row
  checkable on its own, every cell a plain sentence under 30 words — these
  drive the plan's testing strategy and QA's audit later.
  - **Write "After this ships" as an observable end state, never as a
    mechanism.** "The form saves the mode" is a claim about code: it passes
    while every record already out there stays broken. "A school stored as
    bulk runs delta on its next scheduled sync" is a claim about the world,
    and it stays red until the existing data is handled too. A
    mechanism-level criterion is how a change ships as a fraction of the fix
    while every check is green.
  - **Population** is answered per criterion in `## Criteria population`
    below the marker (| # | Population |, machine-checked by `ac_population`)
    and takes one of `new` / `existing` / `both` / `n-a`. Ask it out loud,
    with the developer, in their words: *what about the records that are
    already wrong?* If the answer is `existing` or `both`, the
    migration/backfill belongs in this run's scope or in the out-of-scope
    list — decided here, not discovered at review.
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
The developer's half reads as one screen a junior could follow, and the
title line says what the task is in plain words. All sections filled,
citations included below the marker; set `status: complete` in the
frontmatter as your LAST edit; run `pipeline advance`. On GATE, tell the
developer to review (they approve with `! pipeline approve`, then run
`/pipeline work` to build the plan) and STOP.
