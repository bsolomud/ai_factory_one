# Stage: CONTEXT

Turn the ticket into a cited, self-contained context artifact. This may be a
re-entry after an interruption: if `01-context.md` has partial content, review
it against the steps below and continue — do not assume a clean slate.

## Inputs
1. The ticket: the developer supplied an ID, a link, or pasted text at intake.
   If only an ID and you cannot resolve it, ask the developer to paste the
   ticket body — never invent requirements.
2. The repo's knowledge layer: the profile's `knowledge` binding (curated docs)
   or the pipeline home `knowledge/index.md`. Read the index, then only the
   facts it routes to for this feature area.
3. The actual code the knowledge layer points to.

## Output
`artifacts/01-context.md` (template pre-copied). Required sections:
Requirements, Findings, Open questions.

## Procedure
- Restate requirements and acceptance criteria in your own words; note what the
  ticket does NOT say.
- Read the routed docs and code. EVERY finding carries a source citation
  (path). Mark each claim curated-doc-backed vs inferred.
- Collect open questions. Split **Blocking** (human must answer before PLAN)
  from **Non-blocking** (state the assumption you will proceed with).
- Do not design a solution here — that is PLAN's job.

## Done when
All three sections are filled, citations included; set `status: complete` in
the frontmatter as your LAST edit; run `pipeline advance`. If it reports GATE,
tell the developer what to review (especially blocking questions — they answer
by editing the artifact) and STOP.
