---
run: __RUN__
stage: __STAGE__
status: draft
---

# CI Analysis — __RUN__: <!-- the task in one plain line — same as the plan's title -->

<!-- Above '# Pipeline details': for a person, one screen, plain words
     (machine-checked: human_part, plain_language). This file accumulates
     across the CI loop — the half above describes the LATEST run; per-run
     detail lives in '## Runs analyzed'. -->

## Where CI stands
<!-- 2–4 sentences. Is the PR green and mergeable? If not: what failed, in
     product words, whether it is our change or the build, and what was done
     about it. Link the PR. -->

## Questions for you
<!-- ONLY when the developer has to act: "green — merge when ready", or a
     re-run they must trigger. Delete otherwise. -->

# Pipeline details

## Runs analyzed
<!-- A table, one row per CI run. Columns: Run | Result | Failed jobs.
     Appended per run — this artifact accumulates across the CI loop; keep
     '## Where CI stands' reflecting the LATEST run.
     | Run | Result | Failed jobs |
     |-----|--------|-------------|
     | link/id | red / green | which jobs failed, or "—" | -->

## Classification
<!-- Per failure: deterministic / suspected-flake / lint / infrastructure —
with the evidence. Infra → recommend re-run, never invent code fixes. -->

## Fixes
<!-- Per approved fix: hypothesis, the ONE change made, commit. Reproduce
before fixing; one hypothesis per CI run; after 2 failed attempts STOP and
build diagnostics instead of guessing. -->

## Outcome
<!-- Final state: green run link, or where it stands. -->

## History
<!-- Append-only archive of superseded CI ROUNDS — e.g. after a reopen/re-run that
     redoes the analysis. Empty until the first such re-run. Move the prior round's
     Classification / Fixes / Outcome here under a collapsed <details> block; keep
     the sections above reflecting the CURRENT round. (The per-run rows in
     '## Runs analyzed' already accumulate as a log — this is for superseded
     whole-round analyses, not individual runs.)
     <details><summary>Round 1 — YYYY-MM-DD · <outcome></summary>

     …the full prior-round content, verbatim…
     </details> -->
