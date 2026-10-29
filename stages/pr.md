# Stage: PR

Generate the PR from the pipeline artifacts — NEVER by cold-reading the diff.
The artifacts already explain what/why/how-tested; your job is assembly.

## Inputs
`artifacts/02-plan.md`, `03-progress.md`, `04-test-report.md`, `05-review.md`;
the profile's PR conventions; the repo's PR template when one exists.

## Output
`artifacts/06-pr-draft.md`. Required sections: Title, Description,
Testing notes, Ops notes, Reviewer guidance — all of them read by people, so
the whole draft follows the developer-half rules (plain words, no pipeline
vocabulary, under 300 words; machine-checked). Build it from the earlier
artifacts' halves above their `# Pipeline details` lines.

## Procedure
- **Title** per the profile's convention (ticket prefix etc.).
- **Description**: what/why from the plan; changes from the progress log;
  honor the repo's PR template structure.
- **Testing notes** from the test report: covered automatically vs
  verify-manually. Every `Not verified` PR note in the review's
  `## Untested claims` goes in word for word (`untested_in_pr` checks it) — a
  PR reviewer must see what nobody checked, not read it as settled.
- **Ops notes**: anything the diff touches in migrations, config, jobs, CI —
  or `None.`.
- **Reviewer guidance**: suggested reading order, riskiest hunks first. Every
  review finding the developer chose to leave (`pipeline finding … --deferred`)
  goes in word for word (`deferred_in_pr` checks it): the reviewer reads it
  from you instead of finding it.
- **Decisions the developer changed** (`Decision changed` lines in the plan's
  `## Amendments`): the Description states each new decision in the words
  recorded with it (`decisions_current` checks), and nothing in the draft
  still describes the old one. If the PR is already published, after this
  gate update its body from the approved draft (`gh pr edit <n> --body-file
  …`) and re-run `pipeline pr-opened <url>` — the CI gate checks it.

## Done when
The whole draft is written for people — built from the developer-facing
halves of the plan, context and test report, never by cold-reading the diff;
`## Questions for you` spells out the push approval and any ops action
before merge. Artifact complete;
`pipeline advance`; the developer edits/approves the draft
text at the gate. **Only after that approval** push the branch and open the PR
— as a DRAFT, ticket linked, never self-approved. (The guard physically blocks
pushing before this gate is approved.) Record it at once:
`pipeline pr-opened <the PR url>` — CI and PR feedback read it from
`pipeline status` instead of searching. Then STOP.
