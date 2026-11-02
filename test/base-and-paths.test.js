import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { pathsInSection, backtickPaths } from '../src/artifacts.js'
import { changedFiles, diffBase } from '../src/profile.js'
import { hashAtRef, hashPath } from '../src/scan.js'
import { cli, installProfile, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

// Three pilot runs each lost a PLAN round to prose read as paths.
test('Affected files: only the Path column, and only path-shaped tokens, are claims', () => {
  const section = [
    '| Path | Change | New? |',
    '|------|--------|------|',
    '| `app/models/user.rb` | calls `user.session_keys`, `A::B.site`, `/sso`, `try/catch`, `CLAUDE.md` | |',
    '| `spec/models/user_spec.rb` | pins it | (new) |',
    '| `a\\|b` or `x` | prose | |'
  ].join('\n')
  assert.deepEqual(pathsInSection(section), [
    { path: 'app/models/user.rb', isNew: false },
    { path: 'spec/models/user_spec.rb', isNew: true }
  ])
  assert.deepEqual(
    backtickPaths('subtask: edit `app/x.rb`; call `user.session_keys`, `picker.getParsedDate`, `.to_s`, `A::B.site`, `/sso`, `https://x.io/a`; read `CLAUDE.md`, `.rubocop.yml`, `Gemfile.lock`'),
    ['app/x.rb', 'CLAUDE.md', '.rubocop.yml', 'Gemfile.lock'])
})

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim()

// A stale or moved base turned into 215 phantom files in one pilot run.
test('diffBase: the change is diffed from the newest common ancestor, not from a moved base tip', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'app-repo')
  const trunk = git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD')
  git(repo.dir, 'checkout', '-qb', 'run-branch')
  repo.write('src/app.sh', 'echo mine\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'mine')
  // The trunk moves on after the branch left it.
  git(repo.dir, 'checkout', '-q', trunk)
  repo.write('src/util.sh', 'echo theirs\n'); repo.write('other/new.txt', 'x\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'theirs')
  git(repo.dir, 'checkout', '-q', 'run-branch')
  assert.deepEqual(changedFiles(repo.dir, trunk), ['src/app.sh'], 'the trunk\'s later commits are not this change')

  // origin/<trunk> stale (left at the fork point), local trunk fresh: the newest ancestor wins either way.
  const forkPoint = git(repo.dir, 'merge-base', trunk, 'HEAD')
  git(repo.dir, 'update-ref', `refs/remotes/origin/${trunk}`, forkPoint)
  assert.equal(diffBase(repo.dir, trunk), forkPoint)
  // The branch merges the moved trunk; a stale origin ref must not resurrect the trunk's files.
  git(repo.dir, 'merge', '-q', '--no-edit', trunk)
  assert.deepEqual(changedFiles(repo.dir, trunk), ['src/app.sh'], 'files that came in with a trunk merge are not this change')
})

// The profile looked stale whenever the shared checkout stood on a feature branch.
test('profile staleness is judged on the base branch, not on the checked-out branch', () => {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'stale-repo')
  const trunk = git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD')
  const slug = 'example.com-test-stale-repo'
  const h = hashPath(path.join(repo.dir, 'lint.sh'))
  assert.equal(hashAtRef(repo.dir, trunk, 'lint.sh'), h, 'same digest as the file on disk')
  assert.equal(hashAtRef(repo.dir, trunk, 'src'), hashPath(path.join(repo.dir, 'src')), 'and for a directory')
  installProfile(home, slug, STANDARD_PROFILE + `evidence_hashes:\n  lint.sh: "${h}"\n`)
  const run = args => cli(args, { home, cwd: repo.dir })

  // The developer stands on a feature branch that edits the evidence file.
  git(repo.dir, 'checkout', '-qb', 'feature/x')
  repo.write('lint.sh', 'echo changed on a feature branch\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'feature')
  assert.notEqual(run(['status']).verdict, 'PROFILE_STALE', 'the base branch did not change')
  assert.equal(run(['hash', 'lint.sh']).hashes['lint.sh'], h, 'hash reads the base branch too, so onboarding and the check agree')
  assert.equal(run(['hash', 'lint.sh', '--worktree']).hashed_at, 'working tree')

  // The base branch itself changes: now it is stale.
  git(repo.dir, 'checkout', '-q', trunk)
  repo.write('lint.sh', 'echo changed on the trunk\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'trunk')
  git(repo.dir, 'checkout', '-q', 'feature/x')
  assert.equal(run(['status']).verdict, 'PROFILE_STALE')
})
