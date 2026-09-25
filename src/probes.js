import fs from 'node:fs'
import path from 'node:path'
import { parseArtifact } from './artifacts.js'
import { matchesAny } from './profile.js'
import { readOnlySearchArgv } from './validators.js'

// The accretion layer — the half of the pipeline that was not growing.
//
// A repo's review skill gets sharper every PR because each retrospective adds a
// rule; on one pilot repo 397 of its rules cite the PR number that taught them.
// The implementing side accreted nothing, so the gap widened forever and the
// round count stayed permanent. SCRIBE was already told, in prose, to turn every
// received finding into a probe — but the fact format had nowhere to put one,
// and the plan's '## Coupling' table can cite ONLY a command. Result, measured:
// 10 knowledge facts across 29 runs, and not one of them carrying a command.
//
// So a probe is the machine-readable half of a knowledge fact: a read-only
// search, the file shapes it applies to, and the question it answers. PLAN and
// REVIEW ask for the probes matching their diff and start '## Coupling' from
// them — which is how a finding that cost a round once stops costing one twice.
//
// Frontmatter shape (one fact file, `probe:` is a list or a single mapping):
//
//   ---
//   probe:
//     - when: ["app/**/*.rb", "lib/**/*.rb"]
//       run: "git grep -n default_scope -- app/models"
//       asks: "does an implicit scope make this query answer a different question?"
//   taught_by: "MB-47284 / PR #1014"
//   ---
//
// TWO TIERS, because the store proved the single-tier design wrong. Facts
// written by hand before this module existed already used exactly these keys —
// and two of their commands were `gh pr view --json …` and
// `git rev-list --count master..HEAD`: real, valuable questions ("is this PR
// conflicting, so every workflow is being skipped?", "is this branch so far
// ahead that the lint gate will flood?") that no `git grep` can answer.
//
//   coupling — a read-only SEARCH whose hit count becomes a '## Coupling' row.
//              Held to exactly what the Coupling gate will re-run, because it
//              will be re-run: same parser, no second opinion.
//   inspect  — a read-only INSPECTION that answers a question but is not a
//              Coupling row. Offered to the planner, never rendered as one.
//
// Both ban shell operators. The point of the allowlist is that a probe is a
// command the pipeline hands an agent to run unattended; "read-only" has to be
// decidable here, not hoped for at the call site.
const INSPECT_PREFIXES = [
  ['git', 'log'], ['git', 'rev-list'], ['git', 'diff'], ['git', 'show'],
  ['git', 'status'], ['git', 'ls-files'], ['git', 'blame'], ['git', 'describe'],
  ['gh', 'pr', 'view'], ['gh', 'pr', 'checks'], ['gh', 'pr', 'diff'],
  ['gh', 'run', 'view'], ['gh', 'run', 'list'], ['gh', 'issue', 'view'],
  // `gh api` is the only read path to code-scanning and check state, and two
  // facts in the field store need it. Allowed ONLY in its GET form: the flags
  // below are what turn it into a write, so their presence disqualifies it.
  ['gh', 'api']
]
const GH_API_WRITE_FLAGS = ['-X', '--method', '-f', '--field', '-F', '--raw-field', '--input']
const SHELL_OPERATORS = /[|;&><`$(){}]/

// 'coupling' | 'inspect' | null (null = this pipeline will not run it).
export function classifyProbeCommand(cmd) {
  if (readOnlySearchArgv(cmd)) return 'coupling'
  const text = String(cmd ?? '')
  if (SHELL_OPERATORS.test(text.replace(/"[^"]*"|'[^']*'/g, ''))) return null
  const argv = text.trim().split(/\s+/)
  if (argv[0] === 'gh' && argv[1] === 'api' && argv.some(a => GH_API_WRITE_FLAGS.includes(a))) return null
  return INSPECT_PREFIXES.some(p => p.every((tok, i) => argv[i] === tok)) ? 'inspect' : null
}

const INDEX_FILE = 'index.md'

// Every fact file in a repo's knowledge store, with its probes parsed and any
// structural problems named. Never throws on a malformed fact: a bad probe is
// reported as an issue so `probes --lint` can show it, because a knowledge store
// that refuses to load is worse than one that loads with a complaint.
export function readProbes(knowledgeDir) {
  if (!fs.existsSync(knowledgeDir)) return []
  const facts = []
  for (const file of fs.readdirSync(knowledgeDir).sort()) {
    if (!file.endsWith('.md') || file === INDEX_FILE) continue
    const abs = path.join(knowledgeDir, file)
    const parsed = parseArtifact(abs)
    const fact = file.replace(/\.md$/, '')
    const raw = parsed?.frontmatter?.probe
    const probes = []
    const issues = []

    // A DECLARED omission. Some lessons have no searchable shape at all — a
    // triage method applied to a screenshot, an environment cost that belongs in
    // env_checks — and nagging about them forever would make the lint signal
    // worthless exactly when the store gets good. Saying so costs a reason, for
    // the same reason the Coupling gate refuses a bare "None.": if you cannot
    // write the sentence honestly, the probe is missing rather than impossible.
    if (typeof raw === 'string' && raw.trim().toLowerCase() === 'none') {
      const why = String(parsed.frontmatter?.probe_none ?? '').trim()
      if (why.length < 12) {
        issues.push(`${file} declares 'probe: none' without a reason — add 'probe_none: "<why this fact has no searchable shape>"'. A declared omission is a decision; an undeclared one is an oversight, and the lint cannot tell them apart without the sentence.`)
        facts.push({ fact, file, path: abs, probes, issues, has_probe: false, declared_none: false })
      } else {
        facts.push({ fact, file, path: abs, probes, issues, has_probe: false, declared_none: true, probe_none: why })
      }
      continue
    }

    const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw]
    list.forEach((p, i) => {
      const where = `${file} probe[${i}]`
      if (!p || typeof p !== 'object') { issues.push(`${where} is not a mapping — each probe needs 'when', 'run' and 'asks'`); return }
      const when = p.when == null ? [] : Array.isArray(p.when) ? p.when : [p.when]
      const run = typeof p.run === 'string' ? p.run.trim() : ''
      const asks = typeof p.asks === 'string' ? p.asks.trim() : ''
      if (when.length === 0) { issues.push(`${where} declares no 'when' globs — a probe nobody can match to a diff is never run`); return }
      if (!run) { issues.push(`${where} declares no 'run' command — a probe that is not a command is a note, and notes do not get run`); return }
      const tier = classifyProbeCommand(run)
      if (!tier) {
        issues.push(`${where} records \`${run}\`, which this pipeline will not run unattended — a probe is either a read-only search ('git grep' / 'grep' / 'rg', which the Coupling gate re-runs) or a read-only inspection (git log/rev-list/diff/show/status/ls-files/blame, gh pr|run|issue view). No shell operators either way.`)
        return
      }
      if (!asks) { issues.push(`${where} declares no 'asks' — say what a hit MEANS, or the next run gets a count with no question attached`); return }
      probes.push({ fact, file, tier, when: when.map(String), run, asks, taught_by: parsed.frontmatter?.taught_by ?? null })
    })
    facts.push({ fact, file, path: abs, probes, issues, has_probe: probes.length > 0 })
  }
  return facts
}

// Probes whose `when` globs match any of the changed files. A probe with no
// match is not offered — the point is a short, diff-shaped list the planner will
// actually run, not the whole store.
// Deduplicated by COMMAND, because two lessons legitimately share one search
// (a stacked run and a flooded lint gate are both answered by "how far ahead is
// this branch?"). Listing it twice is how a useful preflight list turns into
// noise an agent learns to skim — the same reason the probe rules forbid a
// command that cannot fail. The merged entry cites every fact behind it, so no
// lesson loses its attribution.
export function matchingProbes(facts, files) {
  const byCommand = new Map()
  for (const f of facts) {
    for (const p of f.probes) {
      const matched = files.filter(file => matchesAny(file, p.when))
      if (!matched.length) continue
      const seen = byCommand.get(p.run)
      if (!seen) {
        byCommand.set(p.run, { ...p, facts: [p.fact], matched })
        continue
      }
      if (!seen.facts.includes(p.fact)) {
        seen.facts.push(p.fact)
        // Keep the longest `asks`: the fuller question is the one worth reading.
        if (p.asks.length > seen.asks.length) seen.asks = p.asks
      }
      for (const m of matched) if (!seen.matched.includes(m)) seen.matched.push(m)
    }
  }
  return [...byCommand.values()]
}

// Facts that carry no runnable probe (plus malformed ones). SCRIBE routes these
// as work: a fact without a probe is a lesson the next run cannot apply.
export function probeIssues(facts) {
  const issues = []
  for (const f of facts) {
    for (const i of f.issues) issues.push({ fact: f.fact, issue: i, kind: 'malformed' })
    if (f.declared_none) continue // a decision, already reasoned — not a gap
    if (!f.has_probe && f.issues.length === 0) {
      issues.push({ fact: f.fact, kind: 'no_probe', issue: `'${f.fact}' carries no probe — add a frontmatter 'probe:' entry (when / run / asks): a search a future run cites as a '## Coupling' row, or a read-only inspection that answers the question this fact exists to raise. A fact that cannot be phrased as a command is a fact that will not be applied. If it genuinely has no command shape, say so in the body so this gap reads as a decision.` })
    }
  }
  return issues
}

// A matched COUPLING probe, rendered as the row it is meant to become. Hits is
// deliberately left blank: the planner runs the command and records what it
// actually printed — the gate re-runs it and compares. An `inspect` probe has
// no row; it is a question to answer, not a count to record.
export function couplingRow(probe) {
  return `| ${probe.asks} | \`${probe.run}\` |  | <!-- what the hits MEAN (from ${probe.fact}) --> |`
}
