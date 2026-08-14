import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { hashPath, scanAssets } from './scan.js'
import { loadPipeline } from './config.js'
import { currentBranch, loadProfile, resolveSlot, validateProfile, untrackedFiles } from './profile.js'
import { aggregate, runMetrics } from './metrics.js'
import { parseArtifact } from './artifacts.js'
import { reconcile } from './reconcile.js'
import { appendEvent, newState, readEvents, readState, writeState } from './state.js'
import { runValidators } from './validators.js'
import { checkoutBranch, createWorktree, deleteBranch, mainWorktreeDir, removeWorktree } from './worktree.js'
import * as paths from './paths.js'

// Exit codes: 0 = success verdicts, 1 = BLOCKED/error. A non-zero exit surfaces
// as a tool error to the model — a far stronger signal than prose.

// Autonomy modes: 'gated' = a human approves every gate; 'express' (Fast fix) =
// the human approves only irreversible gates (human_required: push/PR/CI),
// everything else auto-approves ONCE ITS VALIDATORS PASS — the deterministic
// checks (lint/tests/boundary) still gate; express only drops the redundant
// human sign-off on those quality gates.
const AUTONOMY_MODES = ['gated', 'express']

export function main(argv) {
  const { command, positional, flags } = parseArgs(argv)
  try {
    const handler = commands[command]
    if (!handler) return emit({ verdict: 'ERROR', error: `unknown command '${command}' — one of: ${Object.keys(commands).join(', ')}` }, 1)
    return handler(positional, flags)
  } catch (e) {
    return emit({ verdict: 'ERROR', error: e.message }, 1)
  }
}

const commands = {

  onboard(positional, flags) {
    if (positional[0] && !flags.repo) flags.repo = positional[0]
    let ctx
    try {
      ctx = resolveRepo(flags)
    } catch (e) {
      if (!(e instanceof NoRepoError)) throw e
      return emit({ verdict: 'NO_REPO', known_repos: paths.knownRepos(), next_action: 'pass a repo path: pipeline onboard <path> (or --repo <slug>)' }, 1)
    }
    if (!paths.isLinkedWorktree(ctx.repoDir)) {
      paths.recordRepoLocation(ctx.slug, ctx.repoDir) // registered even before a profile exists
    }
    return emit({
      verdict: 'ONBOARD',
      repo: ctx.slug,
      repo_path: ctx.repoDir,
      profile_path: paths.profilePath(ctx.slug),
      reonboarding: !!ctx.profile,
      existing_profile: ctx.profile,
      candidates: scanAssets(ctx.repoDir),
      runbook: paths.asset('stages', 'onboard.md'),
      next_action: ctx.profile
        ? 'RE-onboarding: follow the runbook; prefill every question from existing_profile and never silently drop a previous answer — present current values and ask what to change'
        : 'follow the runbook: interview the developer, verify every command by running it, write the profile'
    })
  },

  hash(positional, flags) {
    const ctx = resolveRepo(flags)
    const hashes = {}
    for (const rel of positional) hashes[rel] = hashPath(path.join(ctx.repoDir, rel))
    return emit({ verdict: 'OK', hashes })
  },

  repos() {
    const repos = paths.knownRepos().map(r => ({
      ...r,
      active_runs: listRuns(r.slug).filter(x => x.stage !== 'DONE').map(x => x.id)
    }))
    return emit({
      verdict: 'OK',
      repos,
      note: repos.length ? 'pass --repo <slug> to any command to target one of these from anywhere' : 'no repos known yet — run pipeline status inside a repo to register it'
    })
  },

  status(_, flags) {
    let ctx
    try {
      ctx = resolveRepo(flags)
    } catch (e) {
      if (!(e instanceof NoRepoError)) throw e
      const known = paths.knownRepos()
      return emit({
        verdict: 'NO_REPO',
        known_repos: known,
        next_action: known.length
          ? 'not inside a repository — ask the developer which repo(s) this task concerns, then re-run with --repo <slug>'
          : 'not inside a repository and none registered yet — ask the developer for the repo path, then re-run with --repo <path>'
      })
    }
    if (!ctx.profile) {
      return emit({
        verdict: 'NO_PROFILE',
        repo: ctx.slug,
        next_action: `no profile for this repo — follow the onboarding runbook at ${paths.asset('stages', 'onboard.md')}`,
        profile_path: paths.profilePath(ctx.slug)
      })
    }
    const stale = staleEvidence(ctx)
    if (stale.length) {
      return emit({
        verdict: 'PROFILE_STALE',
        repo: ctx.slug,
        changed_evidence: stale,
        next_action: `profile evidence changed (${stale.join(', ')}) — re-verify the affected commands per stages/onboard.md re-sync flow, update evidence_hashes, then re-run`
      })
    }
    const runs = listRuns(ctx.slug)
    const active = runs.filter(r => r.stage !== 'DONE')
    if (active.length === 0) {
      return emit({ verdict: 'NO_ACTIVE_RUN', repo: ctx.slug, finished_runs: runs.length, next_action: 'ask the developer for a ticket, then: pipeline new-run <id>' })
    }
    const wtRun = flags.run ? null : runForWorktree(ctx.slug, ctx.repoDir)
    const selected = flags.run ? active.find(r => r.id === flags.run)
      : wtRun ? active.find(r => r.id === wtRun)
      : active.length === 1 ? active[0] : null
    if (!selected) {
      return emit({
        verdict: 'ACTIVE_RUN',
        repo: ctx.slug,
        runs: active.map(r => ({ id: r.id, stage: r.stage })),
        next_action: `multiple runs in flight — re-run with --run <id> to select one`
      })
    }
    const config = loadPipeline()
    const runDir = paths.runDir(ctx.slug, selected.id)
    // A run with a worktree is reconciled against ITS tree, not wherever this
    // command happens to be invoked from. Missing tree → a note, never a wall:
    // status is the recovery entry point and must always answer.
    let repoDir = ctx.repoDir
    try {
      const wt = readState(runDir).git?.worktree
      if (wt && fs.existsSync(wt)) repoDir = wt
    } catch { /* corrupt state — reconcile rebuilds it below */ }
    const { state, notes } = reconcile({ runDir, repoDir, config, runId: selected.id, repoSlug: ctx.slug })
    const def = config.stages[state.stage]
    return emit({
      verdict: 'ACTIVE_RUN',
      repo: ctx.slug,
      run: state.run_id,
      stage: state.stage,
      stage_status: state.stage_status,
      autonomy: state.autonomy,
      substate: state.substate,
      unverified: (state.unverified || []).map(u => u.text ?? u),
      reconcile_notes: notes,
      stage_prompt: def ? paths.asset(def.prompt) : null,
      run_dir: runDir,
      worktree: state.git?.worktree || null,
      next_action: nextAction(state)
    })
  },

  'new-run'(positional, flags) {
    const runId = positional[0]
    if (!runId) return emit({ verdict: 'ERROR', error: 'usage: pipeline new-run <ticket-id> [--worktree]' }, 1)
    // Run ids become path segments (runs/<id>, worktrees/<slug>/<id>) — never
    // build one from an id containing separators or traversal.
    if (!/^[\w.-]+$/.test(runId) || runId === '.' || runId === '..') {
      return emit({ verdict: 'ERROR', error: `run id '${runId}' must contain only letters, digits, '.', '_' or '-'` }, 1)
    }
    if (flags.autonomy && !AUTONOMY_MODES.includes(flags.autonomy)) {
      return emit({ verdict: 'ERROR', error: `invalid --autonomy '${flags.autonomy}' (${AUTONOMY_MODES.join(' | ')})` }, 1)
    }
    const ctx = resolveRepo(flags, { requireProfile: true })
    const runDir = paths.runDir(ctx.slug, runId)
    if (fs.existsSync(runDir)) {
      return emit({ verdict: 'ERROR', error: `run ${runId} already exists — resume it via 'pipeline status --run ${runId}'` }, 1)
    }
    // --base declares a run STACKED on an open feature branch, so "this change" is
    // the diff from that branch and not from the trunk (see 'set-base' for why the
    // wrong base poisons every validator). Default stays the profile's convention.
    const base = flags.base || ctx.profile?.conventions?.base_branch || 'master'
    // Opt-in isolated working tree, so several runs can code in parallel without
    // sharing a checkout. Created BEFORE anything else — a failure creates no run.
    // Detached at base; the run's branch is created at BREAKDOWN inside this tree.
    let worktree = null
    if (flags.worktree) {
      worktree = paths.worktreeDir(ctx.slug, runId)
      if (fs.existsSync(worktree)) {
        return emit({ verdict: 'ERROR', error: `worktree already exists at ${worktree} — remove it first ('git worktree remove ${worktree}')` }, 1)
      }
      createWorktree(ctx.repoDir, worktree, base)
    }
    const config = loadPipeline()
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true })
    scaffoldArtifacts(runDir, config, runId)
    // Snapshot the developer's pre-existing untracked files NOW, before the pipeline
    // writes anything, so the write-boundary check ignores their ambient scratch and
    // only flags untracked files the run itself creates outside the plan. A fresh
    // worktree honestly has none — the run's tree, the run's baseline.
    const baselineUntracked = untrackedFiles(worktree || ctx.repoDir)
    const state = newState({ runId, repo: ctx.slug, stage: config.first, base, baselineUntracked, worktree })
    if (flags.autonomy) state.autonomy = flags.autonomy
    writeState(runDir, state)
    // The full file list (not just a count) so a rebuilt state.json restores the
    // ambient baseline — otherwise a crash would re-flag the developer's scratch.
    appendEvent(runDir, { event: 'run_created', run: runId, base, baseline_untracked: baselineUntracked })
    if (worktree) appendEvent(runDir, { event: 'worktree_created', path: worktree, base })
    // worktree_setup is surfaced, never executed: deps install can be slow,
    // credentialed, or interactive — the dispatcher/developer runs it.
    const setup = worktree ? resolveSlot(ctx.profile, 'worktree_setup').map(e => e.run) : []
    return emit({
      verdict: 'CREATED',
      run: runId,
      stage: state.stage,
      stage_prompt: paths.asset(config.stages[state.stage].prompt),
      run_dir: runDir,
      ...(worktree && { worktree }),
      ...(setup.length && { worktree_setup: setup, note: 'run the worktree_setup command(s) in the worktree (and copy untracked config like .env) before starting stage work' })
    })
  },

  advance(_, flags) {
    const { ctx, config, runDir, state } = loadRun(flags)
    if (state.stage === 'DONE') return emit({ verdict: 'DONE', note: 'this run is complete' })
    if (state.stage_status === 'awaiting_gate') {
      return emit({
        verdict: 'BLOCKED',
        reasons: [`stage ${state.stage} is awaiting gate approval — present the gate to the developer and get their explicit confirmation, then run '/pipeline approve'. Do not approve on your own initiative.`]
      }, 1)
    }
    const stageName = state.stage
    const stageDef = config.stages[stageName]
    // Record the run's working branch the first time one exists (created at
    // BREAKDOWN). With several runs active in one clone, the guard resolves
    // WHICH run the developer is in by this branch — it must never guess.
    // A branch another active run already recorded is never double-claimed:
    // advancing run A while run B's branch happens to be checked out would
    // otherwise key A's enforcement to B's branch for good.
    if (!state.git.branch) {
      const branch = currentBranch(ctx.repoDir)
      const claimed = branch && listRuns(ctx.slug).some(r => {
        if (r.id === state.run_id) return false
        try {
          const s = readState(paths.runDir(ctx.slug, r.id))
          return s.stage !== 'DONE' && s.git?.branch === branch
        } catch { return false }
      })
      if (branch && branch !== state.git.base && !claimed) {
        state.git.branch = branch
        appendEvent(runDir, { event: 'branch_recorded', branch })
      }
    }
    const result = runValidators({ runDir, repoDir: ctx.repoDir, profile: ctx.profile, state, stageDef, stageName, config })
    // Legacy runs stored unverified as plain strings; normalize to objects so
    // the stage-scoping below has one shape to handle. A legacy string only
    // survives as a gap if it reads like one.
    state.unverified = (state.unverified || []).map(u =>
      typeof u === 'string'
        ? { stage: null, text: u, kind: (/coverage gap/i.test(u) && !/not a coverage gap/i.test(u)) ? 'no_command' : 'other' }
        : u)
    // not_configured = an optional slot the repo never set up (e.g.
    // post_change_hooks). Harmless by definition — audit-logged as a
    // check_skipped event below, but never surfaced to the developer.
    const surfaced = result.unverified.filter(u => u.kind !== 'not_configured')
    for (const u of surfaced) {
      if (!state.unverified.some(e => e.text === u.text)) state.unverified.push({ stage: stageName, text: u.text, kind: u.kind })
    }
    if (!result.ok) {
      appendEvent(runDir, { event: 'blocked', stage: stageName, reasons: result.reasons.length })
      writeState(runDir, state)
      return emit({ verdict: 'BLOCKED', stage: stageName, reasons: result.reasons, unverified: surfaced.map(u => u.text) }, 1)
    }
    for (const u of result.unverified) appendEvent(runDir, { event: 'check_skipped', stage: stageName, reason: u.text, kind: u.kind })
    const gate = stageDef.gate || { required: false }
    if (!gate.required) {
      return emit(transition(runDir, config, state, { by: 'none' }))
    }
    state.stage_status = 'awaiting_gate'
    writeState(runDir, state)
    appendEvent(runDir, { event: 'validated', stage: stageName, subtask: state.substate.subtask ?? undefined })
    // Express (Fast fix): validators passed AND this gate isn't an irreversible
    // one (push/PR/CI) → auto-approve. Human gates (human_required) always stop.
    if (state.autonomy === 'express' && !gate.human_required) {
      return emit(approveGate(runDir, config, state, { by: 'auto', note: 'express mode (validators passed)' }))
    }
    return emit({
      verdict: 'GATE',
      stage: stageName,
      subtask: state.substate.subtask ?? undefined,
      unverified: state.unverified.map(u => u.text ?? u),
      human_required: !!gate.human_required,
      next_action: `validators passed — present the artifact/diff to the developer for review; on their explicit yes run '/pipeline approve'. STOP here.`
    })
  },

  approve(_, flags) {
    const { config, runDir, state } = loadRun(flags)
    if (state.stage === 'DONE') return emit({ verdict: 'ERROR', error: 'run already complete' }, 1)
    if (state.stage_status !== 'awaiting_gate') {
      return emit({ verdict: 'ERROR', error: `nothing awaiting approval — stage ${state.stage} is ${state.stage_status}; run 'pipeline advance' first` }, 1)
    }
    if (flags.express) state.autonomy = 'express' // shortcut: pick Fast fix at this gate
    if (flags.gated) state.autonomy = 'gated'
    return emit(approveGate(runDir, config, state, { by: flags.by || 'human', note: flags.note || '', edited: !!flags.edited }))
  },

  // The developer said "no / change this" at a gate. Records the correction
  // (the round the pilot is trying to drive to zero — see human_rounds in
  // metrics) and reopens the stage for rework; advance re-validates and
  // re-gates. Without this event, corrections are invisible: the redo would
  // hide inside the same awaiting_gate window and metrics would read clean.
  'request-changes'(positional, flags) {
    const { config, runDir, state } = loadRun(flags)
    if (state.stage === 'DONE') return emit({ verdict: 'ERROR', error: 'run already complete' }, 1)
    if (state.stage_status !== 'awaiting_gate') {
      return emit({ verdict: 'ERROR', error: `nothing awaiting approval — stage ${state.stage} is ${state.stage_status}; change requests happen at a gate (for a late change after approval, use 'pipeline reopen')` }, 1)
    }
    const note = positional.join(' ').trim() || flags.note || ''
    state.stage_status = 'in_progress'
    writeState(runDir, state)
    appendEvent(runDir, { event: 'change_requested', stage: state.stage, subtask: state.substate.subtask ?? undefined, note })
    return emit({
      verdict: 'CHANGES_REQUESTED',
      stage: state.stage,
      stage_prompt: paths.asset(config.stages[state.stage].prompt),
      next_action: `stage ${state.stage} reopened for rework — dispatch the developer's change (their words: "${note}") to the stage's agent, then 'pipeline advance' re-validates and re-gates.`
    })
  },

  // A run's base is what "this change" is diffed against — every validator, the
  // write-boundary check and the targeted-test resolver derive their file set from
  // it. `new-run` takes it from the profile convention (usually the trunk), which is
  // wrong for a run STACKED on an open feature branch: the diff then spans that whole
  // branch, so lint runs over hundreds of foreign files and targeted tests balloon
  // into a suite run. The base is the one thing that cannot be inferred later, so it
  // gets an explicit setter rather than a hand-edit of state.json.
  'set-base'(positional, flags) {
    const { runDir, state, ctx } = loadRun(flags)
    const base = positional[0] || flags.base
    if (!base) return emit({ verdict: 'ERROR', error: 'usage: pipeline set-base <branch-or-commit>' }, 1)
    // Must be resolvable in the run's own tree, or every later diff silently returns
    // nothing and the gates go quiet-green.
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: ctx.repoDir, stdio: 'pipe' })
    } catch {
      return emit({ verdict: 'ERROR', error: `'${base}' does not resolve to a commit in ${ctx.repoDir} — fetch it first, or pass a branch that exists locally` }, 1)
    }
    const from = state.git.base
    if (from === base) return emit({ verdict: 'OK', base, note: 'already the run base — nothing changed' })
    state.git.base = base
    writeState(runDir, state)
    appendEvent(runDir, { event: 'base_changed', from, to: base })
    return emit({
      verdict: 'OK',
      base,
      from,
      note: `run base is now '${base}' — validators, the write boundary and targeted tests all diff against it from here on. Stage artifacts already written are NOT revisited.`
    })
  },

  'set-autonomy'(positional, flags) {
    const { runDir, state } = loadRun(flags)
    const mode = positional[0] || flags.mode
    if (!AUTONOMY_MODES.includes(mode)) {
      return emit({ verdict: 'ERROR', error: `usage: pipeline set-autonomy <${AUTONOMY_MODES.join('|')}>` }, 1)
    }
    const from = state.autonomy
    state.autonomy = mode
    writeState(runDir, state)
    appendEvent(runDir, { event: 'autonomy', from, to: mode })
    return emit({
      verdict: 'OK',
      autonomy: mode,
      note: mode === 'express'
        ? 'Fast fix: quality gates (plan/implement/test/review) auto-approve once their validators pass; you still approve the push at PR and any CI fix.'
        : 'Gated: you approve every stage.'
    })
  },

  metrics(_, flags) {
    // Org-wide rollup: every known repo, no repo context needed. Runs from any
    // folder — the single command a pilot uses to see the whole pipeline.
    const config = loadPipeline()
    if (flags.all) {
      const repos = paths.knownRepos().filter(r => r.has_profile)
      const perRepo = repos.map(r => {
        const runs = listRuns(r.slug).map(x => runMetrics(paths.runDir(r.slug, x.id), x.id, config))
        return { repo: r.slug, runs, summary: aggregate(runs) }
      })
      const allRuns = perRepo.flatMap(r => r.runs)
      return emit({
        verdict: 'OK',
        scope: 'all_repos',
        repos: perRepo.map(({ repo, runs, summary }) => ({ repo, runs: runs.length, summary })),
        org: aggregate(allRuns)
      })
    }
    const ctx = resolveRepo(flags, { requireProfile: true })
    if (flags.run) {
      return emit({ verdict: 'OK', ...runMetrics(paths.runDir(ctx.slug, flags.run), flags.run, config) })
    }
    const perRun = listRuns(ctx.slug).map(r => runMetrics(paths.runDir(ctx.slug, r.id), r.id, config))
    return emit({ verdict: 'OK', repo: ctx.slug, summary: aggregate(perRun), runs: perRun })
  },

  feedback(positional, flags) {
    const { runDir } = loadRun(flags)
    const note = positional.join(' ').trim()
    if (!note) return emit({ verdict: 'ERROR', error: 'usage: pipeline feedback "<your note>"' }, 1)
    appendEvent(runDir, { event: 'feedback', stage: flags.stage, note })
    return emit({ verdict: 'OK', recorded: note })
  },

  doctor(_, flags) {
    const ctx = resolveRepo(flags)
    if (!ctx.profile) {
      return emit({ verdict: 'NO_PROFILE', repo: ctx.slug, next_action: 'run onboarding first: pipeline onboard' }, 1)
    }
    const { errors, warnings } = validateProfile(ctx.profile)
    return emit({
      verdict: errors.length ? 'INVALID' : 'OK',
      repo: ctx.slug,
      profile_path: paths.profilePath(ctx.slug),
      errors,
      warnings
    }, errors.length ? 1 : 0)
  },

  show(_, flags) {
    const { config, runDir, state } = loadRun(flags)
    const def = config.stages[state.stage]
    const artifactRel = def?.output
    const artifact = artifactRel ? parseArtifact(path.join(runDir, artifactRel)) : null
    return emit({
      verdict: 'OK',
      run: state.run_id,
      stage: state.stage,
      stage_status: state.stage_status,
      autonomy: state.autonomy,
      substate: state.substate,
      unverified: (state.unverified || []).map(u => u.text ?? u),
      current_artifact: artifactRel || null,
      artifact_status: artifact?.frontmatter?.status ?? null,
      artifact_body: artifact?.body ?? null,
      gates_approved: state.gates.length
    })
  },

  abort(_, flags) {
    const { runDir, state } = loadRun(flags)
    if (state.stage === 'DONE') return emit({ verdict: 'OK', note: 'run already finished' })
    appendEvent(runDir, { event: 'run_aborted', from: state.stage })
    state.aborted = true
    state.stage = 'DONE'
    state.stage_status = 'complete'
    writeState(runDir, state)
    return emit({
      verdict: 'ABORTED',
      run: state.run_id,
      note: `run marked aborted at ${runDir}. Its git branch (if any) was left untouched — remove it manually if unwanted.`
        + (state.git?.worktree ? ` Its worktree at ${state.git.worktree} was kept — clean up with 'pipeline worktree remove --run ${state.run_id}'.` : '')
    })
  },

  // Per-run working tree lifecycle. `add` retrofits a worktree onto an existing
  // run (or recreates a manually-deleted one); `remove` is the ONLY sanctioned
  // cleanup — nothing removes a worktree automatically.
  worktree(positional, flags) {
    const action = positional[0]
    if (!['add', 'remove'].includes(action)) {
      return emit({ verdict: 'ERROR', error: 'usage: pipeline worktree <add|remove> [--run <id>] [--force] [--delete-branch]' }, 1)
    }
    // followWorktree off: this command manages the worktree record itself, so a
    // recorded-but-missing tree must be reachable, not a hard error.
    const { ctx, runDir, state } = loadRun(flags, { followWorktree: false })
    // worktree add/remove must run from the main clone — never from inside the
    // tree being changed (the invoking cwd may itself be a worktree).
    const mainDir = mainWorktreeDir(ctx.repoDir)

    if (action === 'add') {
      const wtPath = state.git.worktree || paths.worktreeDir(ctx.slug, state.run_id)
      if (fs.existsSync(wtPath)) {
        return emit({ verdict: 'ERROR', error: `worktree already exists at ${wtPath}` }, 1)
      }
      createWorktree(mainDir, wtPath, state.git.base)
      if (state.git.branch) {
        try {
          checkoutBranch(wtPath, state.git.branch)
        } catch (e) {
          removeWorktree(mainDir, wtPath, { force: true }) // never leave a half-set-up tree
          throw e
        }
      }
      // The run works in this tree from now on — its ambient baseline is this
      // tree's untracked files (fresh tree → none), not the old checkout's.
      const files = untrackedFiles(wtPath)
      state.git.worktree = wtPath
      state.git.baseline_untracked = files
      writeState(runDir, state)
      appendEvent(runDir, { event: 'worktree_created', path: wtPath, base: state.git.base })
      appendEvent(runDir, { event: 'baseline_untracked', count: files.length, files })
      const setup = resolveSlot(ctx.profile, 'worktree_setup').map(e => e.run)
      return emit({
        verdict: 'OK',
        run: state.run_id,
        worktree: wtPath,
        checked_out: state.git.branch || `detached at ${state.git.base}`,
        ...(setup.length && { worktree_setup: setup }),
        note: 'run the worktree_setup command(s) (and copy untracked config like .env) before working there'
      })
    }

    // remove
    const wtPath = state.git.worktree
    if (!wtPath) return emit({ verdict: 'ERROR', error: `run ${state.run_id} has no worktree` }, 1)
    if (flags['delete-branch'] && state.stage !== 'DONE' && !flags.force) {
      return emit({ verdict: 'ERROR', error: `run ${state.run_id} is still at ${state.stage} — deleting its branch now would destroy in-flight work (pass --force if you really mean it)` }, 1)
    }
    removeWorktree(mainDir, wtPath, { force: !!flags.force })
    if (flags['delete-branch'] && state.git.branch) deleteBranch(mainDir, state.git.branch)
    state.git.worktree = null
    writeState(runDir, state)
    appendEvent(runDir, { event: 'worktree_removed', path: wtPath })
    return emit({
      verdict: 'OK',
      run: state.run_id,
      removed: wtPath,
      branch: flags['delete-branch'] && state.git.branch ? `deleted ${state.git.branch}` : (state.git.branch ? `kept ${state.git.branch}` : null)
    })
  },

  'agent-start'(positional, flags) {
    const { ctx, runDir, state } = loadRun(flags)
    const label = positional[0] || flags.label || 'agent'
    const ceiling = Number(flags.max ?? ctx.profile?.limits?.max_agents_per_run ?? 40)
    const spawned = readEvents(runDir).filter(e => e.event === 'agent_spawned').length
    if (spawned >= ceiling) {
      return emit({
        verdict: 'BLOCKED',
        reasons: [`agent-spawn ceiling reached for this run (${spawned}/${ceiling}). This guards against a runaway loop. If the work legitimately needs more, raise limits.max_agents_per_run in the profile or pass --max, and tell the developer why.`]
      }, 1)
    }
    appendEvent(runDir, { event: 'agent_spawned', stage: state.stage, label })
    return emit({ verdict: 'OK', label, spawned: spawned + 1, ceiling })
  },

  // Move a run BACKWARD to an earlier stage — the sanctioned way to make a late
  // change (e.g. a one-line fix discovered at PR): reopen IMPLEMENT, change it,
  // then re-advance through the gates. Backward-only; forward is `advance`.
  reopen(positional, flags) {
    const { config, runDir, state } = loadRun(flags)
    const target = positional[0] || flags.stage
    const order = config.order
    if (!target || !order.includes(target)) {
      return emit({ verdict: 'ERROR', error: `usage: pipeline reopen <stage> — one of: ${order.join(', ')}` }, 1)
    }
    const currentPos = state.stage === 'DONE' ? order.length : order.indexOf(state.stage)
    const targetIdx = order.indexOf(target)
    if (targetIdx >= currentPos) {
      return emit({ verdict: 'ERROR', error: `reopen only moves backward (run is at ${state.stage}); to go forward use 'pipeline advance'` }, 1)
    }
    // Drop gate approvals for the target stage and everything after it — they
    // must be re-earned on the way forward (also keeps the guard's push check
    // correct: a stale PR approval can't survive a reopen to IMPLEMENT).
    state.gates = state.gates.filter(g => order.indexOf(g.stage) < targetIdx)
    // Reset the output artifact of the target stage and all later stages back to
    // draft, so their validators force the work to actually be redone (a code
    // change must re-run TEST/REVIEW, not sail past their stale 'complete' stamp).
    const reset = []
    for (let i = targetIdx; i < order.length; i++) {
      const out = config.stages[order[i]].output
      if (out && resetArtifactStatus(path.join(runDir, out))) reset.push(out)
    }
    const from = state.stage
    state.stage = target
    state.stage_status = 'in_progress'
    state.substate.critic_round = 0
    writeState(runDir, state)
    appendEvent(runDir, { event: 'reopened', from, to: target, reason: flags.reason || '' })
    return emit({
      verdict: 'REOPENED',
      from,
      stage: target,
      stage_prompt: paths.asset(config.stages[target].prompt),
      artifacts_reset: reset,
      next_action: `run reopened at ${target}; make the change, then '/pipeline work' re-advances through the gates (downstream artifacts were reset so TEST/REVIEW/PR re-run).`
    })
  },

  'set-substate'(positional, flags) {
    const { runDir, state } = loadRun(flags)
    const WHITELIST = ['critic_round', 'subtask', 'of']
    const updates = {}
    for (const pair of positional) {
      const [key, raw] = pair.split('=')
      if (!WHITELIST.includes(key)) {
        return emit({ verdict: 'ERROR', error: `substate key '${key}' is not whitelisted (allowed: ${WHITELIST.join(', ')})` }, 1)
      }
      if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) {
        return emit({ verdict: 'ERROR', error: `substate '${key}' must be a non-negative integer, got '${raw}'` }, 1)
      }
      updates[key] = parseInt(raw, 10)
    }
    for (const [key, value] of Object.entries(updates)) {
      state.substate[key] = value
      appendEvent(runDir, { event: 'substate', key, value })
    }
    writeState(runDir, state)
    return emit({ verdict: 'OK', substate: state.substate })
  },

  // Re-snapshot the repo's currently-untracked files as this run's ambient
  // baseline — the escape hatch for a run started before the file existed, or
  // an in-flight run stuck on the developer's local scratch. The developer is
  // explicitly asserting "these untracked files are mine, leave them alone";
  // the write-boundary gate then ignores exactly this set. Untracked files that
  // appear AFTER this point are still enforced as possible out-of-plan writes.
  'ignore-untracked'(_, flags) {
    const { ctx, runDir, state } = loadRun(flags)
    const before = state.git?.baseline_untracked?.length ?? 0
    const files = untrackedFiles(ctx.repoDir)
    state.git.baseline_untracked = files
    appendEvent(runDir, { event: 'baseline_untracked', count: files.length, files })
    writeState(runDir, state)
    return emit({
      verdict: 'OK',
      baseline_untracked: files.length,
      previously: before,
      files,
      note: `${files.length} currently-untracked file(s) snapshotted as ambient — the write-boundary gate will leave them alone for this run. Untracked files created after this point are still enforced. Re-run 'pipeline advance'.`
    })
  },

  reconcile(_, flags) {
    const ctx = resolveRepo(flags, { requireProfile: true })
    const runId = flags.run || runForWorktree(ctx.slug, ctx.repoDir) || onlyActiveRun(ctx.slug)
    if (!runId) return emit({ verdict: 'ERROR', error: 'no active run (or pass --run <id>)' }, 1)
    const config = loadPipeline()
    const runDir = paths.runDir(ctx.slug, runId)
    // Reconcile a worktree-backed run against ITS tree (missing tree → the
    // reconciler notes it and falls back to the invoked repo for git checks).
    let repoDir = ctx.repoDir
    try {
      const wt = readState(runDir).git?.worktree
      if (wt && fs.existsSync(wt)) repoDir = wt
    } catch { /* corrupt state — rebuilt below */ }
    const { state, notes, rebuilt } = reconcile({ runDir, repoDir, config, runId, repoSlug: ctx.slug })
    return emit({ verdict: 'OK', rebuilt, stage: state.stage, stage_status: state.stage_status, notes })
  }
}

// ---------------------------------------------------------------- helpers

// Flip an artifact's frontmatter status back to draft (used by reopen). Returns
// true if the file existed and was (re)set. Targeted regex on the frontmatter
// value preserves the rest of the file's formatting.
function resetArtifactStatus(file) {
  if (!fs.existsSync(file)) return false
  const raw = fs.readFileSync(file, 'utf8')
  const updated = raw.replace(/(^---\n[\s\S]*?\bstatus:[ \t]*)\S+/m, '$1draft')
  if (updated !== raw) fs.writeFileSync(file, updated)
  return true
}

function transition(runDir, config, state, { by }) {
  const next = config.stages[state.stage].next
  appendEvent(runDir, { event: 'advanced', from: state.stage, to: next, by })
  // Stage-local skips (not-applicable commands etc.) die with their stage;
  // only real coverage gaps (no_command) follow the run to later gates —
  // that's the "no false green" contract without re-announcing the same
  // skip at every gate forever.
  state.unverified = (state.unverified || []).filter(u => typeof u !== 'string' && u.kind === 'no_command')
  state.stage = next
  state.stage_status = next === 'DONE' ? 'complete' : 'in_progress'
  writeState(runDir, state)
  const def = config.stages[next]
  return {
    verdict: next === 'DONE' ? 'DONE' : 'ADVANCED',
    stage: next,
    stage_prompt: def ? paths.asset(def.prompt) : null,
    next_action: next === 'DONE' ? 'run complete' : `next session: /pipeline picks up at ${next}. STOP here — one stage per session.`
  }
}

function approveGate(runDir, config, state, { by, note, edited = false }) {
  const stageDef = config.stages[state.stage]
  const gateEntry = { stage: state.stage, subtask: state.substate.subtask ?? null, approved: true, by, at: new Date().toISOString(), note, edited }
  state.gates.push(gateEntry)
  appendEvent(runDir, { event: 'gate_approved', stage: state.stage, subtask: gateEntry.subtask ?? undefined, by, note, edited })
  if (stageDef.per_subtask && state.substate.subtask != null && state.substate.of != null && state.substate.subtask < state.substate.of) {
    state.substate.subtask += 1
    state.stage_status = 'in_progress'
    appendEvent(runDir, { event: 'substate', key: 'subtask', value: state.substate.subtask })
    writeState(runDir, state)
    return {
      verdict: 'APPROVED',
      stage: state.stage,
      subtask: state.substate.subtask,
      of: state.substate.of,
      next_action: `subtask ${state.substate.subtask - 1} approved — continue with subtask ${state.substate.subtask} of ${state.substate.of}`
    }
  }
  return { ...transition(runDir, config, state, { by }), verdict_note: 'gate approved' }
}

class NoRepoError extends Error {}

function resolveRepo(flags, { requireProfile } = {}) {
  let target = flags.repo || process.cwd()
  // --repo accepts a registered slug as well as a path — /pipeline from any folder.
  if (flags.repo && !fs.existsSync(flags.repo)) {
    const known = paths.knownRepos().find(r => r.slug === flags.repo && r.path)
    if (known) target = known.path
  }
  const repoDir = paths.gitRoot(target)
  if (!repoDir) throw new NoRepoError(`'${target}' is not inside a git repository`)
  const slug = paths.repoSlug(repoDir)
  const profile = loadProfile(paths.profilePath(slug))
  // A linked worktree must never overwrite the canonical clone path — the
  // registry is how `--repo <slug>` finds the repo from anywhere, forever.
  if (profile && !paths.isLinkedWorktree(repoDir)) paths.recordRepoLocation(slug, repoDir)
  if (requireProfile && !profile) {
    throw new Error(`no profile for repo '${slug}' — run onboarding first (pipeline status explains how)`)
  }
  return { repoDir, slug, profile }
}

function loadRun(flags, { followWorktree = true } = {}) {
  const ctx = resolveRepo(flags, { requireProfile: true })
  const runId = flags.run || runForWorktree(ctx.slug, ctx.repoDir) || onlyActiveRun(ctx.slug)
  if (!runId) throw new Error(`no single active run — pass --run <id> (see 'pipeline status')`)
  const runDir = paths.runDir(ctx.slug, runId)
  const config = loadPipeline()
  const state = readState(runDir) // StateError propagates → caller told to run status (auto-reconciles)
  // A run with a worktree works THERE, no matter where the CLI was invoked —
  // validators, branch recording, untracked snapshots all target the run's tree.
  if (followWorktree && state.git?.worktree) {
    if (!fs.existsSync(state.git.worktree)) {
      throw new Error(`run ${runId} works in ${state.git.worktree} but that directory is missing — recreate it ('pipeline worktree add --run ${runId}') or clear the record ('pipeline worktree remove --run ${runId}')`)
    }
    ctx.repoDir = state.git.worktree
  }
  return { ctx, config, runDir, state }
}

function listRuns(slug) {
  const dir = path.join(paths.repoHome(slug), 'runs')
  if (!fs.existsSync(dir)) return []
  // A run with missing/corrupt state.json is still a run — reconcile rebuilds
  // it from artifacts + events. Filtering it out here would hide crashed runs.
  return fs.readdirSync(dir)
    .filter(d => fs.statSync(path.join(dir, d)).isDirectory())
    .map(id => {
      try { return { id, stage: readState(path.join(dir, id)).stage } } catch { return { id, stage: 'NEEDS_RECONCILE' } }
    })
}

function onlyActiveRun(slug) {
  const active = listRuns(slug).filter(r => r.stage !== 'DONE')
  return active.length === 1 ? active[0].id : null
}

// The active run whose recorded worktree IS this working tree — what lets N
// terminals each sit in their own worktree and never pass --run.
function runForWorktree(slug, repoDir) {
  if (!paths.isLinkedWorktree(repoDir)) return null
  const dir = paths.realpathish(repoDir)
  for (const r of listRuns(slug)) {
    if (r.stage === 'DONE') continue
    try {
      const wt = readState(paths.runDir(slug, r.id)).git?.worktree
      if (wt && paths.realpathish(wt) === dir) return r.id
    } catch { /* corrupt state — reconcile's job, not selection's */ }
  }
  return null
}

// Staleness triggers: the evidence files the profile was derived from, AND
// every repo-bound skill/doc (a team editing their review skill should be
// noticed on the next run, not silently ignored).
function staleEvidence(ctx) {
  const stale = []
  for (const [file, recorded] of Object.entries(ctx.profile?.evidence_hashes || {})) {
    if ((hashPath(path.join(ctx.repoDir, file)) ?? 'missing') !== recorded) stale.push(file)
  }
  for (const [capability, binding] of Object.entries(ctx.profile?.bindings || {})) {
    if (binding?.source !== 'repo' || !binding.path || !binding.sha) continue
    if ((hashPath(path.join(ctx.repoDir, binding.path)) ?? 'missing') !== binding.sha) {
      stale.push(`binding:${capability} (${binding.path})`)
    }
  }
  return stale
}

function scaffoldArtifacts(runDir, config, runId) {
  for (const [stageName, def] of Object.entries(config.stages)) {
    if (!def.output) continue
    const templateName = path.basename(def.output).replace(/^\d+-/, '')
    const template = paths.asset('templates', templateName)
    if (!fs.existsSync(template)) continue
    const content = fs.readFileSync(template, 'utf8')
      .replaceAll('__RUN__', runId)
      .replaceAll('__STAGE__', stageName)
    fs.writeFileSync(path.join(runDir, def.output), content)
  }
}

function nextAction(state) {
  if (state.stage === 'DONE') return 'run complete'
  if (state.stage_status === 'awaiting_gate') return `awaiting developer approval — '! pipeline approve'`
  return `follow the stage prompt, then run 'pipeline advance'`
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const positional = []
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ } else flags[key] = true
    } else positional.push(rest[i])
  }
  return { command, positional, flags }
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
  process.exitCode = code
  return obj
}
