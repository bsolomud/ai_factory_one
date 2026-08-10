import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { readEvents } from '../src/state.js'
import { cli, installProfile, readState, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

// Per-run worktrees: the N-terminal contract. Each test gets its own sandbox.
const SLUG = 'example.com-test-w-repo'

function setup() {
  const { root, home } = sandbox()
  const repo = standardRepo(root, 'w-repo')
  installProfile(home, SLUG, STANDARD_PROFILE)
  const wt = id => path.join(home, 'worktrees', SLUG, id)
  const runDir = id => path.join(home, 'repos', SLUG, 'runs', id)
  return { root, home, repo, wt, runDir }
}

const gitIn = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

test('new-run --worktree: detached tree under the pipeline home, honest baseline, event + output', () => {
  const { home, repo, wt, runDir } = setup()
  repo.write('scratch.txt', 'ambient dev scratch\n') // untracked in the CLONE only

  const out = cli(['new-run', 'W-1', '--worktree'], { home, cwd: repo.dir })
  assert.equal(out.verdict, 'CREATED')
  assert.equal(out.worktree, wt('W-1'), 'output carries the worktree path')
  assert.ok(fs.existsSync(path.join(wt('W-1'), 'src', 'app.sh')), 'tree materialized at base')
  assert.equal(gitIn(wt('W-1'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached at base — no branch claimed')

  const state = readState(runDir('W-1'))
  assert.equal(state.git.worktree, wt('W-1'))
  assert.deepEqual(state.git.baseline_untracked, [], 'baseline is the WORKTREE snapshot, not the clone with its scratch')
  const created = readEvents(runDir('W-1')).find(e => e.event === 'worktree_created')
  assert.deepEqual({ path: created.path, base: created.base }, { path: wt('W-1'), base: 'master' })
})

test('run id validation blocks path segments (also for the plain run dir)', () => {
  const { home, repo } = setup()
  for (const bad of ['../evil', 'a/b', 'a b']) {
    const out = cli(['new-run', bad, '--worktree'], { home, cwd: repo.dir })
    assert.equal(out.verdict, 'ERROR', `'${bad}' rejected`)
  }
})

test('N terminals: cwd inside a worktree selects ITS run with no --run; the clone stays ambiguous', () => {
  const { home, repo, wt } = setup()
  cli(['new-run', 'W-1', '--worktree'], { home, cwd: repo.dir })
  cli(['new-run', 'W-2', '--worktree'], { home, cwd: repo.dir })

  const fromW2 = cli(['status'], { home, cwd: wt('W-2') })
  assert.equal(fromW2.run, 'W-2', 'worktree cwd resolves the run')
  const fromW1 = cli(['status'], { home, cwd: wt('W-1') })
  assert.equal(fromW1.run, 'W-1')

  const fromClone = cli(['status'], { home, cwd: repo.dir })
  assert.equal(fromClone.run, undefined, 'two active runs from the clone → must name one')
  assert.match(fromClone.next_action, /--run/)
})

test('a worktree cwd never clobbers the canonical repo location', () => {
  const { home, repo, wt } = setup()
  cli(['new-run', 'W-1', '--worktree'], { home, cwd: repo.dir })
  const locFile = path.join(home, 'repos', SLUG, 'location')
  const before = fs.readFileSync(locFile, 'utf8')
  cli(['status'], { home, cwd: wt('W-1') })
  cli(['show', '--run', 'W-1'], { home, cwd: wt('W-1') })
  assert.equal(fs.readFileSync(locFile, 'utf8'), before, 'location still points at the clone')
})

test('commands follow the run worktree from anywhere: branch created in the tree is recorded while the clone sits on master', () => {
  const { home, repo, wt, runDir } = setup()
  cli(['new-run', 'W-1', '--worktree'], { home, cwd: repo.dir })
  gitIn(wt('W-1'), 'checkout', '-qb', 'T-W1') // BREAKDOWN does this in the workdir

  const out = cli(['advance', '--run', 'W-1'], { home, cwd: repo.dir }) // invoked from the CLONE
  assert.notEqual(out.verdict, 'ERROR')
  assert.equal(readState(runDir('W-1')).git.branch, 'T-W1', 'branch recorded from the worktree, not the clone')
  assert.equal(gitIn(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master', 'clone untouched')
  assert.ok(readEvents(runDir('W-1')).some(e => e.event === 'branch_recorded' && e.branch === 'T-W1'))
})

test('worktree remove: refuses a dirty tree, --force discards, state and events updated', () => {
  const { home, repo, wt, runDir } = setup()
  cli(['new-run', 'W-1', '--worktree'], { home, cwd: repo.dir })
  fs.writeFileSync(path.join(wt('W-1'), 'src', 'app.sh'), 'echo dirty\n')

  const refused = cli(['worktree', 'remove', '--run', 'W-1'], { home, cwd: repo.dir })
  assert.equal(refused.verdict, 'ERROR')
  assert.match(refused.error, /--force/)
  assert.ok(fs.existsSync(wt('W-1')), 'dirty tree kept')

  const removed = cli(['worktree', 'remove', '--run', 'W-1', '--force'], { home, cwd: repo.dir })
  assert.equal(removed.verdict, 'OK')
  assert.ok(!fs.existsSync(wt('W-1')), 'tree gone')
  assert.equal(readState(runDir('W-1')).git.worktree, null)
  assert.ok(readEvents(runDir('W-1')).some(e => e.event === 'worktree_removed'))
})

test('worktree remove --delete-branch refuses while the run is in flight', () => {
  const { home, repo, wt } = setup()
  cli(['new-run', 'W-1', '--worktree'], { home, cwd: repo.dir })
  gitIn(wt('W-1'), 'checkout', '-qb', 'T-W1')
  cli(['advance', '--run', 'W-1'], { home, cwd: repo.dir }) // records the branch
  const out = cli(['worktree', 'remove', '--run', 'W-1', '--delete-branch'], { home, cwd: repo.dir })
  assert.equal(out.verdict, 'ERROR')
  assert.match(out.error, /in-flight/)
})

test('worktree add retrofits an existing run: tree on the recorded branch, baseline re-snapshotted', () => {
  const { home, repo, wt, runDir } = setup()
  repo.write('scratch.txt', 'ambient\n')
  cli(['new-run', 'W-3'], { home, cwd: repo.dir }) // plain run — baseline is the clone's scratch
  assert.deepEqual(readState(runDir('W-3')).git.baseline_untracked, ['scratch.txt'])
  gitIn(repo.dir, 'checkout', '-qb', 'T-W3')
  cli(['advance', '--run', 'W-3'], { home, cwd: repo.dir }) // records branch T-W3
  gitIn(repo.dir, 'checkout', '-q', 'master') // free the branch for the worktree

  const out = cli(['worktree', 'add', '--run', 'W-3'], { home, cwd: repo.dir })
  assert.equal(out.verdict, 'OK')
  assert.equal(out.checked_out, 'T-W3', 'retrofit lands on the run branch')
  assert.equal(gitIn(wt('W-3'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'T-W3')
  const state = readState(runDir('W-3'))
  assert.equal(state.git.worktree, wt('W-3'))
  assert.deepEqual(state.git.baseline_untracked, [], 'baseline re-snapshotted against the fresh tree')
})

test('reconcile: rebuilt state restores the worktree from events; a missing tree is a note, not a wall', () => {
  const { home, repo, wt, runDir } = setup()
  cli(['new-run', 'W-1', '--worktree'], { home, cwd: repo.dir })
  fs.rmSync(path.join(runDir('W-1'), 'state.json'))
  const status = cli(['status', '--run', 'W-1'], { home, cwd: repo.dir })
  assert.equal(status.verdict, 'ACTIVE_RUN')
  assert.equal(readState(runDir('W-1')).git.worktree, wt('W-1'), 'worktree replayed from events.jsonl')

  fs.rmSync(wt('W-1'), { recursive: true, force: true })
  const after = cli(['status', '--run', 'W-1'], { home, cwd: repo.dir })
  assert.ok(after.reconcile_notes.some(n => /worktree .* missing/.test(n)), 'missing tree surfaced as a note')

  const blocked = cli(['show', '--run', 'W-1'], { home, cwd: repo.dir })
  assert.equal(blocked.verdict, 'ERROR')
  assert.match(blocked.error, /worktree add|worktree remove/, 'commands needing the tree point at the recovery verbs')
})

test('back-compat: a run without --worktree behaves exactly as before', () => {
  const { home, repo, runDir } = setup()
  const out = cli(['new-run', 'W-9'], { home, cwd: repo.dir })
  assert.equal(out.verdict, 'CREATED')
  assert.equal(out.worktree, undefined, 'no worktree key in the output')
  assert.equal(readState(runDir('W-9')).git.worktree, null)
  assert.equal(cli(['status'], { home, cwd: repo.dir }).run, 'W-9', 'single-active shortcut intact')
})
