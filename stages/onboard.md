# Stage: ONBOARD (one time per repo)

Make this repository pipeline-ready WITHOUT writing anything into it. The result
is a human-confirmed `profile.yml` in the pipeline home (`status` printed its path).

## Inputs
1. The repository itself: build/dependency manifests, linter/test configs, CI
   config, docs (`README`, `CONTRIBUTING`, agent docs like `CLAUDE.md`/`AGENTS.md`).
2. Conventional repo-skill locations: `.ai/skills/`, `.claude/skills/`,
   `.claude/commands/` — plus docs that reference them.
3. Recent git history and merged PRs (naming conventions, base branch).

## Output
`profile.yml` in the pipeline home for this repo (path from `pipeline status`).
Schema: see an annotated example in the framework README.

## Procedure
1. **Detect (evidence first).** From the repo's manifests and configs, list the
   lint, test, and hook commands this repo actually uses. Every proposal must
   name its evidence file.
2. **Verify by execution.** Run each proposed command ONCE (scoped to a small
   target if it takes arguments). A command that does not run never enters the
   profile.
3. **Bind repo assets.** For each pipeline stage, propose: repo asset (a found
   skill/doc) vs built-in. Ambiguous matches → ask the developer:
   use-instead / use-alongside / ignore. Record each binding with a content hash.
4. **Interview — repo facts only.** Base branch, branch/PR naming conventions,
   canonical command when several exist, `no_touch` paths, test layout mapping.
   Prefill every answer from detection. Never ask about task-tracker access here.
5. **Record evidence hashes** for the files detection relied on — staleness
   triggers re-sync later.
6. **Write the profile** with slots: `lint_changed`, `test_targeted`,
   `post_change_hooks` (empty slot = recorded honestly, checks become UNVERIFIED).

## Done when
The developer has reviewed the full profile and confirmed it. Show them the file
content and wait for explicit confirmation — wrong bindings fixed once here
instead of poisoning every later stage. Then re-run `pipeline status`.
