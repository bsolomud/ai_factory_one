import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commandPrefix, currentBranch, loadProfile, matchesAny, resolveSlot } from './profile.js'
import { appendEvent, readState } from './state.js'
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
    if (mode === 'bash') {
      const command = input.tool_input?.command || ''
      const stray = guardStrayTree(command, { repoDir, profile, active })
      if (stray) return stray
      return run ? guardBash(command, run, repoDir) : allow()
    }
    if (mode === 'write') return guardWrite(input.tool_input?.file_path || '', { repoDir, profile, run, active, cwd })
    if (mode === 'observe') return run ? observeUsage(input, run) : allow()
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

function guardBash(command, { state }, repoDir) {
  // Note: `pipeline approve` is NOT hook-blocked. The gate contract lives in
  // the skill: the model may only run it after presenting the gate summary
  // and receiving the developer's explicit confirmation in chat; every
  // approval is recorded in gates[] + events.jsonl for audit.
  //
  // Only real git invocations are judged, never text that mentions them:
  // two pilot runs were blocked on a read-only grep whose pattern
  // contained the words. And only invocations that can reach THE run's branch:
  // a developer-ordered deploy push ran from an unrelated worktree.
  const verbs = gitInvocations(command)
  if (!verbs.length || !reachesRun(command, state, repoDir)) return allow()
  if (verbs.includes('push')) {
    const prApproved = state.gates.some(g => g.stage === 'PR' && g.approved) || ['CI', 'SCRIBE', 'DONE'].includes(state.stage)
    if (!prApproved) {
      return deny(`git push is blocked until the PR-stage gate is approved (run is at ${state.stage}). Finish the pipeline stages; the developer approves the PR draft, then pushing is allowed.`)
    }
  }
  if (verbs.includes('commit') && !COMMIT_STAGES.includes(state.stage)) {
    return deny(`git commit is not allowed during the ${state.stage} stage — code changes happen in ${COMMIT_STAGES.join('/')}. If this change is needed, it belongs to a subtask (or a plan amendment).`)
  }
  return allow()
}

// Does this git call act on the run's branch? Yes when the shell is in the
// run's tree, on the run's branch, or the command names either. A run that has
// recorded neither a tree nor a branch can only be matched loosely — judge it.
function reachesRun(command, state, repoDir) {
  const { worktree, branch } = state.git || {}
  if (!worktree && !branch) return true
  const here = realish(repoDir)
  if (worktree && (realish(worktree) === here || mentionsPath(command, worktree))) return true
  if (!branch) return !worktree
  if (currentBranch(repoDir) === branch) return true
  return shellSegments(command).some(tokens => tokens.some(t => t.split(':').includes(branch) || t.endsWith(`/${branch}`)))
}

// The git verbs this command actually runs, one per git invocation.
function gitInvocations(command) {
  return shellSegments(command)
    .filter(tokens => tokens[0] === 'git')
    .map(gitVerb)
    .filter(Boolean)
}

// The command split into simple commands, each as tokens: quoted text is
// blanked first (so `grep "a; git push"` stays one grep), leading env
// assignments and subshell parens are dropped, the program is basenamed.
function shellSegments(command) {
  const blanked = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
  const out = []
  for (const segment of blanked.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().replace(/^[({]+\s*/, '').split(/\s+/).filter(Boolean)
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift()
    while (tokens.length && ['sudo', 'command', 'exec', 'env', 'time', 'nohup'].includes(tokens[0])) tokens.shift()
    if (!tokens.length) continue
    tokens[0] = path.basename(tokens[0])
    out.push(tokens)
  }
  return out
}

// A stage agent's shell starts in the session's directory on EVERY call, not
// in the run's worktree — a pilot run ran the suite three times in
// the developer's main checkout although the handoff named the worktree, and
// read the results as a verdict on the run's change. Resolution by cwd cannot
// catch this (cwd is the main checkout, so the run is ambiguous or wrong), so
// the rule is about the TREE: while every active run works in its own
// worktree, nothing in an engaged session has business running this repo's
// checks or changing git state in the main checkout. Only commands that do
// either are judged — the profile's own commands (repo-agnostic: the same
// prefixes `pipeline permissions` derives) and tree-changing git verbs; reads
// stay free. Naming a run's worktree anywhere in the command (`cd <wt> &&`,
// `git -C <wt>`) is the deliberate form and passes.
const SHELL_UTILITIES = new Set(['test', '[', 'cd', 'cp', 'mv', 'rm', 'ln', 'ls', 'cat', 'echo', 'mkdir', 'touch', 'true', 'false', 'sh', 'bash'])
const GIT_TREE_VERBS = new Set(['add', 'commit', 'stash', 'checkout', 'switch', 'reset', 'restore', 'merge', 'rebase', 'cherry-pick', 'apply', 'rm', 'mv', 'clean', 'am', 'revert'])

function guardStrayTree(command, { repoDir, profile, active }) {
  const trees = active.map(r => r.state.git?.worktree).filter(Boolean)
  if (!trees.length || trees.length < active.length) return null // a run works in the main checkout itself
  const here = realish(repoDir)
  if (trees.some(t => realish(t) === here)) return null // already inside a run's tree
  if (!runsInTree(command, profile)) return null
  if (trees.some(t => mentionsPath(command, t))) return null
  const prefix = trees.length === 1 ? `cd ${trees[0]} && ` : 'cd <the run\'s worktree> && '
  return deny(`this shell is in ${repoDir}, the main checkout — but every active pipeline run works in its own worktree (${trees.join(', ')}). Checks and git changes run here would test or change the wrong tree. Run it in the run's tree: ${prefix}${command.trim()} — each Bash call starts from the session's directory again, so repeat the cd prefix on every call. If this is the developer's own work in the main checkout, they can run it themselves with '!'.`)
}

function runsInTree(command, profile) {
  const signatures = []
  for (const slot of Object.keys(profile?.commands || {})) {
    for (const entry of resolveSlot(profile, slot)) {
      const sig = commandPrefix(entry.run).split(/\s+/).filter(Boolean)
      if (!sig.length) continue
      sig[0] = path.basename(sig[0])
      if (sig.length === 1 && SHELL_UTILITIES.has(sig[0])) continue // `test -s x` (env_checks) must not claim every `test`
      signatures.push(sig)
    }
  }
  for (const tokens of shellSegments(command)) {
    if (tokens[0] === 'git' && GIT_TREE_VERBS.has(gitVerb(tokens))) return true
    if (signatures.some(sig => sig.every((t, i) => tokens[i] === t))) return true
  }
  return false
}

// The subcommand after git's global options (`git -C x -c k=v commit` → commit).
function gitVerb(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(tokens[i])) { i++; continue }
    if (tokens[i].startsWith('-')) continue
    return tokens[i]
  }
  return null
}

function mentionsPath(command, tree) {
  const forms = new Set([tree, realish(tree)])
  const home = os.homedir()
  for (const f of [...forms]) {
    if (f.startsWith(home + path.sep)) { forms.add('~' + f.slice(home.length)); forms.add('$HOME' + f.slice(home.length)) }
  }
  return [...forms].some(f => command.includes(f))
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

// Passive usage ledger — NEVER denies. Records which MCP tools and skills a
// run's agents actually invoke, so `pipeline assets` can show what is used
// and what is dead weight. Captured here (not by agent self-report) because
// the hook sees every tool call deterministically. The dispatcher's own
// pipeline skill is not an asset worth tracking — every run trivially uses it.
function observeUsage(input, run) {
  try {
    const tool = input.tool_name || ''
    let kind = null
    let ref = null
    if (tool.startsWith('mcp__')) { kind = 'mcp'; ref = tool }
    else if (tool === 'Skill') {
      const skill = input.tool_input?.skill
      if (skill && skill !== 'pipeline') { kind = 'skill'; ref = skill }
    }
    if (kind && ref) {
      appendEvent(run.runDir, { event: 'asset_used', kind, ref, stage: run.state.stage, source: 'hook' })
    }
  } catch { /* the ledger must never break a tool call */ }
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
// Known gap, accepted: with several runs, `git -C <other-worktree> commit`
// run from a different tree resolves the run by cwd, not the -C target. The
// validators (commit counts, write boundary) remain the real order-enforcers; the guard is defense-in-depth.
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
