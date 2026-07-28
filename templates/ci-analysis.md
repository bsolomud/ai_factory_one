---
run: __RUN__
stage: __STAGE__
status: draft
---

# CI Analysis — __RUN__

<!-- BLUF header: a human-facing summary above the first ## section. Not validated.
     This artifact accumulates across the CI loop — keep the header reflecting the
     LATEST run; per-run detail lives in ## Runs analyzed. -->
> **CI · __RUN__** — <!-- OUTCOME, e.g. "green · PR #988 mergeable" or "red · 2 failing" -->
>
> **CI** <!-- green / red --> · **PR** <!-- #id / state --> · **Red runs** <!-- n -->
>
> **TL;DR** — <!-- 1–2 sentences: current CI state. -->
>
> **Needs you** — <!-- e.g. "human merge of PR #988", or "Nothing yet." -->

## Runs analyzed
<!-- A table, one row per CI run. Columns: Run | Result | Failed jobs.
     Appended per run — this artifact accumulates across the CI loop; keep the
     BLUF header reflecting the LATEST run.
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
