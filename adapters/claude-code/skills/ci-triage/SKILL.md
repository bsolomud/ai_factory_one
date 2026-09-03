---
name: ci-triage
description: CI evidence-gathering for ai_factory_one runs — the built-in behind the repo profile's `ci` capability binding. Invoke ONLY when executing the pipeline CI stage (or a PR-feedback rework round that re-enters CI); never proactively, never outside a pipeline run. If the profile binds a repo CI skill instead, that skill is the source of truth and this one does not apply.
---

# CI triage — trust nothing you haven't verified server-side

Division of labor: the CI stage runbook (`stages/ci.md`) owns the loop
discipline — failure classification classes, reproduce-before-fixing,
one-hypothesis-per-CI-run, stop-after-2. THIS skill owns the evidence layer
under those rules: what to check, in what order, before any classification
is trustworthy.

## 1. Pre-flight — before you trust any check

`gh pr view <n> --json mergeable,mergeStateStatus,headRefOid` FIRST.

- `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY` ⇒ GitHub cannot build
  the merge ref, so every `pull_request`-triggered workflow is **silently
  skipped** — `gh pr checks` showing green is **vacuous**, not green.
  Report the false-green explicitly, get the conflict resolved (per the
  repo's base-branch policy, through the normal gated push — never merge),
  and only then read checks.
- Confirm `headRefOid` matches the commit you think you pushed. Checks on a
  stale head describe someone else's code.

## 2. Expected-vs-ran audit

Green is only meaningful if everything that should have run, ran.

1. Enumerate the workflows whose triggers match this event: read
   `.github/workflows/*` (or the CI config the profile names) for
   `pull_request`/`push` triggers, path filters, and label gates.
2. List what actually started for the head SHA: `gh run list --commit <sha>`.
3. Every workflow in (1) missing from (2) is a silent skip you must explain
   before reading any log — path filter? label gate (name the label so the
   developer can decide)? conflict skip (see pre-flight)?

## 3. Queue judgment — GitHub-side timestamps ONLY

- A run's queue age is `startedAt − createdAt` **from the GitHub API**, never
  from how long you have been waiting locally. Local wait timers compress and
  distort; a documented pipeline retro traced an unnecessary cancel+rerun to
  exactly this misjudgment.
- Starvation is diagnosed repo-wide: `gh run list --limit 20` — are OTHER
  runs starting? If nothing repo-wide has started for hours, it's runner
  starvation (infrastructure): report it and recommend waiting or escalating;
  do not invent code fixes and do not cancel+rerun.
- **Never cancel+rerun on locally-judged queue age.**

## 4. Flake protocol

1. **Consult the registry first**: read `knowledge_dir/ci-known-flakes.md`
   if it exists and record
   `pipeline used knowledge ci-known-flakes --repo <slug> --run <id>`.
   A failure matching a registered flake row is classified as that flake —
   cite the row, don't re-derive it.
2. New suspected flake: **reproduce first** (rerun the single test, locally
   or via the provider's rerun, per the runbook's discipline). Unreproduced
   suspicion is a hypothesis, not a classification.
3. A **confirmed** new flake gets a row appended to
   `knowledge_dir/ci-known-flakes.md` (create the file if missing):
   `| <test id> | <symptom> | <run id first seen> | <evidence link/quote> | <disposition: rerun-safe / needs-fix / quarantine-candidate> |`
   — then append the hook line to `knowledge_dir/index.md` if the file is
   new: `- [ci-known-flakes](ci-known-flakes.md) — known flaky tests; check before diagnosing CI red`.
   The registry lives in the pipeline home, never in the repository.

## Hard rules

- Everything in `stages/ci.md` still applies: every proposed fix goes to the
  developer at the gate BEFORE it is applied and pushed; never merge.
- Record usage: invoking this as a skill is logged automatically; if you
  READ this file instead, record `pipeline used skill ci-triage` per the
  handoff's usage-ledger rule.
