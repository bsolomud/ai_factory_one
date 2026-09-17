---
name: change-probes
description: ai_factory_one change probes — for pipeline stage agents ONLY, inside an active run. Invoke when building the plan's or the review's `## Coupling` table, or when a fix round needs its own blast-radius check. Turns a diff into a list of read-only searches that find what is coupled to it — sibling writers, downstream readers, implicit scopes, persisted state, newly reachable code, loud-to-silent regressions. NEVER invoke proactively or outside a pipeline run.
---

# Change probes — turn the diff into searches

Reviewers almost never find "this line is wrong". On two pilot PRs, 23 findings
came back and the blockers were all one shape: **your change is locally correct
and it is coupled to something outside your diff.** A sibling integration with
the identical gap. A downstream reader of the value you changed. A model scope
that made your query answer a different question. State you persist that the
*next* run reads back. Rows already in production that no writer will revisit.

Every one of those was findable with a search before the PR existed. This skill
is that list of searches. It produces the rows of `## Coupling`, which the gate
re-runs and compares — so each row must be a **read-only command** (`git grep`,
`grep`, `rg`; no pipes or shell operators) plus **the number of lines it printed**.

`Hits: 0` is not a wasted row. It is how you prove absence, and proving absence
is how you discover there is no backfill.

---

## The six probes

Run the ones that apply. Each produces rows; a probe you skip is a claim you
are making silently.

### 1. Sibling writers — who else writes this?
The change repairs one writer. Ask whether the same value has others, and
whether a parallel integration carries the identical gap.

```
git grep -n <symbol> -- <source roots>
```

*Real finding:* a form fix made the writer store the right mode, and `git grep`
over the column returned **no other writer, no backfill migration, no callback**
— so every existing record stayed broken. The same review noted the parallel
integration had the identical gap. The fix was ~20% of the job and every check
was green. **If this probe returns 0 other writers, the population question from
`AC · Population` is live: who migrates the rows that are already wrong?**

### 2. Downstream readers — who consumes what I changed?
For every identifier the diff removes, renames, drops from a payload, or whose
meaning it changes: find who reads it, and ask what a stale or absent value does
to them.

```
git grep -n <identifier> -- <consumer roots>
```

*Real finding:* a row was dropped from one feed without re-pointing the records
that referenced it, so a downstream validator rejected the whole import and the
same events replayed on every following run. Twice, in two different consumers.

### 3. Implicit scope — is my query answering a different question?
Frameworks hide scopes: soft-delete, default scope, paranoid models, tenant
scoping. A lookup that reads "never linked" may mean "linked, but the mapping is
soft-deleted".

```
git grep -n "default_scope\|acts_as_paranoid\|deleted_at" -- <the models the diff touches>
```

*Real finding:* one side of a system resolved records including deleted ones,
end to end; the new code did not — so an account the importer would have
resolved correctly had its event dropped anyway.

### 4. Persisted state — who reads this on the NEXT run?
If the change writes a value that outlives the process, the reader you must
check is not in this run. Find every entry point that reads it back, and every
reset path that clears it.

```
git grep -n <status-or-field> -- <readers>
git grep -n "reset\|clear" -- <the class that owns it>
```

*Real finding:* a status stamped during one sync was read back at the start of
the next one *before* anything was re-derived. The full sync cleared it; the
single-record sync cleared only its own target — so a stale stamp on the partner
record vetoed exactly the recovery path the ticket's workaround depended on.

### 5. Newly reachable — what runs for the first time now?
A change that flips a mode, relaxes a guard, or makes a lookup match turns on
code that has never executed on this path. Conversely, ask what stops running.

```
git grep -n <the guard or mode you changed> -- <source roots>
```

*Real findings, both from this one question:* enabling a delta mode meant a
cleanup step gated on `bulk?` became structurally unreachable — it had run on
every scheduled sync before. And a lookup that now matched dereferenced a nil
association on its very first execution, raising inside a job that reports a
clean no-change run when it fails.

### 6. Loud → silent — what used to fail noisily here?
The worst regressions are not new failures, they are old failures that stopped
announcing themselves. Check the diff for removed validations and added
nil-guards on newly reachable paths.

```
git diff <base> -- <source roots>
```
then read the removed lines for validations/raises and the added ones for
`&.` / `rescue` / `try` / silent early returns.

*Real finding:* grouping records by one field collapsed two accounts of the same
person in different roles. The old code failed **loudly** on a uniqueness
validation; the new code dropped one role silently and destroyed its mapping.
Ask of every fix: *if this is wrong in production, how would anyone find out?*
If there is no answer, that is the finding.

---

## Writing the row

```
| Subject | Evidence command | Hits | Disposition |
|---------|------------------|------|-------------|
| `sync_mode` writers | `git grep -n sync_mode -- app lib` | 3 | 2 reads (safe), 1 writer fixed here; no backfill exists ⇒ AC#2 covers existing rows |
```

- **Subject** — the symbol, not the worry. One row per symbol.
- **Evidence command** — must re-run to the same count from the repo root. The
  gate executes it without a shell, so quote regexes rather than piping.
- **Hits** — the number of lines it printed. Take it from the command; do not
  estimate it. If it does not match at the gate, either the count was never
  taken or the code moved under the claim, and both are worth stopping for.
- **Disposition** — what the hits MEAN: `safe because …`, `handled in this
  diff`, `out of scope because …`. An undispositioned hit is an unread caller.

## Anti-patterns

- **A command that cannot fail.** `git grep -n .` returning 4,000 hits proves
  nothing and disposes of nothing. Probe one symbol at a time.
- **Rewriting the count to match.** If the gate says the count drifted, re-read
  what the command returns NOW and re-check the disposition against it. Editing
  the number to silence the gate throws away the one signal the row carries.
- **Batching a nit's fix with a blocker's.** Measured on the pilot PRs: 12 of 23
  findings were on code written to fix the other 11, and in one case a round-1
  nit's fix *was* the round-2 correctness bug. A fix is a change; it earns its
  own probes.
