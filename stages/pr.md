# Stage: PR

Generate the PR from the pipeline artifacts — NEVER by cold-reading the diff.
The artifacts already explain what/why/how-tested; your job is assembly.

## Inputs
`artifacts/02-plan.md`, `03-progress.md`, `04-test-report.md`, `05-review.md`;
the profile's PR conventions; the repo's PR template when one exists.

## Output
`artifacts/06-pr-draft.md`. Required sections: Title, Description,
Testing notes, Ops notes, Reviewer guidance.

## Procedure
- **Title** per the profile's convention (ticket prefix etc.).
- **Description**: what/why from the plan; changes from the progress log;
  honor the repo's PR template structure.
- **Testing notes** from the test report: covered automatically vs
  verify-manually.
- **Ops notes**: anything the diff touches in migrations, config, jobs, CI —
  or `None.`.
- **Reviewer guidance**: suggested reading order, riskiest hunks first.

## Done when
Artifact complete; `pipeline advance`; the developer edits/approves the draft
text at the gate. **Only after that approval** push the branch and open the PR
— as a DRAFT, ticket linked, never self-approved. (The guard physically blocks
pushing before this gate is approved.) Then STOP.
