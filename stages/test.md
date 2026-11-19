# Stage: TEST

Make the plan's risk list executable. Audit what the diff changed; every risk
gets a test or an explicit, written reason it doesn't.

## Inputs
1. The full branch diff vs the base branch.
2. `artifacts/02-plan.md` — the `## Risks` section drives the map.
3. The repo's test conventions: profile `test_layout` + bound docs; mimic
   neighboring test files, never import foreign style.

## Output
`artifacts/04-test-report.md`. Above the `# Pipeline details` line, for the
developer: What we checked (and Questions for you, only when there is one).
Below it: Coverage audit, Risk-to-test map, Added tests, Deferred — and Ran
the change when the repo can run one.

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
- **Run the change, not only its tests** (`verify_ran`). A unit test can pass
  while the feature is broken; starting the app and using it cannot be fooled
  that way. When the profile has a `verify` command, run it; when it binds a
  `verify` skill, execute that skill (it drives the app — a browser, a
  simulator, an API harness) and record `pipeline used skill <its path>`. For
  each acceptance criterion and user-visible path the change touches, write a
  row in `## Ran the change`: what you did, citing the command or skill step,
  and what the running app showed. The gate runs the `verify` command itself
  as well. **Three failed fix attempts against the same verify failure: stop**
  and put it to the developer — a fourth guess costs more than their minute.
  No way to run it in this checkout → one line `Not run: <why>`; it reaches
  the PR's Testing notes. Neither configured → skip the section.
- **Self-certify with `pipeline check` before setting `status: complete`.** It
  runs the gate's own validators — the criterion accounting, the proof ledger
  and its staleness stamp, the profile checks — and records nothing. A stale
  stamp or an unaccounted criterion found here costs one edit; found at
  `advance` it costs a blocked event and a fresh dispatch.
- **Stacked run (based on a branch, not the trunk)?** Run
  `pipeline base-health` before calling any failure pre-existing — the gate
  requires it (`base_health`). RED → every failure that also fails on the
  base goes under `## Base health` with the CI link, as "base red"; the rest
  are this change's. UNKNOWN → run that test at the base tip before calling
  it pre-existing. A pilot run logged 45 inherited failures as "pre-existing"
  without naming the base, and CI re-diagnosed all of them from scratch.
- If a profile check blocks for reasons you cannot map to the branch diff,
  follow the pipeline's **gate-triage** skill
  (`~/.claude/skills/gate-triage/SKILL.md`): reproduce, classify, then act.
- Write the results into `04-test-report.md`; deferred edge cases go under
  `## Deferred` — the developer sees them at the gate; recorded, not dropped.

## Done when
`## What we checked` (above the `# Pipeline details` line) tells the
developer, in product words, what now has a test that fails without the
change, what has to be checked by hand and how, and what was left out — no
spec paths, no pipeline vocabulary. Report complete
(`status: complete` LAST), tests green; `pipeline advance`;
present the report and STOP.
