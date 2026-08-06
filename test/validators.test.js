import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import YAML from 'yaml'
import { validators, runValidators } from '../src/validators.js'
import { newState } from '../src/state.js'
import { changedFiles, globToRegex, substitute, targetedTests } from '../src/profile.js'
import { completeArtifact, makeRepo, sandbox, standardRepo, writeFile } from './helpers.js'

const PROFILE = YAML.parse(`
commands:
  lint_changed: "./lint.sh {changed_files}"
  test_targeted: "./run_tests.sh {targeted_specs}"
test_layout: { "src/**": "tests/" }
no_touch: ["locked/**"]
`)

function ctxFor({ root, repoDir, output = 'artifacts/02-plan.md', state } = {}) {
  return {
    runDir: path.join(root, 'run'),
    repoDir,
    profile: PROFILE,
    state: state || newState({ runId: 'T-1', repo: 'r', stage: 'X' }),
    stageDef: { output },
    stageName: 'X',
    config: { stages: { PLAN: { output: 'artifacts/02-plan.md' } } }
  }
}

test('artifact_complete: missing file → actionable message', () => {
  const { root } = sandbox()
  const result = validators.artifact_complete(ctxFor({ root }), 'artifacts/02-plan.md')
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /does not exist.*template/i)
})

test('artifact_complete: draft status names the fix', () => {
  const { root } = sandbox()
  const ctx = ctxFor({ root })
  writeFile(ctx.runDir, 'artifacts/02-plan.md', '---\nstatus: draft\n---\n## Approach\nx\n')
  const result = validators.artifact_complete(ctx, 'artifacts/02-plan.md')
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /status 'draft'.*status: complete.*LAST/s)
})

test('sections: missing and empty sections each reported; template comments do not count as content', () => {
  const { root } = sandbox()
  const ctx = ctxFor({ root })
  writeFile(ctx.runDir, 'artifacts/02-plan.md',
    '---\nstatus: complete\n---\n## Approach\nreal text\n## Risks\n<!-- only a template comment -->\n')
  const result = validators.sections(ctx, ['Approach', 'Risks', 'Subtasks'])
  assert.equal(result.ok, false)
  assert.equal(result.reasons.length, 2)
  assert.match(result.reasons.find(r => r.includes('Risks')), /empty/)
  assert.match(result.reasons.find(r => r.includes('Subtasks')), /missing/)
})

test('files_exist_in_repo: hallucinated path blocked, (new) exempt', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    'Affected files': '- `src/app.sh`\n- `src/ghost.sh`\n- `src/created.sh` (new)'
  })
  const result = validators.files_exist_in_repo(ctx, 'Affected files')
  assert.equal(result.ok, false)
  assert.equal(result.reasons.length, 1)
  assert.match(result.reasons[0], /src\/ghost\.sh.*does not exist/)
})

test('files_exist_in_repo: TABLE-formatted Affected files parses (Step-2 shape)', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo-tbl')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  // The Affected files section is now a markdown table; the header row, the
  // separator row, and the description/New? columns must NOT be read as paths,
  // and (new) in a row still exempts that file from the existence check.
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    'Affected files':
      '| Path | Change | New? |\n' +
      '|------|--------|------|\n' +
      '| `src/app.sh` | edit the guard | |\n' +
      '| `src/ghost.sh` | edit | |\n' +
      '| `src/created.sh` | scaffolded | (new) |'
  })
  const result = validators.files_exist_in_repo(ctx, 'Affected files')
  assert.equal(result.ok, false)
  assert.equal(result.reasons.length, 1, 'only the hallucinated path is flagged; header/separator/(new) ignored')
  assert.match(result.reasons[0], /src\/ghost\.sh.*does not exist/)
})

test('profile_command: empty slot → skip recorded as UNVERIFIED', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo2')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  ctx.profile = { commands: {} }
  const result = validators.profile_command(ctx, 'lint_changed')
  assert.equal(result.skip, true)
  assert.match(result.reason, /UNVERIFIED/)
})

test('profile_command: failing command → exit code + output tail in reason', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo3')
  repo.write('src/app.sh', 'echo LINTFAIL\n')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  const result = validators.profile_command(ctx, 'lint_changed')
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /command failed \(exit 1\)/)
  assert.match(result.reasons[0], /contains LINTFAIL/)
})

test('git_clean_within: out-of-plan file and no_touch violation both block', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo4')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    'Affected files': '- `src/app.sh`'
  })
  repo.write('src/app.sh', 'echo changed\n')     // allowed
  repo.write('src/rogue.sh', 'echo rogue\n')     // outside plan
  repo.write('locked/keep.txt', 'mutated\n')     // no_touch
  const result = validators.git_clean_within(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons.find(r => r.includes('rogue')), /outside the approved plan/)
  assert.match(result.reasons.find(r => r.includes('locked/keep.txt')), /no_touch/)
  assert.ok(!result.reasons.some(r => r.includes('src/app.sh')), 'planned file is allowed')
})

test('git_clean_within: ambient untracked files snapshotted at run start never block', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo4b')
  // scratch.md was already untracked before the run — capture it as the baseline.
  repo.write('scratch.md', 'my notes\n')
  const state = newState({
    runId: 'T-1', repo: 'r', stage: 'IMPLEMENT',
    baselineUntracked: ['scratch.md']
  })
  const ctx = ctxFor({ root, repoDir: repo.dir, state })
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    'Affected files': '- `src/app.sh`'
  })
  repo.write('src/app.sh', 'echo changed\n')     // planned
  repo.write('src/rogue.sh', 'echo rogue\n')     // NEW untracked during the run → still caught
  const result = validators.git_clean_within(ctx)
  assert.equal(result.ok, false)
  assert.ok(!result.reasons.some(r => r.includes('scratch.md')), 'pre-existing untracked file is ignored')
  assert.match(result.reasons.find(r => r.includes('rogue')), /outside the approved plan/)
})

// --- review_counts: review effectiveness machine-readable, blocking gates ---

test('review_counts: missing counts block with the shape; blocking > 0 blocks; clean passes', () => {
  const { root } = sandbox()
  const ctx = ctxFor({ root, output: 'artifacts/05-review.md' })
  completeArtifact(ctx.runDir, 'artifacts/05-review.md', 'T-1', 'REVIEW', { Findings: 'None.' })
  let result = validators.review_counts(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /findings: \{ blocking: n/)

  completeArtifact(ctx.runDir, 'artifacts/05-review.md', 'T-1', 'REVIEW', { Findings: 'race in x' },
    'findings: { blocking: 1, advisory: 0, fixed: 0, disputed: 0 }')
  result = validators.review_counts(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /1 unresolved BLOCKING finding/)

  completeArtifact(ctx.runDir, 'artifacts/05-review.md', 'T-1', 'REVIEW', { Findings: 'race in x — fixed' },
    'findings: { blocking: 0, advisory: 2, fixed: 1, disputed: 0 }')
  assert.equal(validators.review_counts(ctx).ok, true)
})

// --- ac_traceability: no acceptance criterion silently dropped at TEST ---

test('ac_traceability: unmapped AC blocks; mapped or deferred ACs pass; AC#1 does not match AC#12', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-ac1')
  const ctx = ctxFor({ root, repoDir: repo.dir, output: 'artifacts/04-test-report.md' })
  ctx.config = { stages: { CONTEXT: { output: 'artifacts/01-context.md' }, TEST: { output: 'artifacts/04-test-report.md' } } }
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT', {
    'Acceptance criteria':
      '| # | Criterion | Verified by |\n|---|---|---|\n' +
      '| 1 | greeting updates | app_test |\n| 2 | util untouched | manual |\n| 12 | logs stay quiet | log spec |'
  })
  completeArtifact(ctx.runDir, 'artifacts/04-test-report.md', 'T-1', 'TEST', {
    'Risk-to-test map': '| Risk | Test | Coverage |\n|---|---|---|\n| AC#12 — logs | log spec | covered |',
    Deferred: 'AC#2 — deferred at the gate: manual-only check.'
  })
  const result = validators.ac_traceability(ctx)
  assert.equal(result.ok, false)
  assert.equal(result.reasons.length, 1, 'AC#12 in the map must not satisfy AC#1')
  assert.match(result.reasons[0], /AC#1 is not accounted for/)

  completeArtifact(ctx.runDir, 'artifacts/04-test-report.md', 'T-1', 'TEST', {
    'Risk-to-test map': 'AC#1 → tests/app_test.sh. AC#12 → log spec.',
    Deferred: 'AC#2 — manual-only.'
  })
  assert.equal(validators.ac_traceability(ctx).ok, true)
})

test('ac_traceability: un-numbered acceptance criteria block with the numbering instruction', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-ac2')
  const ctx = ctxFor({ root, repoDir: repo.dir, output: 'artifacts/04-test-report.md' })
  ctx.config = { stages: { CONTEXT: { output: 'artifacts/01-context.md' }, TEST: { output: 'artifacts/04-test-report.md' } } }
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'T-1', 'CONTEXT', {
    'Acceptance criteria': 'the app should work better'
  })
  const result = validators.ac_traceability(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /no numbered rows/)
})

// --- no_secrets: committed credentials caught at the subtask gate, not at PR ---

test('no_secrets: committed secret default and new-file token block; ENV lookup passes (MB-46498 class)', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-secrets1')
  repo.git('checkout', '-qb', 'T-1')
  // Committed diff: a quoted literal secret — exactly the shape of a config default.
  repo.write('src/config.sh', 'sync_support_password: "hunter2secret"\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'add config')
  // New untracked file the run created: a well-known token format.
  repo.write('src/key.txt', 'aws AKIAIOSFODNN7EXAMPLE\n')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  const result = validators.no_secrets(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons.find(r => r.includes('src/config.sh')), /credential assignment.*never commit/s)
  assert.match(result.reasons.find(r => r.includes('src/key.txt')), /AWS access key id/)

  // ENV-injected value and a disarmed dummy both pass.
  repo.write('src/key.txt', 'ok\n')
  repo.write('src/config.sh', 'sync_support_password: ENV["SUPPORT_PASSWORD"]\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'env-injected')
  assert.equal(validators.no_secrets(ctx).ok, true, 'ENV lookup is not a literal secret')
  repo.write('src/fixture.sh', 'password: "dummy-value-123" # pipeline:allow-secret\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'fixture')
  assert.equal(validators.no_secrets(ctx).ok, true, 'allow-secret disarms a deliberate dummy')
})

test('no_secrets: ambient untracked files are not scanned; run-created ones are', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-secrets2')
  repo.write('my-notes.md', 'password: "my-personal-vault-pass"\n') // ambient scratch
  const state = newState({ runId: 'T-1', repo: 'r', stage: 'IMPLEMENT', baselineUntracked: ['my-notes.md'] })
  const ctx = ctxFor({ root, repoDir: repo.dir, state })
  assert.equal(validators.no_secrets(ctx).ok, true, 'developer scratch never blocks')
})

// --- subtask_coupling: the MB-46745 plan defect as an exit code ---

test('subtask_coupling: breaking change split from its adapting spec BLOCKS (MB-46745 regression)', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-couple1')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  // src/app.sh maps to tests/app_test.sh via test_layout — putting the spec in
  // a different subtask is exactly the split that aborted MB-46745.
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    'Affected files': '- `src/app.sh`\n- `tests/app_test.sh`',
    Subtasks:
      '| # | Subtask | Files |\n' +
      '|---|---------|-------|\n' +
      '| 1 | breaking model change | `src/app.sh` |\n' +
      '| 2 | rewrite the spec | `tests/app_test.sh` |'
  })
  const result = validators.subtask_coupling(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /spec tests\/app_test\.sh is in subtask 2.*ONE subtask/s)
})

test('subtask_coupling: change and spec in the SAME subtask passes; numbered-list format accepted', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-couple2')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    'Affected files': '- `src/app.sh`\n- `tests/app_test.sh`\n- `src/util.sh`',
    Subtasks: '1. app + its spec — `src/app.sh`, `tests/app_test.sh`\n2. util — `src/util.sh`'
  })
  assert.equal(validators.subtask_coupling(ctx).ok, true)
})

test('subtask_coupling: orphan affected file, double-claim, and undeclared subtask file each reported', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-couple3')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    'Affected files': '- `src/app.sh`\n- `src/util.sh`\n- `src/orphan.sh`',
    Subtasks:
      '| # | Subtask | Files |\n' +
      '|---|---------|-------|\n' +
      '| 1 | app | `src/app.sh`, `src/stranger.sh` |\n' +
      '| 2 | app again + util | `src/app.sh`, `src/util.sh` |'
  })
  const result = validators.subtask_coupling(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons.find(r => r.includes('orphan')), /no subtask claims it/)
  assert.match(result.reasons.find(r => r.includes('claimed by both')), /subtask 1 and subtask 2/)
  assert.match(result.reasons.find(r => r.includes('stranger')), /not in '## Affected files'/)
})

test('subtask_coupling: subtasks without declared Files block with the table instruction', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-couple4')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  completeArtifact(ctx.runDir, 'artifacts/02-plan.md', 'T-1', 'PLAN', {
    'Affected files': '- `src/app.sh`',
    Subtasks: '1. do the thing\n2. do the other thing'
  })
  const result = validators.subtask_coupling(ctx)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /subtask 1 lists no Files/)
})

test('min_commits_per_subtask: counts branch commits against the cursor', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo5')
  repo.git('checkout', '-qb', 'T-1')
  const state = newState({ runId: 'T-1', repo: 'r', stage: 'IMPLEMENT' })
  state.substate.subtask = 1
  const ctx = ctxFor({ root, repoDir: repo.dir, state })
  assert.match(validators.min_commits_per_subtask(ctx).reasons[0], /found 0 — commit/)
  repo.write('src/app.sh', 'echo v2\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'subtask 1')
  assert.equal(validators.min_commits_per_subtask(ctx).ok, true)
})

test('substate_set: unset key names the exact command to run', () => {
  const { root } = sandbox()
  const result = validators.substate_set(ctxFor({ root }), ['subtask', 'of'])
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /pipeline set-substate subtask=/)
})

test('runValidators collects ALL failures, not fail-fast', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo6')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  ctx.stageDef = {
    output: 'artifacts/02-plan.md',
    validate: [
      { artifact_complete: 'artifacts/02-plan.md' },
      { substate_set: ['subtask'] },
      { profile_command: 'post_change_hooks' }
    ]
  }
  ctx.profile = { commands: {} }
  const result = runValidators(ctx)
  assert.equal(result.ok, false)
  assert.equal(result.reasons.length, 2, 'both failures collected')
  assert.equal(result.unverified.length, 1, 'skip recorded alongside failures')
})

test('substitute: empty placeholder refuses to run (never a suite-wide run)', () => {
  assert.deepEqual(substitute('lint {changed_files}', { files: ['a b.txt'], tests: [] }),
    { cmd: `lint 'a b.txt'` })
  assert.match(substitute('t {targeted_specs}', { files: ['x'], tests: [] }).skip, /resolved to no files/)
  assert.match(substitute('x {nope}', { files: ['x'], tests: [] }).skip, /unknown placeholder/)
})

test('targetedTests maps changed src files to existing test files only', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'v-repo7')
  const profile = { test_layout: { 'src/**': 'tests/' } }
  assert.deepEqual(targetedTests(repo.dir, ['src/app.sh'], profile), ['tests/app_test.sh'])
  assert.deepEqual(targetedTests(repo.dir, ['src/util.sh'], profile), [], 'no test file → nothing (→ UNVERIFIED), never everything')
  assert.deepEqual(targetedTests(repo.dir, ['tests/app_test.sh'], profile), ['tests/app_test.sh'], 'changed test runs itself')
})

// MB-47027: a changed factory/helper under the test dir was passed verbatim to
// the runner, which errored loading it → gate false-BLOCKED. Only files that
// LOOK like runnable tests may ride the "changed file IS a test" branch.
test('targetedTests: non-runnable files under a test dir are never targeted', () => {
  const { root } = sandbox()
  const repo = makeRepo(root, 'v-repo8')
  repo.write('app/models/one_roster/import.rb', 'class Import; end\n')
  repo.write('spec/models/one_roster/import_spec.rb', 'ok\n')
  // no trailing slashes, like mb_rails4's real profile — exercises the dir+'/' normalization
  const profile = { test_layout: { 'app/**': 'spec', 'app/packs/**': 'spec/packs' } }
  assert.deepEqual(targetedTests(repo.dir, ['spec/factories/one_roster/imports.rb'], profile), [], 'factory is not a runnable spec')
  assert.deepEqual(targetedTests(repo.dir, ['spec/support/shared_contexts/foo.rb'], profile), [], 'support file is not a runnable spec')
  assert.deepEqual(targetedTests(repo.dir, ['spec/rails_helper.rb'], profile), [], 'rails_helper is not a runnable spec')
  assert.deepEqual(targetedTests(repo.dir, ['spec/models/one_roster/history_spec.rb'], profile), ['spec/models/one_roster/history_spec.rb'])
  assert.deepEqual(targetedTests(repo.dir, ['spec/packs/foo/bar.test.js'], profile), ['spec/packs/foo/bar.test.js'])
  assert.deepEqual(targetedTests(repo.dir, ['app/models/one_roster/import.rb'], profile),
    [path.join('spec/models/one_roster', 'import_spec.rb')], 'src mirroring unaffected')
  assert.deepEqual(targetedTests(repo.dir, ['spec_helper.rb'], profile), [], "test dir 'spec' must not prefix-match a sibling like spec_helper.rb")
})

test('targetedTests: mirror candidates are filtered to runnable tests too', () => {
  const { root } = sandbox()
  const repo = makeRepo(root, 'v-repo9')
  repo.write('tests/app_test.sh', 'exit 0\n')
  repo.write('tests/app.fixture.json', '{}\n')
  const profile = { test_layout: { 'src/**': 'tests/' } }
  assert.deepEqual(targetedTests(repo.dir, ['src/app.sh'], profile), [path.join('tests', 'app_test.sh')], 'fixture sibling excluded')
})

test('targetedTests: profile test_file_pattern overrides the default', () => {
  const { root } = sandbox()
  const repo = makeRepo(root, 'v-repo10')
  const profile = { test_layout: { 'src/**': 'tests/' }, test_file_pattern: 'test_.*\\.py$' }
  assert.deepEqual(targetedTests(repo.dir, ['tests/test_app.py'], profile), ['tests/test_app.py'])
  assert.deepEqual(targetedTests(repo.dir, ['tests/app_test.sh'], profile), [], 'default pattern no longer applies')
  assert.deepEqual(targetedTests(repo.dir, ['tests/conftest.py'], profile), [])
})

// --- P1a: changed-file scoping ---

test('changedFiles: excludes ambient untracked by default; boundary opts in (MB-46745)', () => {
  const { root } = sandbox()
  const repo = makeRepo(root, 'cf-repo')
  repo.write('a.txt', 'v1\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'init')
  repo.write('a.txt', 'v2\n')          // tracked, modified
  repo.write('scratch.md', 'notes\n')  // ambient untracked
  assert.deepEqual(changedFiles(repo.dir, 'master'), ['a.txt'], 'untracked excluded by default')
  assert.deepEqual(
    changedFiles(repo.dir, 'master', { includeUntracked: true }).sort(),
    ['a.txt', 'scratch.md'],
    'boundary check opts into untracked'
  )
})

test('profile_command: {changed_files} scoped to the command\'s when-glob (MB-46745)', () => {
  const { root } = sandbox()
  const repo = makeRepo(root, 'scope-repo')
  // Fails if handed anything that is not a .rb path — proves .md is not passed.
  repo.write('only_rb.sh', '#!/usr/bin/env bash\nfor f in "$@"; do [[ "$f" == *.rb ]] || { echo "got non-rb: $f"; exit 1; }; done\nexit 0\n')
  repo.write('foo.rb', '# ruby\n')
  repo.write('bar.md', 'markdown\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'init')
  repo.write('foo.rb', '# ruby v2\n')
  repo.write('bar.md', 'markdown v2\n')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  ctx.profile = { commands: { lint_changed: [{ run: './only_rb.sh {changed_files}', when: '**/*.rb' }] } }
  const result = validators.profile_command(ctx, 'lint_changed')
  assert.equal(result.ok, true, 'rubocop-like command only received foo.rb, never bar.md')
})

// --- P1b: honest coverage-gap signal ---

test('profile_command: source changed with no mirror spec → LOUD coverage-gap UNVERIFIED', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'gap-repo')
  repo.write('src/util.sh', 'echo util-v2\n') // src/util.sh has NO tests/util_test.sh
  const ctx = ctxFor({ root, repoDir: repo.dir })
  const result = validators.profile_command(ctx, 'test_targeted')
  assert.equal(result.skip, true)
  assert.match(result.reason, /no mirror spec/i)
  assert.match(result.reason, /src\/util\.sh/)
  assert.match(result.reason, /coverage gap/i)
})

test('profile_command: config/non-source change → SOFT not-applicable skip (not a gap)', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'soft-repo')
  repo.write('lint.sh', 'echo tweak\n')       // tracked, not under src/** → no spec expected
  const ctx = ctxFor({ root, repoDir: repo.dir })
  const result = validators.profile_command(ctx, 'test_targeted')
  assert.equal(result.skip, true)
  assert.match(result.reason, /not applicable/i)
  assert.doesNotMatch(result.reason, /no mirror spec/i)
  assert.match(result.reason, /not a coverage gap/i)
})

test('profile_command: opt-in test_fallback runs when targeted resolves empty but source changed', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'fallback-repo')
  repo.write('src/util.sh', 'echo util-v2\n')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  ctx.profile = {
    commands: {
      test_targeted: './run_tests.sh {targeted_specs}',
      test_fallback: './run_tests.sh tests/app_test.sh'  // convention-safe, repo-defined
    },
    test_layout: { 'src/**': 'tests/' }
  }
  const result = validators.profile_command(ctx, 'test_targeted')
  assert.equal(result.ok, true, 'fallback ran and passed instead of recording UNVERIFIED')
})

// --- P3: optional slots are "not configured", not a coverage gap ---

test('profile_command: absent OPTIONAL slot → not_configured, not a coverage gap', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'opt-repo')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  ctx.profile = { commands: { lint_changed: './lint.sh {changed_files}', test_targeted: './run_tests.sh {targeted_specs}' } }
  const result = validators.profile_command(ctx, 'post_change_hooks')
  assert.equal(result.skip, true)
  assert.match(result.reason, /not configured/i)
  assert.match(result.reason, /not a coverage gap/i)
})

test('profile_command: absent REQUIRED slot still reads as a real coverage gap', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'req-repo')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  ctx.profile = { commands: {} }
  const result = validators.profile_command(ctx, 'test_targeted')
  assert.equal(result.skip, true)
  assert.match(result.reason, /coverage gap/i)
  assert.doesNotMatch(result.reason, /not configured/i)
})

test('globToRegex: **, * and !(x) segment negation', () => {
  assert.ok(globToRegex('locked/**').test('locked/a/b.txt'))
  assert.ok(!globToRegex('locked/**').test('unlocked/a.txt'))
  assert.ok(globToRegex('config/locales/!(en)/**').test('config/locales/fr/x.yml'))
  assert.ok(!globToRegex('config/locales/!(en)/**').test('config/locales/en/x.yml'))
  assert.ok(globToRegex('*.md').test('README.md'))
  assert.ok(!globToRegex('*.md').test('docs/README.md'))
})
