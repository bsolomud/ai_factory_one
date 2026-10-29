import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ndaCheck } from '../src/nda.js'
import { cli, installProfile, PACKAGE_ROOT, sandbox, standardRepo, STANDARD_PROFILE, writeFile } from './helpers.js'

// The pipeline is a universal tool; the projects it runs on are under NDA.
// What it learns from a project's reviews may improve the tool, in words that
// carry nothing of the project.

function onboarded(name) {
  const { root, home } = sandbox()
  const repo = standardRepo(root, name)
  const slug = `example.com-test-${name}`
  installProfile(home, slug, STANDARD_PROFILE)
  const run = (args, env) => cli(args, { home, cwd: repo.dir, env })
  run(['new-run', 'R-1'])
  return { root, home, repo, slug, run, runDir: path.join(home, 'repos', slug, 'runs', 'R-1') }
}

test('nda-check strict: the tool may be named, the project may not', () => {
  const { home, repo } = onboarded('nda-repo')
  writeFile(repo.dir, 'src/zorblax_ledger.sh', 'frobnicate_widget() { echo Quuxifier; }\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'domain code')
  const prev = process.env.AI_FACTORY_HOME
  process.env.AI_FACTORY_HOME = home
  try {
    const clean = [
      '### 1. Prove a fix against its input class',
      '- Component: stages/review.md, agent pipeline-reviewer, validator review_converged',
      '- What happens now: the fix guarded one malformed input; the reviewer then sent two more of its kind.'
    ].join('\n')
    assert.deepEqual(ndaCheck(clean, { terms: [] }), [], 'generic words and the tool\'s own names pass')

    const rules = text => ndaCheck(text, { terms: ['acme'] }).map(v => `${v.rule}:${v.match}`)
    assert.deepEqual(rules('the frobnicate_widget call and the Quuxifier'), ['project-word:frobnicate_widget', 'project-word:Quuxifier'],
      'an identifier or uncommon word from the project\'s code is caught')
    // Built from parts, so this file passes the check it tests.
    const [ticket, pr, mail] = ['PRJ' + '-4711', '#' + '1234', 'jo' + '@corp.io']
    assert.deepEqual(rules(`see ${ticket} and ${pr} by ${mail}`), [`ticket:${ticket}`, `pr:${pr}`, `email:${mail}`])
    assert.deepEqual(rules('in src/zorblax_ledger.sh'), ['path:src/zorblax_ledger.sh', 'project-word:zorblax_ledger'])
    assert.deepEqual(rules('the acme team'), ['term:acme'], 'org, repo and people names')
    assert.deepEqual(rules('```\nx = 1\n```'), ['code:```', 'code:```'])
    assert.deepEqual(rules('UTF-8 and SHA-256 are standards'), [])
    assert.deepEqual(ndaCheck('the acme team', { mode: 'self', terms: ['acme'] }).map(v => v.rule), ['term'])
  } finally {
    if (prev === undefined) delete process.env.AI_FACTORY_HOME; else process.env.AI_FACTORY_HOME = prev
  }
})

// The committed half of the line: the tool's own files carry no ticket, PR
// number or address. Project names live only in the local terms file, so this
// test cannot list them; `pipeline nda-check --self` on a machine with the
// projects onboarded checks those too.
test('the pipeline\'s own files carry no ticket ids, PR numbers or addresses', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    .split('\n').filter(f => f && !/package-lock\.json$|^dist\//.test(f))
  const found = []
  for (const f of files) {
    const abs = path.join(PACKAGE_ROOT, f)
    if (!fs.existsSync(abs)) continue
    for (const v of ndaCheck(fs.readFileSync(abs, 'utf8'), { mode: 'self', terms: [] })) found.push(`${f}:${v.line} ${v.rule} ${v.match}`)
  }
  assert.deepEqual(found, [], `project detail in the tool:\n${found.join('\n')}`)
})

// A fake `gh` answering the three questions collect asks.
function gh(root, pr) {
  fs.writeFileSync(path.join(root, 'gql.json'), JSON.stringify({ data: { repository: { pullRequest: pr } } }))
  const bin = path.join(root, 'gh-shim')
  fs.writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"acme/app"}';;
  "api graphql") cat '${root}/gql.json';;
  "pr list") echo '[]';;
  *) exit 2;;
esac
`, { mode: 0o755 })
  return { PIPELINE_GH: bin }
}

test('retro: collects reviewer comments on closed run PRs, privately; finish waits for clean proposals', () => {
  const { root, home, run } = onboarded('retro-repo')
  const env = gh(root, {
    number: 77, url: 'https://example.com/acme/app/pull/77', title: 't', state: 'MERGED', mergedAt: '2026-10-20T10:00:00Z', closedAt: '2026-10-20T10:00:00Z',
    author: { login: 'dev1' },
    reviewThreads: { nodes: [
      { path: 'src/app.sh', line: 3, isResolved: true, isOutdated: false, comments: { nodes: [
        { author: { login: 'reviewer1', __typename: 'User' }, body: 'an empty value still crashes this', createdAt: '2026-10-19T10:00:00Z' },
        { author: { login: 'dev1', __typename: 'User' }, body: 'fixed', createdAt: '2026-10-19T11:00:00Z' }] } },
      { path: 'src/app.sh', line: 9, isResolved: true, isOutdated: false, comments: { nodes: [
        { author: { login: 'dev1', __typename: 'User' }, body: 'note to self', createdAt: '2026-10-19T09:00:00Z' }] } }
    ] },
    reviews: { nodes: [
      { author: { login: 'reviewer1', __typename: 'User' }, state: 'CHANGES_REQUESTED', body: 'one blocker inline', submittedAt: '2026-10-19T10:01:00Z' },
      { author: { login: 'reviewer1', __typename: 'User' }, state: 'APPROVED', body: '', submittedAt: '2026-10-20T09:00:00Z' }
    ] },
    comments: { nodes: [{ author: { login: 'ci-helper[bot]', __typename: 'Bot' }, body: 'coverage 80%', createdAt: '2026-10-19T08:00:00Z' }] }
  })
  assert.equal(run(['retro', 'collect'], env).verdict, 'NOTHING_NEW', 'a run with no PR has nothing to say')

  run(['round', 'open', 'pre-pr'])
  run(['finding', '--class', 'correctness', '--missed-by', 'none', '--summary', 'a nil value crashes'])
  run(['round', 'close'])
  run(['pr-opened', 'https://example.com/acme/app/pull/77'])
  const c = run(['retro', 'collect'], env)
  assert.equal(c.verdict, 'OK')
  assert.deepEqual(c.prs, [{ slug: 'example.com-test-retro-repo', run: 'R-1', pr: 77, comments: 3, pre_pr_findings: 1 }],
    'the author\'s own notes and empty approvals are not feedback; the bot is kept and marked')
  const batch = JSON.parse(fs.readFileSync(c.batch_file, 'utf8'))
  const ext = batch.items[0].external
  assert.deepEqual(ext.map(e => e.kind), ['comment', 'thread', 'review'])
  assert.equal(ext[0].bot, true)
  assert.equal(ext[1].replies[0].by_author, true)
  assert.ok(c.batch_file.startsWith(path.join(home, 'retro', 'batches')), 'evidence stays in the pipeline home')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'retro', 'people.json'), 'utf8')), ['ci-helper[bot]', 'dev1', 'reviewer1'],
    'everyone seen becomes a name the proposals may not carry')

  const proposals = path.join(home, 'retro', 'proposals.md')
  fs.writeFileSync(proposals, '# Pipeline proposals from review retros\n\n## 2026-10-29 · 1 PRs\n\n### 1. Ask reviewer1 first\n')
  const blocked = run(['retro', 'finish', c.batch])
  assert.equal(blocked.verdict, 'BLOCKED')
  assert.equal(blocked.violations[0].match, 'reviewer1')
  fs.writeFileSync(proposals, '# Pipeline proposals from review retros\n\n## 2026-10-29 · 1 PRs\n\n### 1. Prove a fix against empty and missing input alike\n')
  assert.equal(run(['retro', 'finish', c.batch]).recorded, 1)
  assert.equal(run(['retro', 'list']).prs_looked_at, 1)
  assert.equal(run(['retro', 'collect'], env).verdict, 'NOTHING_NEW', 'a PR is looked at once')
  assert.equal(run(['retro', 'collect', '--again'], env).prs.length, 1)
})
