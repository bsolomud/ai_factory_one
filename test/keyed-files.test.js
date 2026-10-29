import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { validators } from '../src/validators.js'
import { validateProfile } from '../src/profile.js'
import { newState } from '../src/state.js'
import { sandbox, standardRepo } from './helpers.js'

// A pilot run hand-picked a round migration key; it collided with work merged
// meanwhile, the rename picked another round value, and that collided again
// after the PR opened.

const KEYED = [{ glob: 'db/migrate/*.rb', key: '^(\\d{14})_' }]

test('keyed_file_collision: a new keyed file may not reuse a key on the base tip, fetched fresh', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'keyed-repo')
  const git = (...a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8' }).trim()
  const trunk = git('rev-parse', '--abbrev-ref', 'HEAD')
  // A local bare origin stands in for the shared remote.
  const origin = path.join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin])
  git('remote', 'set-url', 'origin', origin)
  git('push', '-q', 'origin', `${trunk}:${trunk}`)
  git('checkout', '-qb', 'run-branch')

  const state = newState({ runId: 'K-1', repo: 'r', stage: 'PR', base: trunk })
  const ctx = profile => ({ runDir: path.join(root, 'run'), repoDir: repo.dir, profile, state, stageDef: {}, stageName: 'PR', config: {} })
  repo.write('db/migrate/20261015120000_add_x.rb', 'x\n')
  assert.equal(validators.keyed_file_collision(ctx({})).ok, true, 'no keyed_files declared: nothing to check')
  assert.equal(validators.keyed_file_collision(ctx({ keyed_files: KEYED })).ok, true, 'no other file has the key')

  // Someone else's migration with the same round key lands on the trunk AFTER the PR opened.
  const other = path.join(root, 'other')
  execFileSync('git', ['clone', '-q', origin, other])
  execFileSync('git', ['-C', other, 'checkout', '-q', trunk])
  execFileSync('sh', ['-c', `mkdir -p db/migrate && echo y > db/migrate/20261015120000_add_y.rb && git add -A && git -c user.email=o@example.com -c user.name=o commit -qm y && git push -q origin ${trunk}`], { cwd: other })

  const v = validators.keyed_file_collision(ctx({ keyed_files: KEYED }))
  assert.equal(v.ok, false, 'the base tip is fetched, not the stale local ref')
  assert.match(v.reasons[0], /20261015120000_add_x\.rb has the key 20261015120000, which db\/migrate\/20261015120000_add_y\.rb on origin\/.* already uses — generate a new key from the current clock/)

  repo.write('db/migrate/20261015120000_add_z.rb', 'z\n')
  assert.ok(validators.keyed_file_collision(ctx({ keyed_files: KEYED })).reasons.some(r => /in this change share the key/.test(r)))
})

test('profile: keyed_files entries need a glob and a key regex with a capture group', () => {
  assert.deepEqual(validateProfile({ commands: {}, keyed_files: KEYED }).errors, [])
  assert.match(validateProfile({ commands: {}, keyed_files: [{ glob: 'x', key: '^\\d+' }] }).errors[0], /capture group/)
  assert.match(validateProfile({ commands: {}, keyed_files: 'db/migrate' }).errors[0], /must be a list/)
})
