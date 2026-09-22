import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { AC_TABLE, STANDARD_PROFILE, cli, completeArtifact, installProfile, sandbox, standardRepo, writeFile } from './helpers.js'

// The measurement and accretion layers. Everything here exists because of one
// pilot finding: across 29 runs the pipeline reported a median of 0 correction
// rounds while reviewers were opening rounds on its PRs, and the knowledge store
// held 10 facts of which none carried a command any future run could execute.

function startedRun(name, { profile = STANDARD_PROFILE, runId = 'R-1' } = {}) {
  const { root, home } = sandbox()
  const repo = standardRepo(root, name)
  const slug = `example.com-test-${name}`
  installProfile(home, slug, profile)
  const run = (args, env) => cli(args, { home, cwd: repo.dir, env })
  const runDir = path.join(home, 'repos', slug, 'runs', runId)
  run(['new-run', runId])
  return { home, root, repo, run, runDir, slug, runId }
}

test('round ledger: rounds and findings are recorded, and the metrics finally see them', () => {
  const { run, runId } = startedRun('rounds-repo')

  assert.equal(run(['round', 'open', 'nope']).verdict, 'ERROR', 'an unknown source is refused, not recorded')
  const r1 = run(['round', 'open', 'pre-pr'])
  assert.equal(r1.verdict, 'OK')
  assert.equal(r1.round, 1)
  assert.match(run(['round', 'open', 'pr']).error, /still open/, 'two open rounds would make "how many rounds" unanswerable')

  assert.equal(run(['finding', '--class', 'nope', '--missed-by', 'none', '--summary', 'x']).verdict, 'ERROR')
  assert.equal(run(['finding', '--class', 'coupling', '--summary', 'x']).verdict, 'ERROR', 'missed-by is not optional — it is the whole point')
  assert.equal(run(['finding', '--class', 'coupling', '--missed-by', 'sibling-writers', '--summary', 'the form has a second writer']).verdict, 'OK')
  assert.equal(run(['round', 'close']).findings, 1)

  run(['round', 'open', 'pr', '--ref', '#123'])
  run(['finding', '--class', 'population', '--missed-by', 'existing-rows', '--summary', 'no backfill for rows already stored', '--accepted'])
  run(['finding', '--class', 'style', '--missed-by', 'none', '--summary', 'naming nit', '--rejected'])
  run(['round', 'close'])

  const list = run(['round', 'list'])
  assert.equal(list.rounds.length, 2)
  assert.equal(list.open, null)
  assert.deepEqual(list.rounds.map(r => r.source), ['pre-pr', 'pr'])
  assert.ok(list.rounds.every(r => r.closed))

  const m = run(['metrics', '--run', runId])
  // One delivery + one EXTERNAL round (the pre-PR round is inside the run).
  assert.equal(m.rounds_to_merge, 2, 'the target number: delivery + the rounds that arrived from outside')
  assert.equal(m.findings_after_pr, 2)
  assert.deepEqual(m.rounds_by_source, { 'pre-pr': 1, pr: 1 })
  assert.equal(m.findings_by_class.population, 1)
  assert.equal(m.findings_missed_by['existing-rows'], 1)
  assert.equal(m.findings_missed_by.none, 1, "'none' is an honest answer and is counted as one")

  const agg = run(['metrics'])
  assert.equal(agg.summary.median_rounds_to_merge, 2)
  assert.equal(agg.summary.runs_with_round_ledger, 1)
  assert.equal(agg.summary.total_findings_after_pr, 2)
})

test('a run with no round ledger reads as unmeasured, never as a clean one round', () => {
  const { run, runId } = startedRun('unmeasured-repo')
  const m = run(['metrics', '--run', runId])
  assert.equal(m.rounds_to_merge, null, 'silence is not evidence of a single round')
  assert.equal(run(['metrics']).summary.runs_with_round_ledger, 0)
})

test('abort demands the harvest it used to swallow', () => {
  const { run, runDir, runId } = startedRun('abort-repo')

  const aborted = run(['abort'])
  assert.equal(aborted.verdict, 'ABORTED')
  assert.equal(aborted.harvest, 'required')
  assert.ok(fs.existsSync(aborted.harvest_runbook), 'the abort names a runbook that actually exists')
  assert.match(aborted.next_action, /HARVEST THIS RUN/)
  assert.match(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'), /"event":"harvest_pending"/)
  assert.equal(run(['metrics', '--run', runId]).learnings_captured, true, 'the debt is recorded, so the loop can be closed later')

  // Skipping is allowed, but it is a reasoned, recorded choice.
  const { run: run2, runDir: runDir2, runId: id2 } = startedRun('abort-skip-repo', { runId: 'R-2' })
  const skipped = run2(['abort', '--no-harvest', 'one-line typo fix, nothing to learn'])
  assert.equal(skipped.harvest, 'skipped')
  assert.match(fs.readFileSync(path.join(runDir2, 'events.jsonl'), 'utf8'), /"event":"harvest_skipped"/)
  assert.match(fs.readFileSync(path.join(runDir2, 'events.jsonl'), 'utf8'), /nothing to learn/)
  assert.equal(run2(['metrics', '--run', id2]).learnings_captured, true)
})

test('probes: learned searches are matched to the diff, and a fact without one is a reported gap', () => {
  const { home, repo, run, runDir, slug } = startedRun('probes-repo')
  const knowledge = path.join(home, 'repos', slug, 'knowledge')

  writeFile(knowledge, 'sibling-writers.md', [
    '---',
    'probe:',
    '  - when: ["src/**"]',
    '    run: "git grep -n app-v1 -- src"',
    '    asks: "who else writes this greeting?"',
    'taught_by: "R-0 / PR #1"',
    '---',
    '# Another writer always exists',
    ''
  ].join('\n'))
  writeFile(knowledge, 'story-only.md', '# A fact nobody can run\n\nIt was an interesting bug.\n')
  writeFile(knowledge, 'not-read-only.md', [
    '---',
    'probe:',
    '  - when: ["src/**"]',
    '    run: "rm -rf src"',
    '    asks: "what breaks?"',
    '---',
    '# Dangerous\n'
  ].join('\n'))
  // The shape the store had already grown by hand: a single mapping (not a
  // list), and a read-only INSPECTION rather than a search. Valuable, and not a
  // Coupling row — the first cut of this module would have rejected it.
  writeFile(knowledge, 'branch-distance.md', [
    '---',
    'probe:',
    '  when:',
    '    - "**"',
    '  run: git rev-list --count master..HEAD',
    '  asks: "is this branch so far ahead that the lint gate will flood?"',
    '---',
    '# Long-lived branches flood the lint gate\n'
  ].join('\n'))
  writeFile(knowledge, 'index.md', '- [sibling-writers](sibling-writers.md) — hook\n')

  const explicit = run(['probes', 'src/app.sh'])
  assert.equal(explicit.probes.length, 2, 'both tiers match this change')
  assert.equal(explicit.coupling_rows.length, 1, 'only the search produces a Coupling row')
  assert.match(explicit.coupling_rows[0], /\| `git grep -n app-v1 -- src` \|/, 'rendered as the Coupling row it is meant to become')
  assert.deepEqual(explicit.probes.find(p => p.tier === 'coupling').matched, ['src/app.sh'])
  assert.equal(explicit.inspect.length, 1, 'the inspection is offered as a question, not as a row')
  assert.equal(explicit.inspect[0].run, 'git rev-list --count master..HEAD')

  // A `when: ["**"]` probe matches any path; a scoped one does not.
  const other = run(['probes', 'README.md'])
  assert.equal(other.coupling_rows.length, 0, 'a probe that does not apply is not offered')
  assert.equal(other.inspect.length, 1)

  const lint = run(['probes', '--lint'])
  assert.equal(lint.verdict, 'GAPS')
  assert.equal(lint.facts, 4)
  assert.equal(lint.with_probe, 2)
  const issues = lint.issues.map(i => `${i.kind}:${i.fact}`)
  assert.ok(issues.includes('no_probe:story-only'), 'a fact with no command is a fact no run can apply')
  assert.ok(issues.some(i => i.startsWith('malformed:not-read-only')), 'the probe store may not hold a command the gate would refuse to re-run')

  // With no paths given it takes the run's own diff.
  completeArtifact(runDir, 'artifacts/01-context.md', 'R-1', 'CONTEXT',
    { Requirements: 'r', 'Acceptance criteria': AC_TABLE, Decisions: 'd', Findings: 'f', 'Open questions': 'None.' })
  repo.write('src/app.sh', 'echo app-v2\n')
  const fromDiff = run(['probes'])
  assert.match(fromDiff.scope, /diff vs master/)
  assert.equal(fromDiff.coupling_rows.length, 1)

  const all = run(['probes', '--all'])
  assert.equal(all.probes.length, 2)
  assert.equal(all.rows.length, 1, 'only coupling-tier probes render as rows')
})

test('probes on a repo with no store says so instead of inventing one', () => {
  const { run } = startedRun('empty-store-repo')
  const r = run(['probes', 'src/app.sh'])
  assert.equal(r.verdict, 'OK')
  assert.equal(r.probes.length, 0)
  assert.match(r.note, /no knowledge store yet/)
})

const ENV_PROFILE = `
commands:
  lint_changed: "./lint.sh {changed_files}"
  test_targeted: "./run_tests.sh {targeted_specs}"
  env_checks:
    - name: assets built
      run: "test -f built.marker"
      fix: "./build-assets.sh"
test_layout: { "src/**": "tests/" }
conventions: { base_branch: master }
no_touch: ["locked/**"]
`

test('doctor --env judges the TREE, and names the command that repairs it', () => {
  const { repo, run } = startedRun('env-repo', { profile: ENV_PROFILE })

  const gaps = run(['doctor', '--env'])
  assert.equal(gaps.verdict, 'ENV_GAPS')
  assert.equal(gaps.code, 1)
  assert.equal(gaps.checks[0].check, 'assets built')
  assert.equal(gaps.checks[0].status, 'fail')
  assert.equal(gaps.checks[0].fix, './build-assets.sh')
  assert.match(gaps.next_action, /repair the TREE before reading any gate result/)

  repo.write('built.marker', 'ok\n')
  const ok = run(['doctor', '--env'])
  assert.equal(ok.verdict, 'OK')
  assert.equal(ok.code, 0)
  assert.equal(ok.checks[0].status, 'pass')

  // A repo that never configured the slot is told what the slot is for.
  const plain = startedRun('env-unconfigured-repo')
  const un = plain.run(['doctor', '--env'])
  assert.equal(un.verdict, 'UNCONFIGURED')
  assert.match(un.next_action, /env_checks/)

  // The schema doctor keeps working and now points at its environment sibling.
  assert.match(run(['doctor']).note, /--env/)
})

test('permissions: rules derived from the repo\'s own verified commands, merged only on request', () => {
  const { root, run } = startedRun('perm-repo')
  const claudeHome = path.join(root, 'claude-home')

  const emitted = run(['permissions'])
  assert.equal(emitted.verdict, 'OK')
  assert.deepEqual(emitted.permissions, ['Bash(./lint.sh:*)', 'Bash(./run_tests.sh:*)'])
  assert.match(emitted.note, /Nothing was written/)
  assert.ok(!fs.existsSync(path.join(claudeHome, 'settings.json')), 'emit-only by default')

  const merged = run(['permissions', '--merge'], { CLAUDE_HOME: claudeHome })
  assert.deepEqual(merged.added, ['Bash(./lint.sh:*)', 'Bash(./run_tests.sh:*)'])
  const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.permissions.allow, ['Bash(./lint.sh:*)', 'Bash(./run_tests.sh:*)'])

  const again = run(['permissions', '--merge'], { CLAUDE_HOME: claudeHome })
  assert.deepEqual(again.added, [], 'idempotent')
  assert.equal(again.already_present, 2)
})

test('permissions --merge preserves settings it did not write', () => {
  const { root, run } = startedRun('perm-keep-repo')
  const claudeHome = path.join(root, 'claude-keep')
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.writeFileSync(path.join(claudeHome, 'settings.json'),
    JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] } }, null, 2))

  run(['permissions', '--merge'], { CLAUDE_HOME: claudeHome })
  const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'))
  assert.equal(settings.theme, 'dark', 'unrelated settings survive')
  assert.deepEqual(settings.permissions.deny, ['Bash(rm:*)'])
  assert.ok(settings.permissions.allow.includes('Bash(ls:*)'), 'existing allow-rules survive')
  assert.ok(settings.permissions.allow.includes('Bash(./lint.sh:*)'))
})
