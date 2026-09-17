---
run: __RUN__
stage: __STAGE__
status: draft
critic: { rounds: 0, blocking_open: 0 }
---

# Implementation Plan — __RUN__

<!-- BLUF header: a human-facing summary above the first ## section. Not validated,
     but the first thing the developer and the next stage read — fill it before
     status: complete. Keep it to these few lines. -->
> **PLAN · __RUN__** — <!-- DECISION in one line: the chosen approach. -->
>
> **Files** <!-- N --> · **Subtasks** <!-- M --> · **Critic** <!-- R rounds, B blocking -->
>
> **TL;DR** — <!-- 1–2 sentences: what ships and why. -->
>
> **Needs you** — <!-- e.g. "OK to build it this way? Two files change.", or the one question blocking the build. -->

## Approach
<!-- The technical approach: chosen pattern and why. Confidence notes: which
choices rest on curated docs vs inference. -->

## Affected files
<!-- A table, one row per file. Columns: Path (backticked) | Change | New?
     Files the plan CREATES get (new) in the New? column. Keep every path
     backticked — this section is machine-parsed into the IMPLEMENT write
     boundary; anything outside it blocks the diff.
     | Path | Change | New? |
     |------|--------|------|
     | `app/x.rb` | what changes here | |
     | `app/y.rb` | scaffolded | (new) | -->

## Coupling
<!-- The section that answers "what ELSE touches this?" — and proves the answer.

     Reviewers almost never find "this line is wrong". They find "this is coupled
     to something outside your diff": a sibling code path with the same gap, a
     downstream reader of the value you changed, a framework-implicit scope
     (soft-delete, default scope, paranoid), state your change persists that the
     NEXT run reads back, rows already in production. Every one of those is
     findable with a search BEFORE the PR exists — which is what this table is.

     One row per symbol this change writes, removes, or changes the MEANING of.
     Columns: Subject | Evidence command | Hits | Disposition.

     Machine-checked (evidence_verified): the gate RE-RUNS each command and
     compares its line count against Hits. So the command must be a read-only
     search — `git grep`, `grep` or `rg`, no pipes or shell operators — and Hits
     must be the number of lines it actually printed. A row that cannot survive
     its own command is not evidence.

     Hits: 0 is a real and often decisive answer — it is how you prove nothing
     else writes a column, which is exactly how you discover there is no backfill.

     Disposition must say what the hits MEAN: 'safe because …', 'handled in this
     diff', or 'out of scope because …'. An undispositioned hit is an unread caller.

     Ask each of these, and give the ones that apply a row:
       - who else WRITES this? (a sibling integration with the identical gap)
       - who READS it downstream, and does a stale/other value break them?
       - does the model carry an implicit scope that makes this query lie?
       - is this value persisted and read back on a later run or another entry point?
       - which code becomes newly REACHABLE, or newly unreachable, because of this?
       - what used to fail LOUDLY here and would now fail silently?

     | Subject | Evidence command | Hits | Disposition |
     |---------|------------------|------|-------------|
     | `auto_sync_mode` writers | `git grep -n auto_sync_mode -- app lib` | 3 | 2 reads (safe), 1 writer — the form, fixed here; no backfill exists ⇒ AC#2 covers existing rows |

     Write 'None — <why this change couples to nothing outside its own diff>' if
     it genuinely does. A bare 'None.' is refused: the reason is the check. -->

## Risks
<!-- A table, one row per risk. Columns: Risk | Severity (low/med/high) | Test map.
     EVERY risk must reappear (by the same wording) in the TEST stage's
     '## Risk-to-test map'. Include edge cases and applicable documented gotchas.
     | Risk | Severity | Test map |
     |------|----------|----------|
     | what could go wrong | med | AC#N / how it's covered | -->


## Subtasks
<!-- A table, one row per subtask. Columns: # | Subtask | Files.
     Files = this subtask's slice of '## Affected files' (backticked,
     comma-separated). Machine-checked (subtask_coupling): every affected file
     belongs to exactly ONE subtask, and a source file plus the spec it breaks
     must be in the SAME subtask — advance gates each subtask on green.
     Each subtask small enough to review as ONE diff and commit.
     | # | Subtask | Files |
     |---|---------|-------|
     | 1 | what lands | `app/x.rb`, `spec/x_spec.rb` | -->

## Testing strategy
<!-- Per subtask: which test type and why, per the repo's conventions. -->

## Open questions
<!-- Blocking vs non-blocking. Write 'None.' if none. -->

## Amendments
<!-- Append-only after approval. Never rewrite approved sections. -->
<!-- (optional section — not required by validators until an amendment exists) -->
