---
run: __RUN__
stage: __STAGE__
status: draft
# Machine-read by review_counts (gate) and metrics — keep consistent with
# '## Findings'. blocking must reach 0 (fixed or moved to Disputed) to advance.
findings: { blocking: 0, advisory: 0, fixed: 0, disputed: 0 }
---

# Pre-PR Review — __RUN__

<!-- BLUF header: a human-facing summary above the first ## section. Not validated,
     but the first thing the developer reads — fill it before status: complete.
     On a re-review, keep it reflecting the LATEST round; older rounds live in
     '## History' below. -->
> **REVIEW · __RUN__** — <!-- OUTCOME: APPROVE / CHANGES REQUESTED -->
>
> **Blocking** <!-- n --> · **Diff** <!-- files / commits --> · **Round** <!-- r -->
>
> **TL;DR** — <!-- 1–2 sentences: the verdict and why. -->
>
> **Needs you** — <!-- e.g. "Two ways to fix X — pick one (details below).", or "Nothing — ready for the PR." -->

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

## History
<!-- Append-only archive of prior review ROUNDS. Empty until the first re-review.
     On a re-review: move the previous round's content here wrapped in a collapsed
     <details> block, then refresh the header + the sections above to reflect the
     LATEST round only. Never rewrite or delete an archived round.
     <details><summary>Round 1 — YYYY-MM-DD · <verdict> (head &lt;sha&gt;)</summary>

     …the full prior-round content, verbatim…
     </details> -->
