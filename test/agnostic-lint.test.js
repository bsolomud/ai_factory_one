import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { PACKAGE_ROOT } from './helpers.js'

// The global layer (state graph + stage runbooks) may reference capability
// slots ONLY. The moment it names a concrete tool, "repo-agnostic" starts
// rotting into "works on one repo" — this test is the plan's P0.9 lint.
const FORBIDDEN = /\b(rubocop|rspec|haml-lint|brakeman|eslint|stylelint|prettier|jest|vitest|mocha|pytest|flake8|mypy|phpunit|golangci|gofmt|cargo (test|clippy)|bundle exec|rake|yarn|npm (run|test)|pnpm|mvn|gradle)\b/i

test('pipeline.yml and stages/ name no concrete tools', () => {
  const files = [
    path.join(PACKAGE_ROOT, 'pipeline.yml'),
    ...fs.readdirSync(path.join(PACKAGE_ROOT, 'stages')).map(f => path.join(PACKAGE_ROOT, 'stages', f))
  ]
  const violations = []
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const match = line.match(FORBIDDEN)
      if (match) violations.push(`${path.relative(PACKAGE_ROOT, file)}:${i + 1} names '${match[0]}'`)
    })
  }
  assert.deepEqual(violations, [], `global layer must reference profile slots only:\n${violations.join('\n')}`)
})

test('every stage prompt referenced by pipeline.yml exists, and vice versa', () => {
  const yml = fs.readFileSync(path.join(PACKAGE_ROOT, 'pipeline.yml'), 'utf8')
  const referenced = [...yml.matchAll(/prompt: (stages\/[\w-]+\.md)/g)].map(m => m[1])
  for (const rel of referenced) {
    assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, rel)), `${rel} referenced but missing`)
  }
  const onDisk = fs.readdirSync(path.join(PACKAGE_ROOT, 'stages'))
  const nonStage = ['onboard.md', 'plan-critic.md'] // engine-level / critic prompts, not FSM stages
  for (const file of onDisk) {
    if (nonStage.includes(file)) continue
    assert.ok(referenced.includes(`stages/${file}`), `stages/${file} exists but no stage references it`)
  }
})

test('every stage output has a matching template with required frontmatter placeholders', () => {
  const yml = fs.readFileSync(path.join(PACKAGE_ROOT, 'pipeline.yml'), 'utf8')
  const outputs = [...yml.matchAll(/output: artifacts\/(\d+-[\w-]+\.md)/g)].map(m => m[1])
  assert.ok(outputs.length >= 8)
  for (const out of outputs) {
    const template = path.join(PACKAGE_ROOT, 'templates', out.replace(/^\d+-/, ''))
    assert.ok(fs.existsSync(template), `missing template for ${out}`)
    const content = fs.readFileSync(template, 'utf8')
    assert.match(content, /run: __RUN__/, `${template} missing __RUN__`)
    assert.match(content, /status: draft/, `${template} must start as draft`)
  }
})
