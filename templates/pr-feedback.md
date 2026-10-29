---
run: __RUN__
stage: __STAGE__
status: draft
---

# PR Feedback — __RUN__: <!-- the task in one plain line — same as the plan's title -->

<!-- Above '# Pipeline details': for a person, one screen, plain words
     (machine-checked: human_part, plain_language). This file accumulates
     across feedback rounds — the half above describes the LATEST round;
     superseded rounds live in '## History'. -->

## What reviewers want
<!-- One bullet per reviewer comment, in plain words: what they asked for,
     whether they are right, and what you propose (change it / answer them /
     push back). The developer decides each — write it so they can decide
     from this list alone. -->

## Questions for you
<!-- The decisions this round needs: "accept 1 and 2, reject 3 — agree?"
     Always present here; the developer's call is the point of this gate. -->

# Pipeline details

## Comments
<!-- One row per unresolved review thread THIS round. Verify each claim against
     the code before classifying. Class: code-change / design-change /
     answer-only / out-of-scope / disputed.
     | # | Author · location | Comment (gist) | Class | Proposed action |
     |---|-------------------|----------------|-------|-----------------|
     | 1 | @rev · app/x.rb:42 | "…" | code-change | change X to Y (reopen IMPLEMENT) | -->

## Replies
<!-- Drafted replies for answer-only and disputed rows — verbatim, ready to
     post. NEVER posted before the developer approves them; disputed rows are
     the developer's call. -->

## Outcome
<!-- Filled as the round resolves: which comments were accepted (reopen target,
     what was dispatched), rejected/answered (reply posted), deferred
     (follow-up ticket). -->

## History
<!-- Append-only archive of superseded ROUNDS. Empty until round 2. Move the
     prior round's Comments / Replies / Outcome here under a collapsed
     <details> block; keep the sections above reflecting the CURRENT round.
     <details><summary>Round 1 — YYYY-MM-DD · <outcome></summary>

     …the full prior-round content, verbatim…
     </details> -->
