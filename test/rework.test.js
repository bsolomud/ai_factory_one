import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { guard } from '../src/guard.js'
import { unrecordedRework } from '../src/retro.js'
import { appendEvent, newState, readState, writeState } from '../src/state.js'
import { validators } from '../src/validators.js'
import { cli, installProfile, sandbox, standardRepo, STANDARD_PROFILE } from './helpers.js'

// Two pilot PRs took every review fix after their run had closed, in plain
// sessions: no round, none of the feedback procedure's rigor, and that is
// where their later findings came from.

const at = h => new Date(Date.UTC(2026, 9, 10, h)).toISOString()

test('unrecordedRework: commits after the run passed CI, outside every feedback window', () => {
  const events = [
    { event: 'pr_opened', at: at(1) },
    { event: 'advanced', from: 'CI', to: 'SCRIBE', at: at(2) },
    { event: 'advanced', from: 'SCRIBE', to: 'DONE', at: at(3) },
    { event: 'round_opened', n: 1, source: 'pr', at: at(10) },
    { event: 'round_closed', n: 1, at: at(10) },
    { event: 'advanced', from: 'SCRIBE', to: 'DONE', at: at(14) }
  ]
  const commits = [
    { oid: 'a', at: at(1) },   // during the run: CI's own work
    { oid: 'b', at: at(5) },   // after DONE, no round: unrecorded
    { oid: 'c', at: at(12) },  // inside the round's window (triage → reopened run → DONE)
    { oid: 'd', at: at(16) }   // after it closed again: unrecorded
  ]
  assert.deepEqual(unrecordedRework(events, commits).map(c => c.oid), ['b', 'd'])
  assert.deepEqual(unrecordedRework(events.filter(e => e.from !== 'CI'), commits), [], 'a run still before its CI gate owns its commits')
})

function closedRun() {
  const { root, home } = sandbox()
  process.env.AI_FACTORY_HOME = home
  const repo = standardRepo(root, 'rw-repo')
  const slug = 'example.com-test-rw-repo'
  installProfile(home, slug, STANDARD_PROFILE)
  const branch = execFileSync('git', ['-C', repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  const runDir = path.join(home, 'repos', slug, 'runs', 'T-7')
  const state = newState({ runId: 'T-7', repo: slug, stage: 'DONE', branch })
  state.git.branch = branch
  writeState(runDir, state)
  return { root, home, repo, slug, runDir }
}

test('guard: a commit on a closed run\'s branch with its PR open is advised to open a feedback round — never blocked', () => {
  const { repo, runDir } = closedRun()
  const bash = command => guard('bash', { cwd: repo.dir, session_id: 'plain-session', tool_input: { command } })
  assert.equal(bash('git commit -m fix').context, undefined, 'no PR recorded: nothing to say')

  appendEvent(runDir, { event: 'pr_opened', number: 77, url: 'https://example.com/acme/app/pull/77', head: 'x' })
  const r = bash('git commit -m "address review"')
  assert.equal(r.decision, 'allow')
  assert.match(r.context, /run T-7.*PR #77.*pipeline round open pr .*--run T-7/)
  assert.equal(bash('git status').context, undefined, 'only commits and pushes')
  assert.equal(bash('grep -rn "git commit" docs').context, undefined, 'text that mentions git is not a git call')

  appendEvent(runDir, { event: 'round_opened', n: 1, source: 'pr' })
  assert.equal(bash('git push').context, undefined, 'a feedback round is open: the procedure is already engaged')
})

test('pr_body_current: a feedback round that moved the code needs the PR body re-published', () => {
  const { repo, runDir } = closedRun()
  const head = () => execFileSync('git', ['-C', repo.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const ctx = { runDir, repoDir: repo.dir, profile: {}, state: readState(runDir), stageDef: {}, stageName: 'CI', config: {} }
  appendEvent(runDir, { event: 'pr_opened', number: 77, url: 'u', head: head() })
  appendEvent(runDir, { event: 'round_opened', n: 1, source: 'pr' })
  assert.equal(validators.pr_body_current(ctx).ok, true, 'a round that changed nothing leaves the body true')

  repo.write('src/app.sh', 'echo reworked\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'review fix')
  const v = validators.pr_body_current(ctx)
  assert.equal(v.ok, false)
  assert.match(v.reasons[0], /QA re-check list.*gh pr edit 77.*pipeline pr-opened u/)

  appendEvent(runDir, { event: 'pr_opened', number: 77, url: 'u', head: head() })
  assert.equal(validators.pr_body_current(ctx).ok, true, 're-published after the rework')
})

test('doctor: lists a closed run whose open PR moved with no feedback round', () => {
  const { root, home, repo, runDir } = closedRun()
  const t = h => new Date(Date.now() - (48 - h) * 3600e3).toISOString()
  appendEvent(runDir, { event: 'pr_opened', number: 77, url: 'u', head: 'x' })
  fs.appendFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify({ event: 'advanced', from: 'CI', to: 'SCRIBE', at: t(1) }) + '\n')
  fs.writeFileSync(path.join(root, 'pr.json'), JSON.stringify({ state: 'OPEN', url: 'https://example.com/acme/app/pull/77', commits: [
    { oid: 'aaa', committedDate: t(0) }, { oid: 'bbb', committedDate: t(5) }, { oid: 'ccc', committedDate: t(6) }] }))
  const bin = path.join(root, 'gh-shim')
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "pr view" ] && cat '${root}/pr.json' || exit 2\n`, { mode: 0o755 })
  const d = cli(['doctor'], { home, cwd: repo.dir, env: { PIPELINE_GH: bin } })
  assert.equal(d.verdict, 'OK', 'advice, not an error')
  assert.deepEqual(d.pr_rework.map(r => [r.run, r.pr, r.commits]), [['T-7', 77, 2]])
  assert.ok(d.warnings.some(w => /pipeline round open pr --run T-7/.test(w)))
})
