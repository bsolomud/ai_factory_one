---
run: __RUN__
stage: __STAGE__
status: draft
---

# Context — __RUN__

<!-- BLUF header: a human-facing summary that sits above the first ## section.
     Not validated, but it is the first thing the developer and the next stage
     read — fill it before you set status: complete. Keep it to these few lines. -->
> **CONTEXT · __RUN__** — <!-- OUTCOME at a glance, e.g. "12 criteria agreed · 0 blocking questions" -->
>
> **TL;DR** — <!-- 1–2 sentences: what the task is, in plain words. Bottom line up front. -->
>
> **Needs you** — <!-- the one thing the developer must decide at this gate, or "Nothing — criteria agreed." -->

## Requirements
<!-- What the task asks for, in your own words. Cite the source (ticket /
pasted text — see 00-ticket.md). Note what the task does NOT say. -->

## Acceptance criteria
<!-- A table, one row per criterion. Columns: # | Criterion | Verified by.
     Numbered so the plan and QA can reference "AC#N"; each independently
     checkable. Built from the developer's answers — agreed at the CONTEXT gate.
     | # | Criterion | Verified by |
     |---|-----------|-------------|
     | 1 | what must be true | test / check that proves it | -->

## Decisions
<!-- The checklist of calls only the developer can make — resolved HERE, where
     a decision costs one chat message, not at PR, where it costs a reopen
     cycle (re-implement → re-test → re-review). A table, one row per topic;
     every row filled — 'N/A — <why>' is a valid answer, silence is not.
     | Topic | Decision |
     |-------|----------|
     | Scope boundary | fix-here vs fix-root-cause; what this run will NOT touch |
     | Product intent | ambiguities in observable behavior, resolved in the developer's words |
     | Secrets / config policy | what may carry a committed default vs must be blank / ENV-injected |
     | Migration / rollout | data migration, feature flag, backward compatibility expectations |
     | Out of scope | explicitly excluded work someone might assume is included | -->

## Findings
<!-- A table, one row per finding. Columns: Claim | Source | Confidence.
     EVERY claim carries a source (file path or doc) in the Source column.
     Confidence = curated-doc-backed vs inferred.
     | Claim | Source | Confidence |
     |-------|--------|------------|
     | what you learned | `path/to/file.rb:12` | doc-backed / inferred | -->

## Open questions
<!-- Split: **Blocking** (must be answered before planning) vs **Non-blocking**
(note the assumption you'll proceed with). Write 'None.' if none. -->
