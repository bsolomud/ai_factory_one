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

function uninstall(env, ...args) {
  return execFileSync('bash', [path.join(PACKAGE_ROOT, 'adapters/claude-code/uninstall.sh'), ...args], {
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

  install({ AI_FACTORY_HOME: home, CLAUDE_HOME: claude })

  for (const rel of ['pipeline.yml', 'stages/context.md', 'templates/plan.md', 'bin/pipeline', 'bin/guard', 'VERSION']) {
    assert.ok(fs.existsSync(path.join(home, rel)), `missing ${rel} in pipeline home`)
  }
  assert.ok(fs.existsSync(path.join(claude, 'skills/pipeline/SKILL.md')), 'skill linked')
  for (const agent of ['onboarder', 'context', 'planner', 'architect', 'critic', 'implementer', 'qa', 'reviewer', 'stage-runner']) {
    assert.ok(fs.existsSync(path.join(claude, `agents/pipeline-${agent}.md`)), `${agent} agent linked`)
  }
  const skill = fs.readFileSync(path.join(claude, 'skills/pipeline/SKILL.md'), 'utf8')
  for (const cmd of ['/pipeline start', '/pipeline work', '/pipeline status']) {
    assert.ok(skill.includes(cmd), `SKILL.md documents ${cmd}`)
  }

  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  assert.equal(settings.model, 'opus', 'unrelated settings preserved')
  const commands = settings.hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command))
  assert.ok(commands.includes('my-existing-hook'), 'existing hook preserved')
  assert.ok(commands.some(c => c.endsWith('guard bash')), 'bash guard merged')
  assert.ok(commands.some(c => c.endsWith('guard write')), 'write guard merged')

  // Permissions pre-approved so /pipeline never prompts for its own CLI/home.
  const allow = settings.permissions.allow
  assert.ok(allow.includes('Bash(~/.ai_factory_one/bin/pipeline:*)'), 'pipeline CLI (~) allowed')
  assert.ok(allow.some(r => r.startsWith(`Bash(${home}/bin/pipeline`)), 'pipeline CLI (abs) allowed')
  assert.ok(allow.includes('Read(~/.ai_factory_one/**)'), 'pipeline home reads allowed')
  assert.ok(settings.permissions.additionalDirectories.includes('~/.ai_factory_one'), 'home in additionalDirectories')

  // Idempotent: re-running must not duplicate hooks OR permission rules.
  install({ AI_FACTORY_HOME: home, CLAUDE_HOME: claude })
  const again = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  assert.equal(again.hooks.PreToolUse.length, settings.hooks.PreToolUse.length, 'no duplicate hooks on re-run')
  assert.equal(again.permissions.allow.length, allow.length, 'no duplicate permission rules on re-run')

  // The installed executable answers status (NO_PROFILE for a fresh repo).
  const repoDir = path.join(root, 'fresh-repo')
  fs.mkdirSync(repoDir)
  execFileSync('git', ['init', '-q', repoDir])
  const out = execFileSync(path.join(home, 'bin/pipeline'), ['status'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, AI_FACTORY_HOME: home }
  })
  assert.equal(JSON.parse(out).verdict, 'NO_PROFILE')
})

test('uninstall.sh: reverses install, keeps user work by default, purges on --purge', () => {
  const { root } = sandbox()
  const home = path.join(root, 'pipeline-home')
  const claude = path.join(root, 'claude-home')
  const env = { AI_FACTORY_HOME: home, CLAUDE_HOME: claude }

  // Pre-existing settings + a real (non-symlink) user agent that must survive.
  fs.mkdirSync(path.join(claude, 'agents'), { recursive: true })
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({
    model: 'opus',
    permissions: { allow: ['Bash(git status:*)', 'Bash(echo:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-existing-hook' }] }] }
  }))
  fs.writeFileSync(path.join(claude, 'agents/pipeline-custom-of-mine.md'), '# user-authored, not ours\n')

  install(env)
  // Simulate user work accumulated under repos/.
  const workFile = path.join(home, 'repos', 'example.com-x', 'profile.yml')
  fs.mkdirSync(path.dirname(workFile), { recursive: true })
  fs.writeFileSync(workFile, 'commands: {}\n')

  // --- default uninstall: framework gone, work + unrelated settings kept ---
  uninstall(env)

  assert.ok(!fs.existsSync(path.join(claude, 'skills/pipeline')), 'skill symlink removed')
  for (const agent of ['onboarder', 'planner', 'stage-runner', 'reviewer']) {
    assert.ok(!fs.existsSync(path.join(claude, `agents/pipeline-${agent}.md`)), `${agent} agent removed`)
  }
  assert.ok(fs.existsSync(path.join(claude, 'agents/pipeline-custom-of-mine.md')), 'user-authored agent (real file) preserved')

  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'))
  assert.equal(settings.model, 'opus', 'unrelated settings preserved')
  const commands = (settings.hooks?.PreToolUse || []).flatMap(e => e.hooks.map(h => h.command))
  assert.ok(commands.includes('my-existing-hook'), 'user hook preserved')
  assert.ok(!commands.some(c => /guard (bash|write)$/.test(c)), 'our guard hooks removed')

  // Our ai_factory_one permission rules removed; the user's own rules survive.
  const allow = settings.permissions?.allow || []
  assert.ok(!allow.some(r => /ai_factory_one/.test(r)), 'our permission rules removed')
  assert.ok(allow.includes('Bash(git status:*)'), 'user permission rule preserved')
  assert.ok(allow.includes('Bash(echo:*)'), "generic echo rule left alone (may be the user's)")
  assert.ok(!settings.permissions?.additionalDirectories?.some(d => /ai_factory_one/.test(d)), 'our additionalDirectories removed')

  assert.ok(!fs.existsSync(path.join(home, 'bin')), 'framework bin removed')
  assert.ok(!fs.existsSync(path.join(home, 'pipeline.yml')), 'pipeline.yml removed')
  assert.ok(fs.existsSync(workFile), 'user work under repos/ preserved by default')

  // --- reinstall then --purge: nothing left ---
  install(env)
  uninstall(env, '--purge')
  assert.ok(!fs.existsSync(home), 'purge removes the entire pipeline home')

  // Idempotent: uninstall again is a no-op, not an error.
  uninstall(env)
  uninstall(env, '--purge')
})
