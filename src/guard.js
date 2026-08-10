import fs from 'node:fs'
import path from 'node:path'
import { currentBranch, loadProfile, matchesAny } from './profile.js'
import { readState } from './state.js'
import * as paths from './paths.js'

// PreToolUse hook: enforcement OUTSIDE the model. Exit 0 = allow,
// exit 2 = deny (stderr is fed back to the model, so every denial says why
// and what to do instead).
//
// HARD REQUIREMENT: fail OPEN. These are user-level hooks firing on all normal
// Claude usage — any internal error, missing profile, or absent run must never
// break a non-pipeline session.

// Repo writes are allowed only in stages that legitimately change code
// (IMPLEMENT/TEST plus the REVIEW/CI fix loops; SCRIBE may apply a
// human-approved doc diff).
const WRITE_STAGES = ['IMPLEMENT', 'TEST', 'REVIEW', 'CI', 'SCRIBE']
const COMMIT_STAGES = ['IMPLEMENT', 'TEST', 'REVIEW', 'CI']

// Pipeline enforcement is OPT-IN PER SESSION. It applies only after the
// developer runs a `/pipeline` command in this session (UserPromptSubmit →
// `guard mark`), and is cleared when the session ends (SessionEnd →
// `guard unmark`). Without this, a leftover active run would hijack every
// unrelated session in the same repo — the developer must never be forced into
// pipeline mode without asking for it. The TTL is only a leak guard for when
// SessionEnd doesn't fire; active `/pipeline` use refreshes the marker.
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000

function markerPath(sessionId) {
  // Sanitize: session ids are host-generated, but never build a path from an
  // id containing separators or traversal.
  if (!sessionId || typeof sessionId !== 'string' || /[^\w.-]/.test(sessionId)) return null
  return path.join(paths.home(), 'active-sessions', sessionId)
}

function sessionEngaged(sessionId) {
  const p = markerPath(sessionId)
  if (!p) return false
  try {
    const st = fs.statSync(p) // throws if absent → not engaged
    if (Date.now() - st.mtimeMs > MARKER_TTL_MS) { fs.rmSync(p, { force: true }); return false }
    return true
  } catch {
    return false
  }
}

export function guard(mode, input) {
  // Session bookkeeping modes run regardless of repo/run state.
  if (mode === 'mark') return markSession(input)
  if (mode === 'unmark') return unmarkSession(input)
  try {
    const cwd = input.cwd || process.cwd()
    const repoDir = paths.gitRoot(cwd)
    if (!repoDir) return allow()
    const slug = paths.repoSlug(repoDir)
    const profile = loadProfile(paths.profilePath(slug))
    if (!profile) return allow() // not a pipeline-onboarded repo
    // The decisive gate FIRST — it's one stat, while activeRun scans every run
    // dir (and may spawn git). The common case, a normal non-pipeline session
    // in an onboarded repo, must stay near-free on every guarded tool call.
    if (!sessionEngaged(input.session_id)) return allow()
    const active = activeRuns(slug)
    if (!active.length) return allow() // no run in flight — normal Claude usage
    const run = resolveRun(active, repoDir)
    // Bash needs THE run (its stage keys commit/push rules) — ambiguous → open.
    // Writes are checked even without a resolved run: the write's target path
    // may land in some run's worktree, which identifies the run by itself.
    if (mode === 'bash') return run ? guardBash(input.tool_input?.command || '', run) : allow()
    if (mode === 'write') return guardWrite(input.tool_input?.file_path || '', { repoDir, profile, run, active, cwd })
    return allow()
  } catch {
    return allow() // fail open, always
  }
}

// UserPromptSubmit hook: a prompt containing a `/pipeline` command engages the
// pipeline for this session. Anything else leaves the session untouched.
function markSession(input) {
  try {
    if (!/\/pipeline\b/.test(input.prompt || '')) return allow()
    const p = markerPath(input.session_id)
    if (p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `${new Date().toISOString()}\n`) }
  } catch { /* fail open — never break prompt submission */ }
  return allow()
}

// SessionEnd hook: drop the marker so enforcement never outlives the session.
function unmarkSession(input) {
  try {
    const p = markerPath(input.session_id)
    if (p) fs.rmSync(p, { force: true })
  } catch { /* best effort; TTL is the backstop */ }
  return allow()
}

function guardBash(command, { state }) {
  // Note: `pipeline approve` is NOT hook-blocked. The gate contract lives in
  // the skill: the model may only run it after presenting the gate summary
  // and receiving the developer's explicit confirmation in chat; every
  // approval is recorded in gates[] + events.jsonl for audit.
  if (/\bgit\s+push\b/.test(command)) {
    const prApproved = state.gates.some(g => g.stage === 'PR' && g.approved) || ['CI', 'SCRIBE', 'DONE'].includes(state.stage)
    if (!prApproved) {
      return deny(`git push is blocked until the PR-stage gate is approved (run is at ${state.stage}). Finish the pipeline stages; the developer approves the PR draft, then pushing is allowed.`)
    }
  }
  if (/\bgit\s+commit\b/.test(command) && !COMMIT_STAGES.includes(state.stage)) {
    return deny(`git commit is not allowed during the ${state.stage} stage — code changes happen in ${COMMIT_STAGES.join('/')}. If this change is needed, it belongs to a subtask (or a plan amendment).`)
  }
  return allow()
}

// Canonicalize a possibly-not-yet-existing path (macOS: /var → /private/var
// symlinks break naive prefix comparison against git's resolved toplevel).
const realish = paths.realpathish

function guardWrite(filePath, { repoDir, profile, run, active, cwd }) {
  if (!filePath) return allow()
  const abs = realish(path.resolve(realish(cwd), filePath))

  // Pipeline state is CLI-written ONLY — a model editing its own state file is
  // how these systems corrupt themselves. Every active run's state is off-limits,
  // not just the resolved one's.
  const base = path.basename(abs)
  if (base === 'state.json' || base === 'events.jsonl') {
    for (const r of active) {
      if (abs.startsWith(realish(r.runDir) + path.sep)) {
        return deny(`${base} is written only by the pipeline CLI — never edit it directly. Use 'pipeline advance' / 'pipeline set-substate' instead.`)
      }
    }
  }

  // The write is judged by the tree it LANDS in: a path inside some run's
  // worktree belongs to that run (and identifies it), no matter where the
  // session's cwd is — otherwise a main-clone session could edit a worktree
  // past no_touch and the stage rules.
  let target = run
  let root = realish(repoDir)
  for (const r of active) {
    const wt = r.state.git?.worktree && realish(r.state.git.worktree)
    if (wt && abs.startsWith(wt + path.sep)) { target = r; root = wt; break }
  }
  if (!abs.startsWith(root + path.sep)) return allow() // outside the repo (incl. run artifacts)
  if (!target) return allow() // several runs share this tree, none resolvable — fail open, never guess

  const rel = path.relative(root, abs)
  if (matchesAny(rel, profile.no_touch || [])) {
    return deny(`${rel} matches a no_touch rule in this repo's pipeline profile — the pipeline must never modify it. If the change is genuinely required, the developer must make it manually.`)
  }
  if (!WRITE_STAGES.includes(target.state.stage)) {
    return deny(`repo writes are not allowed during the ${target.state.stage} stage (pipeline run ${target.state.run_id} is active). ${target.state.stage} only produces its artifact in the run directory; code changes happen in IMPLEMENT.`)
  }
  return allow()
}

function activeRuns(slug) {
  const runsDir = path.join(paths.repoHome(slug), 'runs')
  if (!fs.existsSync(runsDir)) return []
  const active = []
  for (const id of fs.readdirSync(runsDir)) {
    const runDir = path.join(runsDir, id)
    try {
      const state = readState(runDir)
      if (state.stage !== 'DONE') active.push({ state, runDir })
    } catch { /* corrupt state → reconcile's job, not the guard's */ }
  }
  return active
}

// Resolve the run this session is actually working in. One active run is
// unambiguous. With several, the working tree decides first — a run's recorded
// worktree pins it from creation, before any branch exists. Then the
// checked-out branch (`branch_recorded` at the first post-BREAKDOWN advance):
// enforcement keyed to an arbitrary run applies the WRONG run's stage rules.
// No single match → fail open, never guess.
//
// Known gap, accepted: guardBash is regex-only, so `git -C <other-worktree>
// commit` run from a different tree resolves the run by cwd, not the -C
// target. The validators (commit counts, write boundary) remain the real
// order-enforcers; the guard is defense-in-depth.
function resolveRun(active, repoDir) {
  if (active.length <= 1) return active[0] ?? null
  const dir = realish(repoDir)
  const byTree = active.filter(r => r.state.git?.worktree && realish(r.state.git.worktree) === dir)
  if (byTree.length === 1) return byTree[0]
  const branch = currentBranch(repoDir)
  const matches = branch ? active.filter(r => r.state.git?.branch === branch) : []
  return matches.length === 1 ? matches[0] : null
}

const allow = () => ({ decision: 'allow', exitCode: 0 })
const deny = message => ({ decision: 'deny', exitCode: 2, message })

export function main(argv, stdinText) {
  let input = {}
  try { input = JSON.parse(stdinText || '{}') } catch { /* fail open */ }
  const result = guard(argv[0], input)
  if (result.decision === 'deny') process.stderr.write(result.message + '\n')
  process.exitCode = result.exitCode
  return result
}
