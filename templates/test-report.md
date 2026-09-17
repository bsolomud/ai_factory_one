---
run: __RUN__
stage: __STAGE__
status: draft
# The proof ledger — machine-read by ac_proofs (gate). One entry per acceptance
# criterion: the test you WATCHED go red without the fix, and exactly what you
# broke to make it red. A green suite proves the tests pass; only a test that has
# been seen to fail proves it would notice the bug coming back.
#   proofs:
#     - { ac: 1, test: 'spec/x_spec.rb:41', mutation: 'reverted the guard at app/x.rb:22' }
# proof_stamp comes from 'pipeline proof-stamp', run right after the last proof.
# It hashes the plan's '## Affected files', so the ledger EXPIRES the moment the
# code under test changes — which is what stops a fix round from inheriting an
# earlier round's proof.
proofs: []
proof_stamp:
---

# Test Report — __RUN__

<!-- BLUF header: a human-facing summary above the first ## section. Not validated,
     but the first thing the developer and the next stage read — fill it before
     status: complete. -->
> **TEST · __RUN__** — <!-- OUTCOME at a glance, e.g. "136 examples green · coverage complete" -->
>
> **Tests** <!-- N green --> · **Coverage** <!-- complete / gaps --> · **Deferred** <!-- n -->
>
> **TL;DR** — <!-- 1–2 sentences: coverage state and any gap. -->
>
> **Needs you** — <!-- e.g. "Two edge cases left untested (below) — OK to ship without them?", or "Nothing." -->

## Coverage audit
<!-- A table, one row per changed file. Columns: File | Tests | Gaps.
     Tests = its spec(s) via the profile's test layout; Gaps = changed
     branches/paths lacking coverage (or "—").
     | File | Tests | Gaps |
     |------|-------|------|
     | `app/x.rb` | `spec/x_spec.rb` | none / what's uncovered | -->

## Risk-to-test map
<!-- A table, one row per plan risk AND one per acceptance criterion.
     Columns: Risk | Test | Coverage. EVERY risk from the plan's '## Risks'
     appears here, and EVERY acceptance criterion referenced by id as AC#<n>
     (machine-checked: ac_traceability blocks on any AC#<n> missing from this
     map and from '## Deferred'). Coverage is 'covered' /
     'not tested because X' / 'n/a'. Nothing silently dropped.
     | Risk | Test | Coverage |
     |------|------|----------|
     | plan risk (same wording) | the test that pins it | covered |
     | AC#1 — what must be true | the test that proves it | covered | -->

## Added tests
<!-- Tests written/extended in this stage. Only green tests are presented. -->

## Deferred
<!-- Edge cases deferred at the gate — recorded, not dropped. 'None.' if none. -->
