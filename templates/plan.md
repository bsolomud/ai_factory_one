---
run: __RUN__
stage: __STAGE__
status: draft
critic: { rounds: 0, blocking_open: 0 }
---

# Plan — __RUN__: <!-- the task in one plain line — same line as the context artifact's title -->

<!-- ═══════════════════════════════════════════════════════════════════════
     Everything above '# Pipeline details' is for a PERSON — a junior
     developer who has never opened this pipeline. One screen: under 300
     words of prose plus a diagram when it earns its place. Machine-checked
     (human_part, plain_language): no pipeline vocabulary, no line with three
     bold spans. The plan is NOT the place to re-argue the context: copy
     '## What we're doing' and '## Why' from 01-context.md (tighten, don't
     expand) and add ONLY how we will build it.

     The argument that got you here — evidence, alternatives, what the design
     check and the adversarial check said and how you answered — goes BELOW
     the marker. Three pilot plans ran to 3,000+ words of prose above the
     first table because that argument was written here. It is not for the
     reader; it is for the record.
     ═══════════════════════════════════════════════════════════════════════ -->

## What we're doing
<!-- Copied from 01-context.md, tightened. 3–5 sentences, product words. -->

## Why
<!-- Copied from 01-context.md. Keep the diagram if there was one. -->

## How we'll build it
<!-- A numbered list of steps, in the order they land. One sentence per step,
     naming the part of the app in WORDS ("the password-reset email", "the
     sync job"), not paths — the paths are in '## Affected files' below.
     Say what each step changes for the person using the product. If a step
     needs a decision from the developer, it is a question in the next
     section, not a paragraph here.

     If the build has a moving part that is easier to see than to read — a
     new flow, a state change, a hand-off between systems — draw it (mermaid
     flowchart or sequenceDiagram, plain-word labels).

     1. Make the reset email's button open the reset form even when the
        identity service cannot produce a link — today it falls back to the
        service's login page.
     2. Add a note to the auth docs so the next person knows the fallback
        exists.
     3. Cover both with tests. -->

## Questions for you
<!-- ONLY if the build needs a decision from the developer. One bullet per
     question, answerable in a sentence, with your proposed default in
     brackets. Delete the section when there is nothing to ask. -->

# Pipeline details

<!-- Below this line: written for the stage agents and the gates. Dense is
     fine — tables, backticked paths, exact commands, ids. -->

## Approach
<!-- The technical approach: chosen pattern and why; alternatives rejected and
     why; confidence notes (curated docs vs inference). This is where the
     reasoning lives — keep it out of the half above. -->

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
     | `notify_mode` writers | `git grep -n notify_mode -- app lib` | 3 | 2 reads (safe), 1 writer — the form, fixed here; no backfill exists ⇒ AC#2 covers existing rows |

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
     Each subtask small enough to review as ONE diff. The subtask numbers
     line up with the steps in '## How we'll build it' above.
     | # | Subtask | Files |
     |---|---------|-------|
     | 1 | what lands | `app/x.rb`, `spec/x_spec.rb` | -->

## Testing strategy
<!-- Per subtask: which test type and why, per the repo's conventions. Every
     acceptance criterion (AC#n) traceable to a subtask and a test. -->

## Critic trace
<!-- What the design check and the adversarial check said, and what you did
     about each finding — a table, one row per finding: Round | Finding |
     Response. Rejected findings carry the reasoning. This is the ONLY place
     the critic conversation is recorded; it never leaks into '## Approach'
     and never above the marker. 'None — no findings.' if the checks were clean.
     | Round | Finding | Response |
     |-------|---------|----------|
     | 1 | B1: the fallback also fires on timeout | handled — see Risks row 2 | -->

## Open questions
<!-- Blocking vs non-blocking. Blocking ones are ALSO asked above in
     '## Questions for you', in plain words. Write 'None.' if none. -->

## Amendments
<!-- Append-only after approval. Never rewrite approved sections. -->
<!-- (optional section — not required by validators until an amendment exists) -->
