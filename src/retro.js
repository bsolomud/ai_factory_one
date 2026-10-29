import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as paths from './paths.js'
import { readEvents, readState } from './state.js'
import { rememberPeople } from './nda.js'

// Review retro: what reviewers found on the pipeline's PRs after they opened,
// set against what the pipeline's own review found before — so the misses can
// become changes to the PIPELINE, the one thing every project shares.
//
// Read-only towards everything it reads: runs, repos, PRs. It writes only
// under <home>/retro/: a batch of raw evidence (private to this machine — it
// carries project detail, and never leaves it), the ledger of PRs already
// looked at, and proposals.md, which holds generic text only and is gated by
// `pipeline nda-check`.

export const retroDir = () => path.join(paths.home(), 'retro')
export const proposalsFile = () => path.join(retroDir(), 'proposals.md')
const ledgerFile = () => path.join(retroDir(), 'ledger.jsonl')

const gh = (args, cwd) => execFileSync(process.env.PIPELINE_GH || 'gh', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 1 << 26
})

export function readLedger() {
  try {
    return fs.readFileSync(ledgerFile(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { return [] }
}

const prKey = (slug, number) => `${slug}#${number}`

// Every PR a run is known to have opened: `pr-opened`, a round's ref, or —
// for runs older than either — the PR whose head is the run's branch.
function runPrs(runDir, state, repoPath) {
  const events = readEvents(runDir)
  const numbers = new Set()
  for (const e of events) {
    if (e.event === 'pr_opened' && e.number) numbers.add(Number(e.number))
    const m = String(e.ref || '').match(/\/pull\/(\d+)/)
    if (e.event === 'round_opened' && m) numbers.add(Number(m[1]))
  }
  if (!numbers.size && state?.git?.branch && repoPath) {
    try {
      const list = JSON.parse(gh(['pr', 'list', '--head', state.git.branch, '--state', 'all', '--json', 'number', '--limit', '5'], repoPath) || '[]')
      list.forEach(p => numbers.add(Number(p.number)))
    } catch { /* gh unavailable: the run is reported as having no PR */ }
  }
  return [...numbers]
}

// Rework nobody recorded: commits on the PR after the run passed its CI gate
// that fall in no feedback window. A window opens with a 'pr' or 'ci' round
// and lasts until the run next reaches DONE — the feedback procedure closes
// its round at triage and reworks after, through a reopened run. In two pilot
// PRs every post-PR commit was made in a plain session with no round at all,
// and the feedback procedure's rules (a coupling row per fix, re-prove,
// refresh the PR body) never applied to them.
export function unrecordedRework(events, commits) {
  const ms = t => Date.parse(t)
  const passedCi = events.find(e => e.event === 'advanced' && e.from === 'CI')
  if (!passedCi) return []
  const windows = events
    .filter(e => e.event === 'round_opened' && ['pr', 'ci'].includes(e.source))
    .map(r => {
      const done = events.find(e => e.event === 'advanced' && e.to === 'DONE' && ms(e.at) > ms(r.at))
      return [ms(r.at), done ? ms(done.at) : Infinity]
    })
  return commits
    .filter(c => ms(c.at) > ms(passedCi.at))
    .filter(c => !windows.some(([a, b]) => ms(c.at) >= a && ms(c.at) <= b))
}

const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number url title state createdAt mergedAt closedAt author{login}
commits(last:100){nodes{commit{oid committedDate messageHeadline}}}
reviewThreads(first:100){nodes{path line isResolved isOutdated comments(first:30){nodes{author{login __typename} body createdAt}}}}
reviews(first:60){nodes{author{login __typename} state body submittedAt}}
comments(first:60){nodes{author{login __typename} body createdAt}}}}}`

const isBot = a => !a || a.__typename === 'Bot' || /\[bot\]$/.test(a.login || '')

function feedback(pr) {
  const me = pr.author?.login
  const out = []
  for (const t of pr.reviewThreads?.nodes || []) {
    const [first, ...replies] = t.comments?.nodes || []
    if (!first || first.author?.login === me) continue
    out.push({
      kind: 'thread', author: first.author?.login, bot: isBot(first.author), at: first.createdAt,
      path: t.path, line: t.line, resolved: t.isResolved, outdated: t.isOutdated, body: first.body,
      replies: replies.map(r => ({ author: r.author?.login, by_author: r.author?.login === me, body: r.body }))
    })
  }
  for (const r of pr.reviews?.nodes || []) {
    if (r.author?.login === me || !String(r.body || '').trim()) continue
    out.push({ kind: 'review', author: r.author?.login, bot: isBot(r.author), at: r.submittedAt, state: r.state, body: r.body })
  }
  for (const c of pr.comments?.nodes || []) {
    if (c.author?.login === me) continue
    out.push({ kind: 'comment', author: c.author?.login, bot: isBot(c.author), at: c.createdAt, body: c.body })
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

function fetchPr(repoPath, number) {
  const nwo = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'], repoPath)).nameWithOwner
  const [owner, name] = nwo.split('/')
  const res = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`], repoPath))
  return res.data?.repository?.pullRequest || null
}

// What the run itself knew before the PR: its pre-PR findings and rounds,
// and where its artifacts are, for the analyst to read.
function runSide(runDir, pr) {
  const events = readEvents(runDir)
  const commits = (pr.commits?.nodes || []).map(n => ({ oid: n.commit.oid, at: n.commit.committedDate, headline: n.commit.messageHeadline }))
  const rework = unrecordedRework(events, commits)
  return {
    unrecorded_rework: rework.map(c => ({ oid: c.oid.slice(0, 11), at: c.at, headline: c.headline })),
    pre_pr_findings: events
      .filter(e => e.event === 'finding_recorded' && e.source === 'pre-pr' && !e.settles)
      .map(e => ({ round: e.round, class: e.class, disposition: e.disposition, summary: e.summary })),
    rounds: events.filter(e => e.event === 'round_opened').map(e => ({ n: e.n, source: e.source, stage: e.stage })),
    artifacts: fs.existsSync(path.join(runDir, 'artifacts'))
      ? fs.readdirSync(path.join(runDir, 'artifacts')).map(f => path.join(runDir, 'artifacts', f))
      : []
  }
}

export function collect({ since = null, repo = null, again = false } = {}) {
  const seen = new Set(readLedger().map(l => prKey(l.slug, l.pr)))
  const items = []
  const skipped = []
  for (const r of paths.knownRepos()) {
    if (repo && r.slug !== repo) continue
    const runsRoot = path.join(paths.repoHome(r.slug), 'runs')
    if (!fs.existsSync(runsRoot)) continue
    for (const runId of fs.readdirSync(runsRoot).sort()) {
      const runDir = path.join(runsRoot, runId)
      if (!fs.statSync(runDir).isDirectory()) continue
      let state = null
      try { state = readState(runDir) } catch { /* events only */ }
      for (const number of runPrs(runDir, state, r.path)) {
        if (!again && seen.has(prKey(r.slug, number))) continue
        if (!r.path) { skipped.push({ slug: r.slug, run: runId, pr: number, why: 'checkout not found on this machine' }); continue }
        let pr
        try { pr = fetchPr(r.path, number) } catch (e) {
          skipped.push({ slug: r.slug, run: runId, pr: number, why: `gh: ${String(e.stderr || e.message).trim().split('\n')[0]}` }); continue
        }
        if (!pr) { skipped.push({ slug: r.slug, run: runId, pr: number, why: 'not found' }); continue }
        if (pr.state === 'OPEN') { skipped.push({ slug: r.slug, run: runId, pr: number, why: 'still open' }); continue }
        const closed = pr.mergedAt || pr.closedAt
        if (since && closed && closed.slice(0, 10) < since) continue
        items.push({
          slug: r.slug, run: runId, run_dir: runDir, repo_path: r.path,
          pr: { number: pr.number, url: pr.url, title: pr.title, state: pr.state, closed_at: closed },
          external: feedback(pr),
          ...runSide(runDir, pr)
        })
      }
    }
  }
  rememberPeople(items.flatMap(i => i.external.flatMap(f => [f.author, ...(f.replies || []).map(r => r.author)])))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const batchDir = path.join(retroDir(), 'batches', stamp)
  fs.mkdirSync(batchDir, { recursive: true })
  fs.writeFileSync(path.join(batchDir, 'batch.json'), JSON.stringify({ created: new Date().toISOString(), items, skipped }, null, 2) + '\n')
  return { batch: stamp, batch_dir: batchDir, items, skipped }
}

export function finish(stamp) {
  const batchFile = path.join(retroDir(), 'batches', stamp, 'batch.json')
  const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'))
  const at = new Date().toISOString()
  const seen = new Set(readLedger().map(l => prKey(l.slug, l.pr)))
  const lines = batch.items
    .filter(i => !seen.has(prKey(i.slug, i.pr.number)))
    .map(i => JSON.stringify({ slug: i.slug, run: i.run, pr: i.pr.number, batch: stamp, at }))
  fs.mkdirSync(retroDir(), { recursive: true })
  if (lines.length) fs.appendFileSync(ledgerFile(), lines.join('\n') + '\n')
  return lines.length
}

// For `doctor`: runs past their CI gate whose PR is still open and has moved
// with no feedback round. Asks gh once per such run; silent when it cannot.
export function openPrRework(slug, repoPath) {
  const out = []
  const runsRoot = path.join(paths.repoHome(slug), 'runs')
  if (!repoPath || !fs.existsSync(runsRoot)) return out
  for (const runId of fs.readdirSync(runsRoot)) {
    const runDir = path.join(runsRoot, runId)
    let state
    try { state = readState(runDir) } catch { continue }
    if (!['SCRIBE', 'DONE'].includes(state.stage)) continue
    const events = readEvents(runDir)
    const opened = events.filter(e => e.event === 'pr_opened').at(-1)
    if (!opened) continue
    let pr
    try { pr = JSON.parse(gh(['pr', 'view', String(opened.number), '--json', 'state,url,commits'], repoPath)) } catch { continue }
    if (pr.state !== 'OPEN') continue
    const commits = (pr.commits || []).map(c => ({ oid: c.oid, at: c.committedDate }))
    const rework = unrecordedRework(events, commits)
    if (!rework.length) continue
    out.push({
      run: runId,
      pr: opened.number,
      commits: rework.length,
      note: `PR #${opened.number} moved ${rework.length} commit(s) after the run passed CI, with no feedback round recorded`,
      next_action: `pipeline round open pr --run ${runId} --ref ${pr.url || opened.url || opened.number}, then follow the PR-feedback procedure (a coupling row per fix, re-prove, refresh the PR body)`
    })
  }
  return out
}
