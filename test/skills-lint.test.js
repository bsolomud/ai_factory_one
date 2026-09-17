import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { PACKAGE_ROOT } from './helpers.js'

// The adapter's skills land in the user-global ~/.claude/skills, so every one
// must carry frontmatter that names it and forbids proactive invocation, and
// the prose links between runbooks/agents and skills must not rot.

const SKILLS_DIR = path.join(PACKAGE_ROOT, 'adapters/claude-code/skills')

function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(match, `${file} has YAML frontmatter`)
  return match[1]
}

test('every adapter skill has name + anti-proactive description frontmatter', () => {
  const dirs = fs.readdirSync(SKILLS_DIR).filter(d =>
    fs.statSync(path.join(SKILLS_DIR, d)).isDirectory())
  assert.ok(dirs.length >= 4, 'expected at least the four shipped skills')
  for (const dir of dirs) {
    const skillFile = path.join(SKILLS_DIR, dir, 'SKILL.md')
    assert.ok(fs.existsSync(skillFile), `${dir}/SKILL.md exists`)
    const fm = frontmatter(skillFile)
    assert.match(fm, new RegExp(`^name: ${dir}$`, 'm'), `${dir}: frontmatter name matches directory`)
    assert.match(fm, /^description: .+/m, `${dir}: has a description`)
    const desc = fm.match(/^description: (.*(?:\n .*)*)/m)[0]
    assert.match(desc, /never/i, `${dir}: description forbids ("never") some invocation`)
    assert.match(desc, /proactiv/i, `${dir}: description forbids proactive invocation`)
  }
})

test('runbook and agent wiring to the skills does not rot', () => {
  const read = rel => fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8')

  // gate-triage: triggered from IMPLEMENT and TEST runbooks + three agents.
  assert.match(read('stages/implement.md'), /gate-triage/, 'implement runbook names gate-triage')
  assert.match(read('stages/test.md'), /gate-triage/, 'test runbook names gate-triage')
  for (const agent of ['pipeline-implementer', 'pipeline-qa', 'pipeline-reviewer']) {
    const text = read(`adapters/claude-code/agents/${agent}.md`)
    assert.match(text, /gate-triage/, `${agent} names gate-triage`)
    assert.match(text, /^tools: .*\bSkill\b/m, `${agent} grants the Skill tool`)
  }

  // ci-triage: the CI runbook consumes the `ci` binding, built-in = the skill.
  const ci = read('stages/ci.md')
  assert.match(ci, /`ci` binding/, 'ci runbook consumes the ci binding')
  assert.match(ci, /ci-triage/, 'ci runbook names the ci-triage built-in')
  assert.match(ci, /pipeline used skill/, 'ci runbook records bound-skill usage')
  const runner = read('adapters/claude-code/agents/pipeline-stage-runner.md')
  assert.match(runner, /^tools: .*\bSkill\b/m, 'stage-runner grants the Skill tool')
  assert.match(runner, /capability binding/, 'stage-runner explains binding consumption')

  // knowledge-harvest: dispatcher command + SCRIBE verifies drafts.
  const dispatcher = read('adapters/claude-code/skills/pipeline/SKILL.md')
  assert.match(dispatcher, /argument-hint: .*harvest/, 'dispatcher argument-hint offers harvest')
  assert.match(dispatcher, /## `\/pipeline harvest/, 'dispatcher documents /pipeline harvest')
  assert.match(read('stages/scribe.md'), /knowledge-harvest/, 'scribe runbook verifies harvest drafts')

  // change-probes: builds the Coupling table, so the two runbooks that own that
  // section and the two agents that write it must all name it.
  for (const rel of ['stages/plan.md', 'stages/review.md']) {
    assert.match(read(rel), /change-probes/, `${rel} names change-probes`)
    assert.match(read(rel), /## Coupling|`## Coupling`/, `${rel} owns the Coupling section`)
  }
  for (const agent of ['pipeline-planner', 'pipeline-reviewer']) {
    const text = read(`adapters/claude-code/agents/${agent}.md`)
    assert.match(text, /change-probes/, `${agent} names change-probes`)
    assert.match(text, /^tools: .*\bSkill\b/m, `${agent} grants the Skill tool`)
  }

  // onboard: names the ci-triage built-in and has the re-sync flow the CLI cites.
  const onboard = read('stages/onboard.md')
  assert.match(onboard, /ci-triage/, 'onboard names the ci built-in')
  assert.match(onboard, /## Re-sync flow/, 'onboard has the re-sync flow section cited by the CLI')
})
