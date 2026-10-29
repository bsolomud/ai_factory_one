import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { codeGraph } from '../src/codegraph.js'
import { sandbox, standardRepo } from './helpers.js'

// Every research agent worked in a run worktree while the graph indexed the
// main checkout; "is this repo indexed?" read as no, and the graph went unused.
// The CLI names the project, the snapshot, and how far the tree has moved.

function shim(root, projects) {
  const bin = path.join(root, 'cbm-shim')
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ projects }))
  fs.writeFileSync(bin, `#!/bin/sh\necho 'level=info msg=noise' >&2\ncat '${path.join(root, 'projects.json')}'\n`, { mode: 0o755 })
  return bin
}

test('codeGraph: a worktree is told the main checkout\'s index is its repo, with the drift', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'cg-repo')
  const sha = repo.git('rev-parse', 'HEAD').trim()
  const wt = path.join(root, 'wt')
  repo.git('worktree', 'add', '-q', '--detach', wt, 'HEAD')
  fs.writeFileSync(path.join(wt, 'src/app.sh'), 'echo app-v2\n')

  process.env.CBM_BIN = shim(root, [
    { name: 'other', root_path: path.join(root, 'elsewhere'), git: { head_sha: sha } },
    { name: 'cg', root_path: repo.dir, git: { canonical_root: repo.dir, branch: 'master', head_sha: sha } }
  ])
  const g = codeGraph(wt)
  assert.equal(g.project, 'cg')
  assert.equal(g.scope, 'main-checkout')
  assert.equal(g.drift_files, 1, 'the run\'s own change is where the snapshot is wrong')
  assert.match(g.line, /project=cg — THIS repo, indexed from the main checkout .* at master@/)
  assert.match(g.line, /1 file\(s\) differ .*git -C .*diff --name-only/)

  // An index of the run's own tree wins.
  process.env.CBM_BIN = shim(root, [
    { name: 'cg', root_path: repo.dir, git: { head_sha: sha } },
    { name: 'cg-wt', root_path: wt, git: { head_sha: sha, branch: 'x' } }
  ])
  assert.equal(codeGraph(wt).project, 'cg-wt')
  assert.equal(codeGraph(wt).scope, 'tree')

  // Not indexed, no binary, broken output → null, silently.
  process.env.CBM_BIN = shim(root, [{ name: 'other', root_path: path.join(root, 'elsewhere') }])
  assert.equal(codeGraph(wt), null)
  process.env.CBM_BIN = path.join(root, 'missing-bin')
  assert.equal(codeGraph(wt), null)
  fs.writeFileSync(path.join(root, 'broken'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
  process.env.CBM_BIN = path.join(root, 'broken')
  assert.equal(codeGraph(wt), null)
  delete process.env.CBM_BIN
})
