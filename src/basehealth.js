import { execFileSync } from 'node:child_process'

// Is the branch this run stacks on green on its own?
//
// A pilot run stacked on a feature branch. A trunk merge into that base
// removed a method the base still called; TEST saw the resulting failures and logged them
// as "pre-existing" without tying them to the base, and the first CI run came
// back with 45 failures that had to be re-diagnosed from scratch. One look at
// the base's own CI answers "is this ours?" before anyone reads a log.
//
// Read-only, through the host's `gh` (PIPELINE_GH overrides it for tests).
// Anything it cannot answer is UNKNOWN, never a guess.

const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim()

export function isStacked(base, trunk) {
  const b = String(base || '').replace(/^origin\//, '')
  return Boolean(b) && b !== trunk
}

export function baseHealth(repoDir, base) {
  const gh = process.env.PIPELINE_GH || 'gh'
  const branch = String(base).replace(/^origin\//, '')
  let tip = null
  for (const ref of [`origin/${branch}`, branch]) {
    try { tip = run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoDir); break } catch { /* next */ }
  }
  let runs
  try {
    runs = JSON.parse(run(gh, ['run', 'list', '--branch', branch, '--limit', '40', '--json', 'headSha,conclusion,status,workflowName,url,createdAt'], repoDir) || '[]')
  } catch (e) {
    return { verdict: 'UNKNOWN', base: branch, tip, reason: `cannot ask CI about '${branch}': ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}` }
  }
  if (!runs.length) return { verdict: 'UNKNOWN', base: branch, tip, reason: `CI has no runs for '${branch}' — it may be a local branch, or CI does not run on it` }

  // The commit CI judged most recently; the tip itself when CI has run on it.
  const checkedSha = runs.some(r => r.headSha === tip) ? tip : runs[0].headSha
  const latest = new Map()
  for (const r of runs.filter(r => r.headSha === checkedSha)) {
    if (!latest.has(r.workflowName)) latest.set(r.workflowName, r)
  }
  const workflows = [...latest.values()].map(r => ({
    workflow: r.workflowName,
    result: r.status === 'completed' ? r.conclusion : r.status,
    url: r.url
  }))
  const red = workflows.filter(w => FAILED.has(w.result))
  const pending = workflows.filter(w => !['success', 'skipped', 'neutral', 'cancelled'].includes(w.result) && !FAILED.has(w.result))
  const verdict = red.length ? 'RED' : pending.length ? 'PENDING' : 'GREEN'

  let repairs = []
  try {
    repairs = JSON.parse(run(gh, ['pr', 'list', '--base', branch, '--state', 'open', '--json', 'number,title,url', '--limit', '10'], repoDir) || '[]')
  } catch { /* informational only */ }

  return {
    verdict,
    base: branch,
    tip,
    checked_sha: checkedSha,
    tip_checked: checkedSha === tip,
    workflows,
    ...(red.length && { red: red.map(w => `${w.workflow}: ${w.url}`) }),
    ...(repairs.length && { open_prs_into_base: repairs.map(p => `#${p.number} ${p.title}`) })
  }
}
