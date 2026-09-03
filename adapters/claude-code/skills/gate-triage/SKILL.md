---
name: gate-triage
description: ai_factory_one gate triage — for pipeline stage agents ONLY, inside an active run. Invoke when `pipeline advance` (or a profile check you ran) comes back red for reasons you cannot map to your own diff, or before your FIRST change in a run that has its own worktree. Classifies a red gate as real failure / harness defect / environment gap / not-locally-certifiable and gives the sanctioned action for each. NEVER invoke proactively or outside a pipeline run.
---

# Gate triage — classify before you touch anything

You are here for one of two reasons. Either way the rule is the same:
**never hand-tune around a red you have not classified.** A workaround
applied to an unclassified failure hides real defects and poisons the
run's audit trail.

- **Mode 1** — this run has its own worktree (handoff `workdir` ≠ the repo
  path) and you are about to make your FIRST change: run the preflight.
- **Mode 2** — a gate or profile check is red and the failure does not map
  to anything in your diff: run the decision tree.

## Mode 1 — Worktree preflight

A fresh worktree is incomplete by construction: `worktree_setup` copies what
the profile knows about, and everything it doesn't becomes a mystery red at
the gate — or worse, a dead end discovered after the code is written. Verify,
don't assume:

1. **Learned checklist first.** If `knowledge_dir/worktree-preflight.md`
   exists, follow it and record
   `pipeline used knowledge worktree-preflight --repo <slug> --run <id>`.
2. **Dependencies resolve.** Run the profile's own commands in their cheapest
   liveness form (the same tiers onboarding used: config-parse for linters,
   version flag for test runners). A tool that doesn't resolve here will
   false-block the gate later.
3. **Local config present.** Compare gitignored config files against the main
   checkout (the profile's `worktree_setup` names the known ones). A copied
   config can still be WRONG for a worktree — a host/asset entry that points
   at a dev server only works while that server runs.
4. **Built artifacts.** If the plan touches anything exercised by JS/system/
   request specs, verify the build products exist (and the build tooling
   resolves) BEFORE implementing.
5. **Data stores.** If the plan includes migrations or DB-touching specs,
   check the schema state and any required local services now — and respect
   the repo's standing rules (some forbid migrating shared dev DBs).

Then decide **up front** which profile checks cannot be certified in this
tree, and say so in the artifact you'll produce — an honest "not locally
certifiable: <reason>" decided now beats one discovered at advance-time.

Every gap you find and fix: `pipeline feedback "[worktree] missing: <item>;
fix: <command>" --repo <slug>` — that note is how the profile's
`worktree_setup` gets the missing step added, so the next run doesn't
rediscover it.

## Mode 2 — Red-gate decision tree

### Step 1 — Reproduce outside the harness's file selection

The gate runs profile commands over a computed changed-file set. Before
believing the red, rerun the exact failing command by hand over the CORRECT
input:

- File set: `git diff --name-only --diff-filter=d <base>...HEAD` (deleted
  paths excluded), filtered to the file types the tool actually handles.
- Verify the base first: compare the run's recorded base against
  `git merge-base` reality. A stacked branch whose base defaulted to the
  default branch shows up as a phantom diff of hundreds of files — that is
  a base problem, not hundreds of findings.
- Untracked files that were already in the tree before the run are ambient,
  not yours; if the gate flags them, that is the `ignore-untracked` flow
  (developer-mediated), not a code problem.

### Step 2 — Classify

| Class | Signature (examples seen in real runs) |
|---|---|
| **Real failure** | Reproduces on the corrected input. Your change broke it. |
| **Harness defect** | Passes on corrected input, red only on the gate's selection: linter fed deleted paths; excluded files producing phantom offenses; wrong spec-file unions passed to a runner; ambient untracked files globbed in; wrong base. |
| **Environment gap** | The command fails for a reason Mode 1 would have caught: missing deps, unbuilt assets, absent local config/service. |
| **Not locally certifiable** | The check genuinely cannot run truthfully in this tree (e.g. it needs a migrated DB the repo's rules forbid migrating locally). |

### Step 3 — Act

| Class | Sanctioned action |
|---|---|
| Real failure | Fix the code. Normal loop — this skill is done. |
| Harness defect | Record it structurally: `pipeline feedback "[harness] slot=<slot> symptom=<one line> repro=<exact command> expected=<what correct input yields>" --repo <slug>`. Then apply the NARROWEST workaround whose corrected input genuinely passes (e.g. run the tool yourself on the filtered set and let the gate's own retry certify). A red that reproduces on correct input is real — full stop, no workaround. |
| Environment gap | Repair per Mode 1, then `[worktree]` feedback as above, then retry the gate. |
| Not locally certifiable | Record it honestly in the artifact's Deferred/Skipped section — it surfaces as unverified at the gate, which is correct. `pipeline declare-na` only with the developer's explicit confirmation, per the dispatcher's rule. |

**Dedupe before filing.** Grep this run's `events.jsonl` for the same
`slot=` + symptom, and check `~/.ai_factory_one/framework-proposals.md` —
if the defect is already recorded there, cite the existing entry in your
feedback note instead of re-deriving it.

## Hard rules

- Never approve a gate, never edit `state.json`/`events.jsonl`.
- `ignore-untracked` and `declare-na` are developer-mediated — propose,
  never run them to unblock yourself.
- This skill is triage, not a bypass: its purpose is that every `[harness]`
  note becomes a validator fix. If the same symptom keeps recurring, say so
  in your summary so the developer can escalate it.
