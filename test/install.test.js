import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { PACKAGE_ROOT, sandbox } from './helpers.js'

function install(env) {
  return execFileSync('bash', [path.join(PACKAGE_ROOT, 'adapters/claude-code/install.sh')], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

test('install.sh: sandbox layout, hook merge, idempotence', () => {
  const { root } = sandbox()
  const home = path.join(root, 'pipeline-home')
  const claude = path.join(root, 'claude-home')

  // Pre-existing user settings with their own hook — must survive the merge.
  fs.mkdirSync(claude, { recursive: true })
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({
    model: 'opus',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-existing-hook' }] }] }
  }))

  install({ AI_PIPELINE_HOME: home, CLAUDE_HOME: claude })

  for (const rel of ['pipeline.yml', 'stages/context.md', 'templates/plan.md', 'bin/pipeline', 'bin/guard', 'VERSION']) {
    assert.ok(fs.existsSync(path.join(home, rel)), `missing ${rel} in pipeline home`)
  }
  assert.ok(fs.existsSync(path.join(claude, 'skills/pipeline/SKILL.md')), 'skill linked')
  assert.ok(fs.existsSync(path.join(claude, 'agents/pipeline-critic.md')), 'critic agent linked')
  assert.ok(fs.existsSync(path.join(claude, 'agents/pipeline-reviewer.md')), 'reviewer agent linked')

  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  assert.equal(settings.model, 'opus', 'unrelated settings preserved')
  const commands = settings.hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command))
  assert.ok(commands.includes('my-existing-hook'), 'existing hook preserved')
  assert.ok(commands.some(c => c.endsWith('guard bash')), 'bash guard merged')
  assert.ok(commands.some(c => c.endsWith('guard write')), 'write guard merged')

  // Idempotent: re-running must not duplicate hooks.
  install({ AI_PIPELINE_HOME: home, CLAUDE_HOME: claude })
  const again = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  assert.equal(again.hooks.PreToolUse.length, settings.hooks.PreToolUse.length, 'no duplicates on re-run')

  // The installed executable answers status (NO_PROFILE for a fresh repo).
  const repoDir = path.join(root, 'fresh-repo')
  fs.mkdirSync(repoDir)
  execFileSync('git', ['init', '-q', repoDir])
  const out = execFileSync(path.join(home, 'bin/pipeline'), ['status'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, AI_PIPELINE_HOME: home }
  })
  assert.equal(JSON.parse(out).verdict, 'NO_PROFILE')
})
