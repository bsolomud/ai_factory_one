---
run: __RUN__
stage: __STAGE__
status: draft
# Machine-read by review_counts (gate) and metrics — keep consistent with
# '## Findings'. blocking must reach 0 (fixed or moved to Disputed) to advance.
findings: { blocking: 0, advisory: 0, fixed: 0, disputed: 0 }
---

# Review — __RUN__: <!-- the task in one plain line — same as the plan's title -->

<!-- Above '# Pipeline details': for a person, one screen, plain words
     (machine-checked: human_part, plain_language). On a re-review it
     describes the LATEST round; older rounds live in '## History'. -->

## What we found
<!-- First sentence: is this ready to open a PR, or not, and why in a phrase.
     Then one bullet per problem worth a person's attention, in product words:
     what could go wrong for a user, whether it is fixed already, and what is
     still open. Nits and style go below, not here. If nothing was found, say
     so in a sentence and stop. -->

## Questions for you
<!-- ONLY when a finding needs the developer's call — two ways to fix
     something, or a point the implementer disputes. Delete otherwise. -->

# Pipeline details

## Blind pass
<!-- PASS A: what the diff looks like to someone who has never read the plan.

     Written by a reviewer that was given the branch diff and the repo — and NOT
     artifacts/01-context.md or 02-plan.md. That withholding is the point: a model
     reviewing its own work in the same context corrects far less than the same
     model shown the identical code as someone else's, and the plan is the single
     most contaminating artifact because it carries the rationale that made every
     shortcut feel reasonable.

     Record here, in a few lines each:
       - What does this diff appear to be trying to do, judged only from the code?
       - Where does that differ from what the plan says it does? (fill in AFTER
         pass B opens the plan — a gap between the two readings is a finding
         about the code's legibility, and often about the code.)
       - Which parts of the diff could you not explain from the repo alone?

     Findings from this pass belong in '## Findings' like any other. -->

## Findings
<!-- A table, one row per finding (fresh-context review of the full branch diff),
     each verified before flagging. Columns: Severity | Location | Finding | Status.
     Severity = blocking/major/minor/note; Status = confirmed/fixed/disputed.
     Write 'None.' (no table) if clean.
     | Severity | Location | Finding | Status |
     |----------|----------|---------|--------|
     | note | `base.rb:62` | what you found | confirmed | -->

## Coupling
<!-- Re-verification of the plan's '## Coupling' table against the SHIPPED code,
     same four columns (Subject | Evidence command | Hits | Disposition) and the
     same machine check (evidence_verified re-runs each command here too).

     Why it is re-done rather than inherited: the fix loop moves code. A hit count
     taken at PLAN describes the code as planned, and the rows the fix loop touched
     are exactly the ones whose coupling is most likely to have changed. Carry
     forward the rows that still hold, re-run them, and ADD a row for every symbol
     the fix loop newly wrote or removed.

     If a fix in this round introduced a new caller, a new persisted value, or a
     new nil path, that is a new Subject — not a footnote on an old row. -->

## Fixes applied
<!-- Confirmed findings fixed in the fix loop, with commits. 'None.' if none. -->

## Disputed
<!-- Findings the implementer disputes — both sides' reasoning, for the
developer to arbitrate at the gate. 'None.' if none. -->

## Plan-vs-shipped check
<!-- Does the final shape still match the approved plan (incl. amendments)?
List any drift — each item becomes an amendment or an explicit decision here. -->

## Untested claims
<!-- Machine-checked (untested_claims). One row per row of the test report's
     '## Risk-to-test map' whose Coverage says 'not tested'. Each is a claim about
     behaviour that a PR reviewer will read as fact, and reading the code is not
     enough to repeat it: a pilot run's claim ("a single sync only clears the
     status") was re-read, agreed with, shipped in the PR body, and was wrong.
       Claim   — the test report's Risk cell, same wording.
       Proof   — the repo-relative path of a test file you RAN that shows the
                 behaviour (`spec/models/x_spec.rb:12`), or 'Not verified'.
       PR note — for 'Not verified' only: one plain sentence the PR's
                 'Testing notes' carries word for word (untested_in_pr).
     'Not verified' never blocks; leaving a claim out does. Delete this section
     when the test report has no 'not tested' rows.
     | Claim | Proof | PR note |
     |-------|-------|---------|
     | claim, same wording | `spec/x_spec.rb:12` | |
     | claim, same wording | Not verified | Pressing Sync on one user was not tested by hand or by a test. | -->

## Team skill trace
<!-- Machine-checked (skill_trace) ONLY when the profile binds a repo review
     skill; delete it otherwise. The skill is executed, not read: one row per
     step of the skill you ran, and every 'What I did' cites the `file:line` it
     was applied to or the `command` you ran (a Verdict row may only sum up).
     Record the skill and each of its files the trace cites with
     'pipeline used skill <path>'.
     | Step | What the skill asks | What I did |
     |------|---------------------|------------|
     | 1. Diff | the full diff vs base | `git diff master...HEAD` — 12 files | -->

## History
<!-- Append-only archive of prior review ROUNDS. Empty until the first re-review.
     On a re-review: move the previous round's content here wrapped in a collapsed
     <details> block, then refresh '## What we found' + the sections above to
     reflect the LATEST round only. Never rewrite or delete an archived round.
     <details><summary>Round 1 — YYYY-MM-DD · <outcome> (head &lt;sha&gt;)</summary>

     …the full prior-round content, verbatim…
     </details> -->
