---
run: __RUN__
stage: __STAGE__
status: draft
---

# PR Draft — __RUN__: <!-- the task in one plain line — same as the plan's title -->

<!-- The whole draft is read by people — the developer at this gate, then the
     PR reviewers. There is no '# Pipeline details' half: every section is
     written in plain words and the vocabulary and length rules apply to all of
     it (machine-checked: human_part, plain_language). Generated FROM the
     earlier artifacts' developer-facing halves — never by cold-reading the
     diff. -->

## Title
<!-- Per the profile's PR title convention. -->

## Description
<!-- Start from the plan's '## What we're doing' and '## Why' (keep the diagram
     if there is one), then '## What changes' from the context — tightened to
     what a reviewer needs. Honors the repo's PR template when one exists.
     Under 300 words in total across the draft. A decision the developer
     changed ('Decision changed' in the plan's Amendments) is stated here in
     its new words, word for word (decisions_current). -->

## Testing notes
<!-- From the test report's '## What we checked': what a test proves, and what
     a reviewer has to try by hand and how. Every 'Not verified' PR note from
     the review's '## Untested claims' goes here word for word (untested_in_pr). -->

## Ops notes
<!-- Migrations, config, jobs, CI touched by the diff, and anything that has to
     happen before or after merge — or 'None.'. -->

## Reviewer guidance
<!-- Suggested reading order; riskiest hunks first, in a sentence each. Every
     review finding the developer deferred goes here word for word
     (deferred_in_pr). -->

## Questions for you
<!-- ONLY for the developer at this gate: the push needs their OK, and any
     action before merge (set a variable on staging, run a migration). Delete
     when the push is the only ask. -->
