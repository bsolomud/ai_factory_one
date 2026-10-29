import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { humanPart } from '../src/artifacts.js'
import { HUMAN_CELL_WORDS, HUMAN_WORD_BUDGET, PIPELINE_VOCABULARY, validators } from '../src/validators.js'
import { newState } from '../src/state.js'
import { AC_POPULATION, AC_TABLE, HUMAN_DEFAULTS, PACKAGE_ROOT, completeArtifact, contextSections, sandbox, standardRepo, writeFile } from './helpers.js'

// Every artifact is two documents: the developer's half above '# Pipeline
// details' and the agents' half below it. These gates are what keeps the
// developer's half readable — three pilot plans ran to 3k+ words of prose
// before the first table with only a template asking for less.

function ctxFor({ root, repoDir, output = 'artifacts/01-context.md' }) {
  return {
    runDir: path.join(root, 'run'),
    repoDir,
    profile: {},
    state: newState({ runId: 'H-1', repo: 'r', stage: 'X' }),
    stageDef: { output },
    stageName: 'X',
    config: { stages: { CONTEXT: { output: 'artifacts/01-context.md' } } }
  }
}

const CONTEXT_HUMAN = ["What we're doing", 'Why', 'What changes', 'Acceptance criteria']

const words = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

test('humanPart: splits at the marker, strips template comments, and takes the whole body without one', () => {
  const body = '# T\n<!-- AC#9 in a comment is guidance, not content -->\n## Why\nplain\n\n# Pipeline details\n\n## Coupling\nrows\n'
  const split = humanPart(body)
  assert.equal(split.hasMarker, true)
  assert.match(split.human, /## Why\nplain/)
  assert.doesNotMatch(split.human, /AC#9|Coupling/)
  assert.match(split.pipeline, /## Coupling/)
  const whole = humanPart('## Title\nt\n## Description\nd\n')
  assert.equal(whole.hasMarker, false)
  assert.match(whole.human, /## Description/)
})

test('human_part: the developer sections must sit above the marker, filled', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'hp-sections')
  const ctx = ctxFor({ root, repoDir: repo.dir })

  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections())
  assert.equal(validators.human_part(ctx, CONTEXT_HUMAN).ok, true)

  // A required section written below the marker is the wrong half, not a pass.
  writeFile(ctx.runDir, 'artifacts/01-context.md', `---\nstatus: complete\n---\n\n## What we're doing\nx\n\n## What changes\n- y\n\n## Acceptance criteria\n${AC_TABLE}\n\n# Pipeline details\n\n## Why\nbelow\n\n## Requirements\nr\n`)
  const result = validators.human_part(ctx, CONTEXT_HUMAN)
  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /'## Why'.*below the '# Pipeline details' marker.*move it above/)

  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ Why: '' }))
  assert.match(validators.human_part(ctx, CONTEXT_HUMAN).reasons[0], /'## Why'.*empty.*plain words/)
})

test('human_part: the marker is required when agent sections exist, and not for an all-human artifact', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'hp-marker')
  const ctx = ctxFor({ root, repoDir: repo.dir })

  writeFile(ctx.runDir, 'artifacts/01-context.md', `---\nstatus: complete\n---\n\n## What we're doing\nx\n\n## Why\ny\n\n## What changes\n- z\n\n## Acceptance criteria\n${AC_TABLE}\n\n## Requirements\nr\n`)
  const result = validators.human_part(ctx, CONTEXT_HUMAN)
  assert.equal(result.ok, false)
  assert.match(result.reasons[0], /no '# Pipeline details' line/)

  // The PR draft is read by people end to end — every section is a developer
  // section, so there is nothing to put below a marker and none is demanded.
  const pr = ctxFor({ root, repoDir: repo.dir, output: 'artifacts/06-pr-draft.md' })
  completeArtifact(pr.runDir, 'artifacts/06-pr-draft.md', 'H-1', 'PR', { 'Questions for you': 'OK to push?' })
  assert.equal(fs.readFileSync(path.join(pr.runDir, 'artifacts/06-pr-draft.md'), 'utf8').includes('# Pipeline details'), false)
  assert.equal(validators.human_part(pr, Object.keys(HUMAN_DEFAULTS.PR)).ok, true)
})

test('human_part: the prose budget, the cell budget, and the bold budget are enforced', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'hp-budget')
  const ctx = ctxFor({ root, repoDir: repo.dir })

  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ Why: words(HUMAN_WORD_BUDGET + 1) }))
  let result = validators.human_part(ctx, CONTEXT_HUMAN)
  assert.match(result.reasons[0], new RegExp(`runs to \\d+ words of prose; the budget is ${HUMAN_WORD_BUDGET}`))

  // Tables, headings and a mermaid fence are not prose: a long diagram is free.
  const diagram = '```mermaid\nsequenceDiagram\n' + words(HUMAN_WORD_BUDGET).split(' ').map(w => `  A->>B: ${w}`).join('\n') + '\n```'
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ Why: `The cause.\n\n${diagram}` }))
  assert.equal(validators.human_part(ctx, CONTEXT_HUMAN).ok, true)

  const longRow = `| # | Now | After this ships | How to check |\n|---|---|---|---|\n| 1 | short | ${words(HUMAN_CELL_WORDS + 1)} | click |`
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ 'Acceptance criteria': longRow }))
  result = validators.human_part(ctx, CONTEXT_HUMAN)
  assert.match(result.reasons[0], new RegExp(`table cell.*keep cells under ${HUMAN_CELL_WORDS} words`))

  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ Why: '**one** and **two** and **three** things' }))
  result = validators.human_part(ctx, CONTEXT_HUMAN)
  assert.match(result.reasons[0], /more than two bold spans/)

  // The agents' half is not budgeted: a 2k-word Approach below the marker passes.
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ Findings: words(2000) }))
  assert.equal(validators.human_part(ctx, CONTEXT_HUMAN).ok, true)
})

test('plain_language: pipeline vocabulary above the marker blocks with the line; below it, and in diagrams, it is free', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'hp-vocab')
  const ctx = ctxFor({ root, repoDir: repo.dir })

  for (const sample of ['see AC#3 for the rest', 'population: both', 'the critic said so', 'this is blocking', 'TL;DR it works', 'at the PLAN stage', 'a subtask lands', 'Needs you: approve', 'the § 2 argument']) {
    completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ Why: sample }))
    const result = validators.plain_language(ctx)
    assert.equal(result.ok, false, `expected '${sample}' to be refused`)
    assert.match(result.reasons[0], /uses pipeline vocabulary '.*'.*rewrite it for a developer/)
  }

  // Ordinary English that merely contains a vocabulary word as a substring passes.
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ Why: 'The staging server gates nothing; the advisor emails a plan.' }))
  const near = validators.plain_language(ctx)
  assert.equal(near.ok, false, "'gates' is the vocabulary word — the sentence is refused for it")
  assert.match(near.reasons[0], /'gate'/)
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({ Why: 'The staging server checks nothing; the advisor emails a plan.' }))
  assert.equal(validators.plain_language(ctx).ok, true)

  // The whole agents' half is exempt, and so is a fenced diagram above the marker.
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections({
    Why: 'Plain.\n\n```mermaid\nflowchart\n  A[critic] --> B[AC#1]\n```',
    Findings: 'AC#1 is blocking; the critic disposition covers the population.'
  }))
  assert.equal(validators.plain_language(ctx).ok, true)
  assert.ok(PIPELINE_VOCABULARY.length > 20)
})

test('templates: every artifact template splits at the marker and its guidance passes both gates once stripped', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'hp-templates')
  const dir = path.join(PACKAGE_ROOT, 'templates')
  const artifactTemplates = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'knowledge-fact.md')
  assert.ok(artifactTemplates.length >= 9)
  for (const file of artifactTemplates) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8')
    const isPrDraft = file === 'pr-draft.md'
    assert.equal(/^# Pipeline details\s*$/m.test(text), !isPrDraft, `${file}: marker presence`)
    // Template comments carry vocabulary on purpose (they explain the gates);
    // the rendered content must not — so an untouched template is silent.
    const ctx = ctxFor({ root, repoDir: repo.dir, output: `artifacts/${file}` })
    writeFile(ctx.runDir, `artifacts/${file}`, text.replace('status: draft', 'status: complete'))
    assert.equal(validators.plain_language(ctx).ok, true, `${file}: template guidance leaks vocabulary`)
    // An untouched template has empty sections (that is the sections gate's
    // job); what must hold here is the marker and the budgets.
    if (isPrDraft) continue
    const budget = validators.human_part(ctx, [])
    assert.equal(budget.ok, true, `${file}: ${budget.reasons?.join(' | ')}`)
  }
})

test('ac_population reads the criterion numbers from the developer table and the answers from the agents table', () => {
  const { root } = sandbox()
  const repo = standardRepo(root, 'hp-pop')
  const ctx = ctxFor({ root, repoDir: repo.dir })
  completeArtifact(ctx.runDir, 'artifacts/01-context.md', 'H-1', 'CONTEXT', contextSections())
  const text = fs.readFileSync(path.join(ctx.runDir, 'artifacts/01-context.md'), 'utf8')
  const { human, pipeline } = humanPart(text)
  assert.ok(human.includes(AC_TABLE) && !human.includes('Population'), 'the developer half carries no population column')
  assert.ok(pipeline.includes(AC_POPULATION))
  assert.equal(validators.ac_population(ctx).ok, true)
})
