import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { validators } from '../src/validators.js'
import { proofStamp } from '../src/scan.js'
import { newState } from '../src/state.js'
import { completeArtifact, sandbox, standardRepo, writeFile } from './helpers.js'

// The evidence gates. Their whole job is to make an artifact's claims
// falsifiable at the gate instead of at review round three.

const PROFILE = YAML.parse(`
commands:
  test_targeted: "./run_tests.sh {targeted_specs}"
test_layout: { "src/**": "tests/" }
`)

function ctxFor({ root, repoDir, output = 'artifacts/02-plan.md' } = {}) {
  return {
    runDir: path.join(root, 'run'),
    repoDir,
    profile: PROFILE,
    state: newState({ runId: 'E-1', repo: 'r', stage: 'X' }),
    stageDef: { output },
    stageName: 'X',
    config: {
      stages: {
        CONTEXT: { output: 'artifacts/01-context.md' },
        PLAN: { output: 'artifacts/02-plan.md' },
        TEST: { output: 'artifacts/04-test-report.md' }
      }
    }
  }
}

const coupling = rows => ['| Subject | Evidence command | Hits | Disposition |', '|---|---|---|---|', ...rows].join('\n')
const planWith = (ctx, section) =>
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'E-1', 'PLAN', { Coupling: section })

// ── evidence_verified ────────────────────────────────────────────────────────

test('evidence_verified: a declared hit count that the command does not reproduce blocks, naming both numbers', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'ev-count')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  // src/app.sh and src/util.sh each contain one "echo" line → 2 real hits.
  planWith(ctx, coupling(['| `echo` sites | `git grep -n echo -- src` | 7 | all safe |']))
  const bad = validators.evidence_verified(ctx, 'Coupling')
  assert.equal(bad.ok, false)
  assert.match(bad.reasons[0], /declares 7 hit\(s\).*prints 2/s, 'both the claimed and the real count are named')

  planWith(ctx, coupling(['| `echo` sites | `git grep -n echo -- src` | 2 | all safe |']))
  assert.equal(validators.evidence_verified(ctx, 'Coupling').ok, true)
})

test('evidence_verified: a count that was true at PLAN and drifted since is caught, which is the point', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'ev-drift')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  planWith(ctx, coupling(['| `echo` sites | `git grep -n echo -- src` | 2 | both dispositioned |']))
  assert.equal(validators.evidence_verified(ctx, 'Coupling').ok, true)

  // A later subtask adds a third writer. The row's disposition is now a claim
  // about code that no longer exists.
  repo.write('src/extra.sh', 'echo extra\n')
  repo.git('add', '-A')
  repo.git('commit', '-qm', 'third writer')
  const stale = validators.evidence_verified(ctx, 'Coupling')
  assert.equal(stale.ok, false)
  assert.match(stale.reasons[0], /prints 3/)
  assert.match(stale.reasons[0], /re-check the disposition/)
})

test('evidence_verified: zero hits is a valid row — proving absence is what finds a missing backfill', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'ev-zero')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  planWith(ctx, coupling(['| other writers | `git grep -n NO_SUCH_SYMBOL_ANYWHERE` | 0 | no other writer ⇒ existing rows need AC#2 |']))
  assert.equal(validators.evidence_verified(ctx, 'Coupling').ok, true)
})

test('evidence_verified: only re-runnable read-only searches count as evidence', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'ev-allow')
  const ctx = ctxFor({ root, repoDir: repo.dir })

  planWith(ctx, coupling(['| x | `cat src/app.sh` | 1 | fine |']))
  assert.match(validators.evidence_verified(ctx, 'Coupling').reasons[0], /not a re-runnable read-only search/)

  planWith(ctx, coupling(['| x | `git grep -n echo -- src ; rm -rf /` | 2 | fine |']))
  assert.match(validators.evidence_verified(ctx, 'Coupling').reasons[0], /no shell operators/)

  // A regex containing | is a pattern, not a pipeline — refusing it would push
  // authors toward weaker searches.
  // A literal pipe inside a cell is markdown-escaped; the parser must honour that
  // rather than chop the command in half.
  planWith(ctx, coupling(["| x | `git grep -nE 'app-v1\\|util-v1' -- src` | 2 | both dispositioned |"]))
  assert.equal(validators.evidence_verified(ctx, 'Coupling').ok, true)
})

test('evidence_verified: a row missing its command, count or disposition is named individually', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'ev-rows')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  planWith(ctx, coupling([
    '| no-command | who knows | 3 | safe |',
    '| no-count | `git grep -n echo -- src` |  | safe |',
    '| no-disposition | `git grep -n echo -- src` | 2 |  |'
  ]))
  const result = validators.evidence_verified(ctx, 'Coupling')
  assert.equal(result.ok, false)
  assert.equal(result.reasons.length, 3, 'every defective row is reported, not just the first')
  assert.match(result.reasons.find(r => r.includes('no-command')), /no backticked evidence command/)
  assert.match(result.reasons.find(r => r.includes('no-count')), /declares no Hits/)
  assert.match(result.reasons.find(r => r.includes('no-disposition')), /empty Disposition/)
})

test('evidence_verified: "None." costs a reason — the reason is the check', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'ev-none')
  const ctx = ctxFor({ root, repoDir: repo.dir })

  planWith(ctx, 'None.')
  assert.match(validators.evidence_verified(ctx, 'Coupling').reasons[0], /without a reason/)

  planWith(ctx, 'None — this adds a new file nothing references yet; no symbol is read or written elsewhere.')
  assert.equal(validators.evidence_verified(ctx, 'Coupling').ok, true)
})

// ── ac_proofs ────────────────────────────────────────────────────────────────

const AC_TWO = '| # | Criterion | Verified by | Population |\n|---|---|---|---|\n' +
  '| 1 | greeting updates | app_test | both |\n| 2 | util untouched | manual | new |'

function proofFixture(root, repoName) {
  const repo = standardRepo(root, repoName)
  const ctx = ctxFor({ root, repoDir: repo.dir, output: 'artifacts/04-test-report.md' })
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'E-1', 'CONTEXT', { 'Acceptance criteria': AC_TWO })
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'E-1', 'PLAN', { 'Affected files': '- `src/app.sh`' })
  return { repo, ctx }
}

const report = (ctx, frontmatter, sections = { Deferred: 'None.' }) =>
  completeArtifact(ctx.runDir, 'artifacts/04-test-report.md', 'E-1', 'TEST', sections, frontmatter)

test('ac_proofs: a criterion with no proof blocks; a deferred one does not', () => {
  const { root } = sandbox()
  const { repo, ctx } = proofFixture(root, 'pf-missing')
  const stamp = proofStamp(repo.dir, ['src/app.sh'])
  report(ctx, `proofs:\n  - { ac: 1, test: 'tests/app_test.sh:1', mutation: 'reverted the greeting' }\nproof_stamp: ${stamp}`)
  const result = validators.ac_proofs(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /AC#2 has no proof/)
  assert.match(result.reasons[0], /never seen to fail is a coverage claim, not coverage/)

  report(ctx, `proofs:\n  - { ac: 1, test: 'tests/app_test.sh:1', mutation: 'reverted the greeting' }\nproof_stamp: ${stamp}`,
    { Deferred: 'AC#2 — manual-only check, agreed at the gate.' })
  assert.equal(validators.ac_proofs(ctx).ok, true)
})

test('ac_proofs: a proof without the mutation is not re-runnable, so it is not a proof', () => {
  const { root } = sandbox()
  const { repo, ctx } = proofFixture(root, 'pf-mutation')
  const stamp = proofStamp(repo.dir, ['src/app.sh'])
  report(ctx, `proofs:\n  - { ac: 1, test: 'tests/app_test.sh:1' }\n  - { ac: 2, test: 'manual', mutation: 'x' }\nproof_stamp: ${stamp}`)
  const result = validators.ac_proofs(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons.find(r => r.includes('AC#1')), /records no mutation/)
})

test('ac_proofs: missing ledger names the red→green procedure rather than just the field', () => {
  const { root } = sandbox()
  const { ctx } = proofFixture(root, 'pf-absent')
  report(ctx, '')
  const result = validators.ac_proofs(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /go RED.*restore.*GREEN/s)
})

test('ac_proofs: the ledger EXPIRES when the code under test changes — the fix-round decay catcher', () => {
  const { root } = sandbox()
  const { repo, ctx } = proofFixture(root, 'pf-stale')
  const stamp = proofStamp(repo.dir, ['src/app.sh'])
  const ledger = `proofs:\n  - { ac: 1, test: 'tests/app_test.sh:1', mutation: 'reverted the greeting' }\n  - { ac: 2, test: 'manual', mutation: 'flipped the flag' }\nproof_stamp: ${stamp}`
  report(ctx, ledger)
  assert.equal(validators.ac_proofs(ctx).ok, true, 'a freshly stamped ledger passes')

  // A later review-round fix edits the code the proofs were taken against.
  // Nothing about the ledger changed — which is exactly the silent decay.
  repo.write('src/app.sh', 'echo app-v2-after-review-fix\n')
  const stale = validators.ac_proofs(ctx)
  assert.equal(stale.ok, false)
  assert.match(stale.reasons[0], /STALE/)
  assert.match(stale.reasons[0], /Re-run every proof/)

  report(ctx, ledger.replace(stamp, proofStamp(repo.dir, ['src/app.sh'])))
  assert.equal(validators.ac_proofs(ctx).ok, true, 're-stamping after re-proving clears it')
})

test('ac_proofs: an unstamped ledger is told the exact value to paste', () => {
  const { root } = sandbox()
  const { repo, ctx } = proofFixture(root, 'pf-unstamped')
  report(ctx, `proofs:\n  - { ac: 1, test: 't:1', mutation: 'm' }\n  - { ac: 2, test: 't:2', mutation: 'm' }`)
  const result = validators.ac_proofs(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], new RegExp(proofStamp(repo.dir, ['src/app.sh'])))
})

// ── ac_population ────────────────────────────────────────────────────────────

test('ac_population: a criterion with no population column blocks with the question it exists to force', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'pop-missing')
  const ctx = ctxFor({ root, repoDir: repo.dir, output: 'artifacts/01-context.md' })
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'E-1', 'CONTEXT', {
    'Acceptance criteria': '| # | Criterion | Verified by |\n|---|---|---|\n| 1 | the form saves the mode | form spec |'
  })
  const result = validators.ac_population(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /AC#1 declares no Population/)
  assert.match(result.reasons[0], /rows that are already broken/)
})

test('ac_population: the vocabulary is closed, and a valid table passes', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'pop-vocab')
  const ctx = ctxFor({ root, repoDir: repo.dir, output: 'artifacts/01-context.md' })
  const table = rows => '| # | Criterion | Verified by | Population |\n|---|---|---|---|\n' + rows.join('\n')

  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'E-1', 'CONTEXT', {
    'Acceptance criteria': table(['| 1 | x | spec | sometimes |'])
  })
  assert.match(validators.ac_population(ctx).reasons[0], /not one of: new \/ existing \/ both \/ n-a/)

  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'E-1', 'CONTEXT', {
    'Acceptance criteria': table([
      '| 1 | a school stored as bulk runs delta on its next sync | sync spec | both |',
      '| 2 | new schools default to delta | form spec | new |',
      '| 3 | the copy reads "Delta" | manual | n-a |'
    ])
  })
  assert.equal(validators.ac_population(ctx).ok, true)
})

test('ac_population: an un-tabled criteria section blocks with the column layout', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'pop-untabled')
  const ctx = ctxFor({ root, repoDir: repo.dir, output: 'artifacts/01-context.md' })
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'E-1', 'CONTEXT', { 'Acceptance criteria': '1. it works' })
  assert.match(validators.ac_population(ctx).reasons[0], /# \| Criterion \| Verified by \| Population/)
})

// ── proof-stamp round trip ───────────────────────────────────────────────────

test('proofStamp: changes with the code under test, and is blind to everything else', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'stamp')
  const before = proofStamp(repo.dir, ['src/app.sh'])
  repo.write('src/util.sh', 'echo unrelated-change\n')
  assert.equal(proofStamp(repo.dir, ['src/app.sh']), before, 'a file outside the ledger does not expire it')
  repo.write('src/app.sh', 'echo app-v2\n')
  assert.notEqual(proofStamp(repo.dir, ['src/app.sh']), before)
})

test('proofStamp: a file the plan creates but that does not exist yet still stamps', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'stamp-new')
  const stamp = proofStamp(repo.dir, ['src/app.sh', 'src/planned-but-absent.sh'])
  assert.match(stamp, /^proof:[0-9a-f]{16}$/)
  writeFile(repo.dir, 'src/planned-but-absent.sh', 'echo now-here\n')
  assert.notEqual(proofStamp(repo.dir, ['src/app.sh', 'src/planned-but-absent.sh']), stamp,
    'creating the planned file expires proofs taken before it existed')
})
