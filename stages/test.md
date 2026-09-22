# Stage: TEST

Make the plan's risk list executable. Audit what the diff changed; every risk
gets a test or an explicit, written reason it doesn't.

## Inputs
1. The full branch diff vs the base branch.
2. `artifacts/02-plan.md` — the `## Risks` section drives the map.
3. The repo's test conventions: profile `test_layout` + bound docs; mimic
   neighboring test files, never import foreign style.

## Output
`artifacts/04-test-report.md`. Required sections: Coverage audit,
Risk-to-test map, Added tests, Deferred.

## Procedure (executed by `pipeline-qa`, fresh context)
- Audit coverage against the branch diff; build the risk-to-test map as a table
  (every plan risk AND every acceptance criterion → a named test or `not tested
  because <reason>`); reference criteria by id as `AC#<n>` — `advance`
  machine-checks that every AC#<n> from the context appears in the map or
  under `## Deferred`. A plan risk row is a CLAIM about a failure mode: for
  degradation-class risks, the mapped test must reproduce the predicted
  failure, not just exercise the code path. Write the justified missing tests
  in the repo's own style; screen them for flakiness; only green work is
  presented.
- **Prove every criterion, do not assert it** (`ac_proofs` gates on this). A
  green suite proves the tests pass. It does not prove that any of them would
  notice the bug coming back — on a pilot PR the reviewer deleted a
  load-bearing call and the whole suite stayed green, so a fix that pinned
  nothing had been riding along as "covered". For each acceptance criterion:
  1. Break the fix — revert the hunk, delete the guard, flip the condition.
  2. Run the mapped test. It must go **RED**. If it stays green, the test is
     about something else: fix the test, not the record.
  3. Restore, re-run, confirm **GREEN**.
  4. Record it in the frontmatter `proofs:` ledger — `{ ac, test, mutation }`,
     where `mutation` states exactly what you broke, so the next person can
     re-run the proof instead of trusting it.
  Then run `pipeline proof-stamp` and paste what it prints into `proof_stamp:`.
  The stamp hashes the plan's `## Affected files`, so the ledger EXPIRES the
  moment the code under test changes — which is what stops a later fix round
  from inheriting a proof its own change already invalidated.
- **Self-certify with `pipeline check` before setting `status: complete`.** It
  runs the gate's own validators — the criterion accounting, the proof ledger
  and its staleness stamp, the profile checks — and records nothing. A stale
  stamp or an unaccounted criterion found here costs one edit; found at
  `advance` it costs a blocked event and a fresh dispatch.
- If a profile check blocks for reasons you cannot map to the branch diff,
  follow the pipeline's **gate-triage** skill
  (`~/.claude/skills/gate-triage/SKILL.md`): reproduce, classify, then act.
- Write the results into `04-test-report.md`; deferred edge cases go under
  `## Deferred` — the developer sees them at the gate; recorded, not dropped.

## Done when
Fill the BLUF header at the top (Outcome, TL;DR, Needs you). Report complete
(`status: complete` LAST), tests green; `pipeline advance`;
present the report and STOP.
