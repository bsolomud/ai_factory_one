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
- Audit coverage against the branch diff; build the risk-to-test map (every
  plan risk AND every acceptance criterion → a named test or `not tested
  because <reason>`); write the justified missing tests in the repo's own
  style; screen them for flakiness; only green work is presented.
- Write the results into `04-test-report.md`; deferred edge cases go under
  `## Deferred` — the developer sees them at the gate; recorded, not dropped.

## Done when
Report complete (`status: complete` LAST), tests green; `pipeline advance`;
present the report and STOP.
