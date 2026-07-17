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

## Procedure
- **Coverage audit**: for each changed file, locate its tests via the
  profile's test layout; list changed branches/paths with no covering test.
- **Risk-to-test map**: EVERY entry from the plan's `## Risks` maps to a test
  (name it) or `not tested because <reason>`. Nothing silently dropped.
- Write the missing tests that the audit and map justify. Screen them for
  flakiness risks: time/date dependence, async waits, shared state, order
  dependence — follow repo playbooks when bound.
- Run the profile's `test_targeted` command; only green tests are presented.
- Deferred edge cases go under `## Deferred` — the developer sees them at the
  gate; recorded, not dropped.

## Done when
Report complete (`status: complete` LAST), tests green; `pipeline advance`;
present the report and STOP.
