---
run: __RUN__
stage: __STAGE__
status: draft
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
> **Needs you** — <!-- what to arbitrate (see ## Disputed), or "Nothing — advance to PR." -->

## Findings
<!-- A table, one row per finding (fresh-context review of the full branch diff),
     each verified before flagging. Columns: Severity | Location | Finding | Status.
     Severity = blocking/major/minor/note; Status = confirmed/fixed/disputed.
     Write 'None.' (no table) if clean.
     | Severity | Location | Finding | Status |
     |----------|----------|---------|--------|
     | note | `base.rb:62` | what you found | confirmed | -->

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
