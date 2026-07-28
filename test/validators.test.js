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
