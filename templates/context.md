---
run: __RUN__
stage: __STAGE__
status: draft
---

# Context — __RUN__: <!-- the task in one plain line, e.g. "the reset-password button lands on the wrong page" -->

<!-- ═══════════════════════════════════════════════════════════════════════
     Everything above '# Pipeline details' is for a PERSON — a junior
     developer who has never opened this pipeline and never will. It is one
     screen: under 300 words of prose, plus the criteria table, plus a
     diagram when one earns its place. It is machine-checked (human_part,
     plain_language): no pipeline vocabulary, no cell over 30 words, no line
     with three bold spans. Evidence, sources, alternatives, and anything an
     agent needs go BELOW the marker — that half is for the machines.
     ═══════════════════════════════════════════════════════════════════════ -->

## What we're doing
<!-- 3–5 sentences. Who is affected, what they see today, what we will change.
     Use the product's own words: user, school, login page, email, button —
     never file paths, never mechanism. If the developer said what "done"
     looks like, say it here in their words. -->

## Why
<!-- 1–3 sentences on the cause. For a bug: what is broken and why it happens.
     For a feature: what people cannot do today.

     If the cause crosses two or more systems, or takes three or more steps to
     tell, draw it instead of narrating it — a mermaid sequenceDiagram for a
     flow between systems, a flowchart for a decision. Keep node labels in
     plain words. Example:

     ```mermaid
     sequenceDiagram
       participant U as User
       participant A as App
       participant P as Identity service
       U->>A: email + password
       A->>A: password OK, session created
       A->>P: hand-off (by account id, not email)
       P->>U: login form — needs the identity-service email
       U->>P: types the App email
       P-->>U: "invalid email or password"
     ``` -->

## What changes
<!-- One bullet per change a person can notice, in the product's words.
     "The reset link opens the reset form, not the login page" — not
     "ResetLink.build falls back differently". Say what does NOT change
     when someone might assume it does. -->

## Acceptance criteria
<!-- The developer's checklist. One row per criterion, numbered from 1 (the
     numbers are the keys the later stages use — never renumber). Each cell
     under 30 words; each row checkable on its own.

       Now             — what happens today, in one plain sentence
       After this ships — the observable end state, in one plain sentence
       How to check    — what a person or a test does to see it

     Write the end state as a claim about the WORLD, not about the code.
     "The form saves the mode" passes while every existing record stays
     broken. "A school stored as bulk runs delta on its next sync" stays red
     until the existing data is handled too. Which records the row is about
     (only new ones, or the ones already out there) is answered below the
     marker in '## Criteria population' — the question is asked here, out
     loud, with the developer; the vocabulary term lives down there.

     | # | Now | After this ships | How to check |
     |---|-----|------------------|--------------|
     | 1 | the reset button opens the login page | the reset button opens the reset form | click it from the email on staging | -->

## Questions for you
<!-- ONLY if something needs the developer's answer before planning. One
     question per bullet, each answerable in a sentence, with your proposed
     default in brackets. Delete this section when there is nothing to ask —
     "Nothing" is not a question. -->

# Pipeline details

<!-- Below this line: written for the stage agents and the gates. Dense is
     fine here — tables, backticked paths, exact commands, ids. -->

## Requirements
<!-- The task restated precisely, with the source cited (00-ticket.md, the
     developer's answers verbatim). Note what the task does NOT say. -->

## Criteria population
<!-- Machine-checked (ac_population): one row per acceptance criterion,
     keyed by its number, answering WHICH RECORDS the criterion is about:
       new      — only records created after this ships
       existing — rows already out there (⇒ ask: what migrates them?)
       both     — the usual answer for a bug fix, and the one people skip
       n-a      — no persisted population (pure UI copy, build config, …)
     A criterion marked 'new' that should be 'both' is the single most
     expensive mistake this artifact can carry.

     | # | Population |
     |---|------------|
     | 1 | both | -->

## Decisions
<!-- The checklist of calls only the developer can make — resolved HERE, where
     a decision costs one chat message, not at PR, where it costs a reopen
     cycle. A table, one row per topic; every row filled — 'N/A — <why>' is a
     valid answer, silence is not.
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
     (note the assumption you'll proceed with). Blocking ones are ALSO asked
     above, in '## Questions for you', in plain words. Write 'None.' if none. -->
