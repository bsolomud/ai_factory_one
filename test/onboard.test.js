import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { hashPath, scanAssets } from '../src/scan.js'
import { cli, installProfile, sandbox, standardRepo, writeFile } from './helpers.js'

function repoWithAssets(root) {
  const repo = standardRepo(root, 'onb-repo')
  repo.write('.claude/skills/code-review/SKILL.md', '# repo review skill\nrules...\n')
  repo.write('.ai/skills/testing/SKILL.md', '# repo testing skill\n')
  repo.write('.claude/commands/deploy.md', '# deploy command\n')
  repo.write('CLAUDE.md', '# agent docs\n')
  repo.write('doc/ai/product-map.md', '# knowledge\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'assets')
  return repo
}

test('scanAssets finds repo skills, commands, agent docs, knowledge dirs', () => {
  const { root } = sandbox()
  const repo = repoWithAssets(root)
  const found = scanAssets(repo.dir)
  assert.deepEqual(found.skills.map(s => s.path), ['.ai/skills/testing', '.claude/skills/code-review'])
  assert.equal(found.skills[1].entry, 'SKILL.md')
  assert.deepEqual(found.commands.map(c => c.name), ['deploy'])
  assert.deepEqual(found.agent_docs.map(d => d.path), ['CLAUDE.md'])
  assert.deepEqual(found.knowledge_dirs.map(d => d.path), ['doc/ai'])
})

test('hashPath: stable for files and directories, changes on edit, null when missing', () => {
  const { root } = sandbox()
  const repo = repoWithAssets(root)
  const dir = path.join(repo.dir, '.claude/skills/code-review')
  const first = hashPath(dir)
  assert.equal(hashPath(dir), first, 'deterministic')
  assert.match(first, /^sha256:/)
  repo.write('.claude/skills/code-review/extra.md', 'new rule\n')
  assert.notEqual(hashPath(dir), first, 'directory hash tracks content')
  assert.equal(hashPath(path.join(repo.dir, 'nope')), null)
})

test('onboard command: first run vs re-onboarding, registers the repo', () => {
  const { root, home } = sandbox()
  const repo = repoWithAssets(root)

  const first = cli(['onboard', repo.dir], { home, cwd: root })
  assert.equal(first.verdict, 'ONBOARD')
  assert.equal(first.reonboarding, false)
  assert.equal(first.existing_profile, null)
  assert.equal(first.candidates.skills.length, 2)
  assert.ok(first.runbook.endsWith('stages/onboard.md'))
  assert.ok(first.profile_path.includes('onb-repo'))

  // Registered for any-folder use even before a profile exists.
  const repos = cli(['repos'], { home, cwd: root })
  assert.equal(repos.repos.length, 1)
  assert.equal(repos.repos[0].has_profile, false)

  installProfile(home, 'example.com-test-onb-repo', 'commands: {}\nno_touch: []\n')
  const again = cli(['onboard'], { home, cwd: repo.dir })
  assert.equal(again.reonboarding, true)
  assert.ok(again.existing_profile, 're-onboarding gets the current profile for prefill')
  assert.match(again.next_action, /never silently drop/i)
})

test('editing a bound repo skill triggers PROFILE_STALE naming the binding', () => {
  const { root, home } = sandbox()
  const repo = repoWithAssets(root)
  const sha = hashPath(path.join(repo.dir, '.claude/skills/code-review'))
  installProfile(home, 'example.com-test-onb-repo', `
commands: {}
no_touch: []
bindings:
  review: { source: repo, path: .claude/skills/code-review, sha: "${sha}" }
  plan:   { source: builtin }
`)
  assert.equal(cli(['status'], { home, cwd: repo.dir }).verdict, 'NO_ACTIVE_RUN', 'fresh hash → not stale')

  repo.write('.claude/skills/code-review/SKILL.md', '# repo review skill\nrules CHANGED\n')
  const stale = cli(['status'], { home, cwd: repo.dir })
  assert.equal(stale.verdict, 'PROFILE_STALE')
  assert.match(stale.changed_evidence.join(' '), /binding:review/)

  // hash command gives the model the new sha to re-record after re-confirmation
  const rehash = cli(['hash', '.claude/skills/code-review'], { home, cwd: repo.dir })
  assert.match(rehash.hashes['.claude/skills/code-review'], /^sha256:/)
})
