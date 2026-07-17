---
run: __RUN__
stage: __STAGE__
status: draft
---

# CI Analysis — __RUN__

## Runs analyzed
<!-- One entry per red CI run: link/id, failed jobs. Appended per run — this
artifact accumulates across the CI loop. -->

## Classification
<!-- Per failure: deterministic / suspected-flake / lint / infrastructure —
with the evidence. Infra → recommend re-run, never invent code fixes. -->

## Fixes
<!-- Per approved fix: hypothesis, the ONE change made, commit. Reproduce
before fixing; one hypothesis per CI run; after 2 failed attempts STOP and
build diagnostics instead of guessing. -->

## Outcome
<!-- Final state: green run link, or where it stands. -->
