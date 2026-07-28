---
run: __RUN__
stage: __STAGE__
status: draft
critic: { rounds: 0, blocking_open: 0 }
---

# Implementation Plan — __RUN__

<!-- BLUF header: a human-facing summary above the first ## section. Not validated,
     but the first thing the developer and the next stage read — fill it before
     status: complete. Keep it to these few lines. -->
> **PLAN · __RUN__** — <!-- DECISION in one line: the chosen approach. -->
>
> **Files** <!-- N --> · **Subtasks** <!-- M --> · **Critic** <!-- R rounds, B blocking -->
>
> **TL;DR** — <!-- 1–2 sentences: what ships and why. -->
>
> **Needs you** — <!-- e.g. "Approve to start IMPLEMENT", or a blocking open question. -->

## Approach
<!-- The technical approach: chosen pattern and why. Confidence notes: which
choices rest on curated docs vs inference. -->

## Affected files
<!-- A table, one row per file. Columns: Path (backticked) | Change | New?
     Files the plan CREATES get (new) in the New? column. Keep every path
     backticked — this section is machine-parsed into the IMPLEMENT write
     boundary; anything outside it blocks the diff.
     | Path | Change | New? |
     |------|--------|------|
     | `app/x.rb` | what changes here | |
     | `app/y.rb` | scaffolded | (new) | -->

## Risks
<!-- A table, one row per risk. Columns: Risk | Severity (low/med/high) | Test map.
     EVERY risk must reappear (by the same wording) in the TEST stage's
     '## Risk-to-test map'. Include edge cases and applicable documented gotchas.
     | Risk | Severity | Test map |
     |------|----------|----------|
     | what could go wrong | med | AC#N / how it's covered | -->


## Subtasks
<!-- Numbered. Each small enough to review as ONE diff and commit. -->

## Testing strategy
<!-- Per subtask: which test type and why, per the repo's conventions. -->

## Open questions
<!-- Blocking vs non-blocking. Write 'None.' if none. -->

## Amendments
<!-- Append-only after approval. Never rewrite approved sections. -->
<!-- (optional section — not required by validators until an amendment exists) -->
