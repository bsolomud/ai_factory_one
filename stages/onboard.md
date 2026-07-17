# Stage: ONBOARD (run any time — `/pipeline onboard` re-onboards)

Make this repository pipeline-ready WITHOUT writing anything into it. The
result is a developer-confirmed `profile.yml` in the pipeline home
(`profile_path` from the `pipeline onboard` output). Re-onboarding is the
normal way to change behavior for a repo: prefill everything from
`existing_profile`, show current values, ask what to change — NEVER silently
drop a previous answer.

## Inputs
1. The `pipeline onboard` JSON: `candidates` (mechanically scanned repo
   skills, commands, agent docs, knowledge dirs), `existing_profile`,
   `reonboarding`.
2. The repository: build/dependency manifests, linter/test configs, CI
   config, docs.
3. The developer — this stage is an interview.

## Procedure

### 1. Analyze how to work with the repo
From manifests and configs, propose the repo's lint / targeted-test / hook
commands with the evidence file for each. **Verify by execution**: run each
proposed command ONCE (scoped to a small target). A command that does not run
never enters the profile.

### 2. Skill binding — the core question
For each pipeline capability that has built-in behavior — **plan, review,
test, ci, knowledge** — check `candidates` for a repo-local equivalent
(e.g. a repo review skill vs the pipeline's built-in reviewer). Present a
table: capability | repo asset found | built-in equivalent. Then ask the
developer to choose ONE binding mode:

1. **Use all from repo** — wherever a repo asset exists, it wins; built-ins
   only fill the gaps.
2. **Replace all (use ai_factory_one)** — built-ins everywhere; repo assets
   ignored.
3. **Decide per skill** — go through the table one row at a time:
   `use repo` / `use built-in` / `use both` (repo asset runs first, built-in
   pass on top).

Record every binding in the profile with a content hash (get it from
`pipeline hash <path> --repo <slug>`) so edits to a bound asset trigger
`PROFILE_STALE` on the next run — the developer is asked to re-confirm, not
silently bypassed.

### 3. Interview — repo facts only
Base branch, branch/PR naming, canonical command when several exist,
`no_touch` paths, test layout mapping. Prefill from detection (and from
`existing_profile` when re-onboarding). Never ask about task-tracker access
here.

### 4. Write the profile
`profile.yml` at `profile_path`, with: `commands` slots (empty slot =
recorded honestly, checks become UNVERIFIED), `test_layout`, `conventions`,
`no_touch`, `bindings` (mode + per-capability source/path/sha), and
`evidence_hashes` for the files detection relied on (`pipeline hash` again).

### 5. Confirm
Show the developer the full profile and wait for explicit confirmation —
wrong bindings get fixed once here instead of poisoning every later stage.
Then re-run `pipeline status` to prove the profile loads (and registers the
repo for any-folder use).

## Done when
The developer confirmed the profile and `pipeline status` answers
NO_ACTIVE_RUN (or ACTIVE_RUN) instead of NO_PROFILE. Tell them: `/pipeline
start <task>` begins work; `/pipeline onboard` any time to change these
choices.
