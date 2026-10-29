# Stage: REVIEW (pre-PR)

Catch issues while fixing them is private and cheap — before a PR exists.

## Inputs
1. The FULL branch diff vs the base branch (not per-subtask).
2. The profile's `review` binding: **if a repo review skill is bound, use it
   as-is** — it is the single source of truth (it may match a CI reviewer).
   Otherwise use the built-in passes below. When you use a bound repo skill,
   record it: `pipeline used skill <its path>` (feeds the assets report).
   **If the PR will be judged by a reviewer you can run, run it HERE**, in the
   same unattended mode it will run in later. Testing against the actual grader
   before submitting is the cheapest round you will ever skip.
3. `artifacts/02-plan.md` — **a PASS-B input only**. See below.

## Output
`artifacts/05-review.md`. Above the `# Pipeline details` line, for the
developer: What we found (and Questions for you, only when a finding needs
their call). Below it: Blind pass, Findings, Coupling, Fixes applied,
Disputed, Plan-vs-shipped check, and — when they apply — Untested claims and
Team skill trace.

## Two passes, and the order is load-bearing
**Pass A — blind.** A fresh `pipeline-reviewer` gets the branch diff and the
repo, and is NOT given `01-context.md` or `02-plan.md`. Withholding the plan is
the whole point: a model reviewing work it can see the rationale for corrects
far less than the same model shown identical code as someone else's, and the
plan is the most contaminating artifact in the run because it carries the
reasoning that made every shortcut feel reasonable at the time. A pilot run's
self-review — done in-context, with the plan — found naming and documentation
issues and walked straight past a blocker about state persisted for the next
run. The reviewer who found it had the diff and nothing else.

Record in `## Blind pass`: what the diff appears to be trying to do judged only
from the code, and which parts could not be explained from the repo alone.

**Pass B — informed.** Only now open the plan and the context, and do the
plan-vs-shipped check. A gap between the blind reading and the plan is itself a
finding — usually about legibility, often about the code.

## Procedure (executed by `pipeline-reviewer`, fresh context; fixes by `pipeline-implementer`)
- Review the full diff with the bound skill's instructions or the built-in
  passes: logic/correctness, security, performance,
  style-consistency-with-surrounding-code. Verification-before-flagging: a
  finding without checked evidence is noise — drop it.
- **Record the round and every finding in it.** Open it before reviewing —
  `pipeline round open pre-pr` — and record each confirmed finding as
  `pipeline finding --class <coupling|population|proof|correctness|style|scope|other>
  --missed-by <probe name | none> --summary "<one line>"`, then
  `pipeline round close`. `missed_by` is the load-bearing field: it names the
  search that WOULD have surfaced this before the code existed, and SCRIBE turns
  every such name into a probe the next run runs for free. `none` is a legitimate
  answer and means exactly what it says — nothing reasonable would have caught it.
  Without this ledger a review is a report; with it, it is the input to the only
  mechanism that lowers the round count.
- **A review with zero blocking findings must say what it checked.** Across 26
  pilot reviews the declared blocking count was zero every single time while
  external reviewers were still opening rounds — which makes a zero unreadable:
  it cannot be told apart from a review that looked in the wrong place. So when
  `## Findings` is clean, `## Blind pass` states the specific things you verified
  and found sound, not that you found nothing.
- **Re-verify `## Coupling`** against the shipped code with the repo's learned
  probes (`pipeline probes` — it matches them to this diff) and the
  **change-probes** skill (`~/.claude/skills/change-probes/SKILL.md`; record
  `pipeline used skill change-probes`): carry the plan's rows
  forward, re-run each command (`evidence_verified` re-runs them at the gate
  too), and ADD a row for every symbol the implementation or the fix loop newly
  writes, removes, or repurposes. A plan-time hit count describes the code as
  planned; the rows the fix loop touched are exactly the ones most likely to
  have moved.
- **Confirmed findings** → the dispatcher hands them to the implementer (fix
  mode: stay inside the plan boundary; amend the plan if a fix requires it;
  commit only if the run is using commits), then a fresh reviewer verifies and
  records them under
  `## Fixes applied`.
- **Loop until a round comes back clean** (`review_converged` gates it). Each
  round is a FRESH reviewer over the whole diff, its own `round open pre-pr` …
  `round close`. The gate passes only when the last round closed with nothing
  standing, and **"advisory" and "pre-existing" do not stand down**: the PR
  reviewer raises them anyway. In a pilot run this review found a 500 on invalid
  UTF-8, filed it "advisory, pre-existing", and it was the PR's first comment.
  The PRs that merge without comments come from exactly this loop: review, fix,
  fresh review, until a round finds nothing. Every finding ends one of three
  ways:
  - **fixed**, and the next fresh round does not find it again;
  - **refuted**: not real. Record it again with the same `--summary`,
    `--round <n>` and `--rejected`, and give the reason under `## Disputed`;
  - **deferred by the developer** (never by you): same, with
    `--deferred "<one plain sentence for the PR>"`. The sentence reaches the
    PR's Reviewer guidance word for word (`deferred_in_pr`).
  After 4 rounds with findings still standing, stop and put the list to the
  developer: fix, defer, or refute each.
- **Fix the class, not the example.** A reviewer comment names one input; the
  next round finds its sibling. In a pilot run, round 1 fixed one re-linked
  record, and the PR reviewer then found an empty-string status and an *older*
  superseded id, two more inputs of the same kind. With each finding, name the inputs of
  its kind (empty vs missing, oldest vs newest record, malformed encoding,
  out-of-range number, a quoted vs bare field) and prove the fix against each
  one, by a spec or a run, not by reading.
- **The fix loop is where the next round's findings get written.** Measured on
  two pilot PRs: 23 reviewer findings, and **12 of them were on code that did
  not exist when the PR was opened** — written to satisfy an earlier comment. In
  one case a round-1 *nit* ("name the record via its global id") produced a
  round-2 correctness bug; in another, hoisting a check to fix one comment
  opened a silent data-loss path. A fix is a change like any other, produced
  under worse conditions than the original: no plan, no coupling analysis, and a
  review comment acting as a spec narrower than the truth. So:
  - Fix **blockers and nits in separate rounds.** A nit's fix that rides along
    with a blocker's fix gets none of the scrutiny and all of the blast radius.
  - Every fix that touches a plan `## Affected files` path **invalidates the
    proof ledger** — `ac_proofs` will say so at the gate. Re-run the proofs; do
    not re-stamp without re-running them.
  - A fix that introduces a caller, a persisted value, or a new nil path is a
    new `## Coupling` Subject, not a footnote on an existing row.
- **Disputed findings** → record both sides under `## Disputed`; the developer
  arbitrates at the gate.
- **Untested claims** (`untested_claims` gates it): every row of the test
  report's `## Risk-to-test map` whose Coverage says "not tested" is a claim
  about behaviour that the PR will repeat as fact. Do not agree with it by
  reading — find or run a test that shows the behaviour and cite its path, or
  write `Not verified` with one plain sentence for the PR's Testing notes. A
  claim you could not check is fine; a claim that silently reaches the PR is not.
- **Bound repo review skill → execute it, step by step** (`skill_trace` gates
  it): `## Team skill trace` has one row per step you ran, each citing the
  file:line or command, and every skill file you cite is recorded with
  `pipeline used skill <path>`. When the skill compares the diff against the
  ticket, the ticket is `artifacts/00-ticket.md` in the run directory — do not
  fetch it from the tracker.
- **Plan-vs-shipped check**: does the final shape still match the approved
  plan + amendments? Each drift becomes an amendment or an explicit decision.
  Also verify each plan Risk row's PREDICTED FAILURE MODE against the shipped
  code — a risk whose prediction no longer holds (the real failure mode is
  different or bigger) is a blocking finding on the plan, not a footnote.
- **Re-review (reopen / round 2+)**: before writing this round, move the prior
  round's content into `## History` wrapped in a collapsed `<details>` block
  (append-only — never rewrite or delete an archived round), then refresh
  `## What we found` + the sections above to reflect THIS round only. One always-fresh view
  at the top; the audit trail lives in History.

## Done when
`## What we found` (above the `# Pipeline details` line) opens with whether
this is ready for a PR and why, then one plain bullet per problem worth a
person's attention — what could go wrong for a user, fixed or still open —
reflecting the latest round. Set the frontmatter counts —
`findings: { blocking, advisory, fixed, disputed }` — to match `## Findings`
(machine-read: the gate blocks while `blocking > 0`; metrics track review
effectiveness from these). The round is closed and every finding recorded.
The last round came back clean (or the developer deferred what stands).
Artifact complete, fixes applied, `pipeline check` green, then
`pipeline advance`;
present findings summary and STOP.
