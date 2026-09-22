import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hashPath, proofStamp, scanAssets } from './scan.js'
import { artifactFor, loadPipeline } from './config.js'
import { changedFiles, currentBranch, detectBase, loadProfile, matchesAny, resolveSlot, REQUIRED_SLOTS, validateProfile, untrackedFiles } from './profile.js'
import { aggregate, runMetrics } from './metrics.js'
import { boundaryAmendments, parseArtifact, pathsInSection, sections } from './artifacts.js'
import { reconcile } from './reconcile.js'
import { appendEvent, FINDING_CLASSES, newState, readEvents, readState, ROUND_SOURCES, writeState } from './state.js'
import { runValidators } from './validators.js'
import { couplingRow, matchingProbes, probeIssues, readProbes } from './probes.js'
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

  // Stamps the proof ledger against the code it was proved on. Run it right
  // after the last mutation proof; the TEST gate recomputes the digest and
  // refuses a ledger that no longer describes the code being shipped.
  'proof-stamp'(_, flags) {
    const { ctx, config, runDir } = loadRun(flags)
    const planRel = artifactFor(config, '-plan.md')
    const plan = planRel && parseArtifact(path.join(runDir, planRel))
    if (!plan) {
      return emit({ verdict: 'ERROR', error: `no plan artifact yet — the stamp covers the plan's '## Affected files', so PLAN must be complete first` }, 1)
    }
    const affected = pathsInSection(sections(plan.body)['Affected files'] ?? '').map(p => p.path)
    if (affected.length === 0) {
      return emit({ verdict: 'ERROR', error: `the plan's '## Affected files' lists no paths — nothing to stamp` }, 1)
    }
    return emit({
      verdict: 'OK',
      proof_stamp: proofStamp(ctx.repoDir, affected),
      covers: affected,
      next_action: `paste this as 'proof_stamp: <value>' in the test report's frontmatter, immediately after recording the proofs it covers — it expires the moment any of these files changes, which is the point`
    })
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
    // Stale evidence blocks NEW runs (see new-run), never work in flight: on a
    // high-velocity repo PROFILE_STALE re-fired several times a day mid-run,
    // each forcing a full re-sync that changed nothing. With a run active it
    // is a note; with none it is the hard verdict, as before.
    const stale = staleEvidence(ctx)
    const runs = listRuns(ctx.slug)
    const active = runs.filter(r => r.stage !== 'DONE')
    if (active.length === 0) {
      if (stale.length) {
        return emit({
          verdict: 'PROFILE_STALE',
          repo: ctx.slug,
          changed_evidence: stale,
          next_action: `profile evidence changed (${stale.join(', ')}) — re-verify the affected commands per stages/onboard.md re-sync flow, update evidence_hashes, then re-run`
        })
      }
      return emit({ verdict: 'NO_ACTIVE_RUN', repo: ctx.slug, finished_runs: runs.length, next_action: 'ask the developer for a ticket, then: pipeline new-run <id>' })
    }
    const staleNote = stale.length
      ? `profile evidence changed (${stale.join(', ')}) — this run continues; re-sync per stages/onboard.md before starting the next run (new-run blocks until then)`
      : null
    const wtRun = flags.run ? null : runForWorktree(ctx.slug, ctx.repoDir)
    const selected = flags.run ? active.find(r => r.id === flags.run)
      : wtRun ? active.find(r => r.id === wtRun)
      : active.length === 1 ? active[0] : null
    if (!selected) {
      return emit({
        verdict: 'ACTIVE_RUN',
        repo: ctx.slug,
        runs: active.map(r => ({ id: r.id, stage: r.stage })),
        ...(staleNote && { stale_note: staleNote }),
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
      knowledge_dir: paths.knowledgeDir(ctx.slug),
      worktree: state.git?.worktree || null,
      ...(staleNote && { stale_note: staleNote }),
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
    // The stale gate lives HERE, not on work in flight: a new run must start
    // from verified evidence, but status downgrades staleness to a note while
    // any run is active (re-sync at most once per run, not once per session).
    const stale = staleEvidence(ctx)
    if (stale.length) {
      return emit({
        verdict: 'PROFILE_STALE',
        repo: ctx.slug,
        changed_evidence: stale,
        next_action: `profile evidence changed (${stale.join(', ')}) — re-verify the affected commands per stages/onboard.md re-sync flow, update evidence_hashes, then start the run`
      }, 1)
    }
    const runDir = paths.runDir(ctx.slug, runId)
    if (fs.existsSync(runDir)) {
      return emit({ verdict: 'ERROR', error: `run ${runId} already exists — resume it via 'pipeline status --run ${runId}'` }, 1)
    }
    // --base declares a run STACKED on an open feature branch, so "this change" is
    // the diff from that branch and not from the trunk (see 'set-base' for why the
    // wrong base poisons every validator). An explicit flag always wins; otherwise
    // the stacked case is DETECTED rather than left to the developer to remember —
    // it was recorded as a knowledge fact and recurred anyway.
    const profileBase = ctx.profile?.conventions?.base_branch || 'master'
    let base = flags.base || profileBase
    let baseNote = null
    if (!flags.base) {
      const detected = detectBase(ctx.repoDir, profileBase)
      // A branch some OTHER active run already works on is a stale checkout, not
      // a stack: basing on it would diff this run against that run's work.
      const claimedByAnother = detected.autodetected && detected.branch && listRuns(ctx.slug).some(r => {
        try {
          const s = readState(paths.runDir(ctx.slug, r.id))
          return s.stage !== 'DONE' && s.git?.branch === detected.branch
        } catch { return false }
      })
      if (detected.autodetected && claimedByAnother) {
        baseNote = `HEAD is on '${detected.branch}', which run(s) already in flight are working on — NOT treating this as a stacked run. Base stays '${profileBase}'; if this run really does stack on that work, say so with 'pipeline set-base ${detected.branch}'.`
      } else if (detected.autodetected) {
        base = detected.base
        baseNote = detected.reason
      }
    }
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
    if (baseNote && base !== profileBase) appendEvent(runDir, { event: 'base_autodetected', base, from: profileBase, reason: baseNote })
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
      base,
      ...(baseNote && { base_note: baseNote }),
      ...(worktree && { worktree }),
      ...(setup.length && { worktree_setup: setup, note: 'run the worktree_setup command(s) in the worktree (and copy untracked config like .env) before starting stage work' })
    })
  },

  // The dry run. Same validators, same code path, ZERO consequences: no state
  // write, no `blocked` event, no transition. It exists because `advance` was
  // the only way to ask "would this pass?", and asking cost a full agent
  // round-trip plus a blocked event that dents first_pass_green_rate. Measured
  // across the pilot: 67 of 81 BLOCKED events were at PLAN or IMPLEMENT — stages
  // whose agent could have found the same failure itself, for free, before
  // declaring the artifact done.
  //
  // `artifact_complete` is reported apart from the rest: the runbooks mandate
  // `status: complete` as the LAST edit, so a draft artifact failing that check
  // is the expected state mid-work, not a defect. Folding it in with real
  // failures would train agents to read a red `check` as noise.
  check(_, flags) {
    const { ctx, config, runDir, state } = loadRun(flags)
    const stageName = flags.stage || state.stage
    if (stageName === 'DONE') return emit({ verdict: 'GREEN', stage: 'DONE', note: 'this run is complete — nothing left to check' })
    const stageDef = config.stages[stageName]
    if (!stageDef) {
      return emit({ verdict: 'ERROR', error: `unknown stage '${stageName}' — one of: ${config.order.join(', ')}` }, 1)
    }
    const result = runValidators({ runDir, repoDir: ctx.repoDir, profile: ctx.profile, state, stageDef, stageName, config })
    const finalization = []
    const blocking = []
    for (const c of result.checks) {
      if (c.status !== 'fail') continue
      ;(c.name === 'artifact_complete' ? finalization : blocking).push(...c.reasons)
    }
    const surfaced = result.unverified.filter(u => u.kind !== 'not_configured' && u.kind !== 'declared_na')
    return emit({
      verdict: blocking.length ? 'RED' : 'GREEN',
      stage: stageName,
      dry_run: true,
      // `target` only when it names one thing (a profile slot, a section); the
      // `sections` validator's param is the whole required list and belongs in
      // the reason, not in a label the agent scans.
      checks: result.checks.map(c => ({
        check: c.name,
        ...(c.param != null && !Array.isArray(c.param) && { target: c.param }),
        status: c.status
      })),
      blocking,
      pending_finalization: finalization,
      unverified: surfaced.map(u => u.text),
      next_action: blocking.length
        ? `${blocking.length} check(s) would BLOCK 'pipeline advance' — fix them here, then re-run 'pipeline check'. Nothing was recorded; this is a dry run.`
        : finalization.length
          ? `every substantive check passes; only the finalization stamp is missing — set 'status: complete' in the artifact frontmatter as your LAST edit, then run 'pipeline advance'`
          : `all checks green — run 'pipeline advance'`
    }, blocking.length ? 1 : 0)
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
    // post_change_hooks); declared_na = a slot the developer declared
    // not-applicable to this run's shape. Both harmless by definition —
    // audit-logged as check_skipped events below, never surfaced.
    const surfaced = result.unverified.filter(u => u.kind !== 'not_configured' && u.kind !== 'declared_na')
    for (const u of surfaced) {
      if (!state.unverified.some(e => e.text === u.text)) state.unverified.push({ stage: stageName, text: u.text, kind: u.kind })
    }
    if (!result.ok) {
      // Retros could never say WHAT blocked (only how much) — keep the count
      // for log symmetry and add the first line of each reason, truncated.
      appendEvent(runDir, {
        event: 'blocked',
        stage: stageName,
        reasons: result.reasons.length,
        reason_texts: result.reasons.map(r => r.split('\n')[0].slice(0, 200))
      })
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

  // Widen the approved plan's write boundary, on the record. The boundary check
  // is by far the loudest thing in the pilot log — 816 of 887 recorded block
  // reasons — and a large share of those were legitimate: the change really did
  // need a file the plan had not foreseen. The only sanctioned move was to
  // hand-edit the approved plan, which the runbooks forbid ("the approved plan
  // is FROZEN — later changes are appended amendments, never rewrites"), so the
  // gate and the process disagreed and the gate won by blocking repeatedly.
  //
  // This appends an amendment instead: the approved sections stay untouched, the
  // widening is one audited line the developer sees at the next gate, and
  // `git_clean_within` reads the union. A `no_touch` path is still refused —
  // that rule is the developer's, not the plan's, and no amendment overrides it.
  'amend-boundary'(positional, flags) {
    const { ctx, config, runDir, state } = loadRun(flags)
    const wanted = positional.filter(Boolean)
    const reason = typeof flags.reason === 'string' ? flags.reason.trim() : ''
    if (!wanted.length || !reason) {
      return emit({ verdict: 'ERROR', error: `usage: pipeline amend-boundary <path> [<path>…] --reason "<why this change needs the file>" — the reason lands in the plan and the audit log` }, 1)
    }
    const planRel = artifactFor(config, '-plan.md')
    if (!planRel) return emit({ verdict: 'ERROR', error: `no stage in pipeline.yml outputs a '-plan.md' artifact — there is no boundary to amend` }, 1)
    const planAbs = path.join(runDir, planRel)
    const plan = parseArtifact(planAbs)
    if (!plan) return emit({ verdict: 'ERROR', error: `plan artifact ${planRel} does not exist yet — the plan stage must produce it first` }, 1)
    if (state.stage === 'PLAN') {
      return emit({ verdict: 'ERROR', error: `the plan is still being written — add the path to '## Affected files' directly. Amendments exist for AFTER approval, when the approved sections are frozen.` }, 1)
    }
    const blocked = wanted.filter(p => matchesAny(p, ctx.profile?.no_touch || []))
    if (blocked.length) {
      return emit({ verdict: 'BLOCKED', reasons: [`${blocked.join(', ')} match a no_touch rule in this repo's profile — an amendment cannot override it. The pipeline must never modify these; if the change genuinely requires it, the developer edits them by hand.`] }, 1)
    }
    const declared = new Set(pathsInSection(sections(plan.body)['Affected files'] ?? '').map(p => p.path))
    const already = new Set(boundaryAmendments(plan.body))
    const fresh = wanted.filter(p => !declared.has(p) && !already.has(p))
    if (!fresh.length) {
      return emit({ verdict: 'OK', added: [], note: `already inside the boundary — nothing to amend. Re-run 'pipeline advance'.` })
    }
    const line = `- boundary: ${fresh.map(p => `\`${p}\``).join(', ')} — ${reason} (${state.stage}, ${new Date().toISOString().slice(0, 10)})`
    appendToSection(planAbs, 'Amendments', line)
    appendEvent(runDir, { event: 'boundary_amended', stage: state.stage, paths: fresh, reason })
    return emit({
      verdict: 'OK',
      added: fresh,
      artifact: planRel,
      note: `boundary widened by ${fresh.length} path(s); recorded in the plan's '## Amendments' and the audit log. Re-run 'pipeline advance'. Surface this to the developer at the gate — they approved a plan that did not include these files.`
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
    // --env checks the WORKING TREE, not the profile: a tree can be perfectly
    // configured and still unable to run a test. Four of the pilot's 28 recorded
    // developer notes are the same shape — assets not built, a gitignored config
    // absent, a database not loaded — each discovered by a red gate deep inside a
    // stage, where it reads as a failing change rather than an unprepared tree.
    if (flags.env) return envReport(ctx, flags)
    const { errors, warnings } = validateProfile(ctx.profile)
    return emit({
      verdict: errors.length ? 'INVALID' : 'OK',
      repo: ctx.slug,
      profile_path: paths.profilePath(ctx.slug),
      errors,
      warnings,
      note: `profile schema only — run 'pipeline doctor --env' to check that the working tree can actually run this repo's commands`
    }, errors.length ? 1 : 0)
  },

  // Host permission rules derived from the repo's OWN verified commands, so a
  // run stops prompting for every `bundle exec …` it was always going to run.
  // Emit-only by default: these rules widen what the assistant may do without
  // asking, and that is the developer's call, not a side effect of onboarding.
  permissions(_, flags) {
    const ctx = resolveRepo(flags, { requireProfile: true })
    const rules = new Set()
    const from = []
    for (const slot of Object.keys(ctx.profile?.commands || {})) {
      for (const entry of resolveSlot(ctx.profile, slot)) {
        const prefix = commandPrefix(entry.run)
        if (!prefix) continue
        rules.add(`Bash(${prefix}:*)`)
        from.push({ slot, prefix })
      }
    }
    const list = [...rules].sort()
    if (!flags.merge) {
      return emit({
        verdict: 'OK',
        repo: ctx.slug,
        permissions: list,
        derived_from: from,
        note: `${list.length} rule(s) derived from this repo's verified commands. Show them to the developer; 'pipeline permissions --merge' adds the ones they approve to ${path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'settings.json')}. Nothing was written.`
      })
    }
    const settingsFile = path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'settings.json')
    let settings = {}
    if (fs.existsSync(settingsFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      } catch (e) {
        return emit({ verdict: 'ERROR', error: `${settingsFile} is not valid JSON (${e.message}) — fix it before merging permissions into it` }, 1)
      }
    }
    settings.permissions ??= {}
    const existing = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []
    const added = list.filter(r => !existing.includes(r))
    if (added.length) {
      settings.permissions.allow = [...existing, ...added]
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
      const tmp = `${settingsFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
      fs.renameSync(tmp, settingsFile)
    }
    return emit({
      verdict: 'OK',
      repo: ctx.slug,
      settings_file: settingsFile,
      added,
      already_present: list.length - added.length,
      note: added.length ? `${added.length} rule(s) added` : 'every derived rule was already allowed — nothing changed'
    })
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

  // Abort is where the learning loop went to die. Measured across the pilot:
  // 18 of 29 runs were aborted and 15 of those at CI, because the CI runbook
  // required a MERGE — an event that happens hours later and outside the
  // session — before SCRIBE could run. So the one stage whose whole job is to
  // write knowledge executed on 6 of 29 runs, and every abort silently threw
  // away a run's worth of learnings that are sitting right there in events.jsonl.
  //
  // Aborting still ends the run immediately (nothing is blocked on a harvest),
  // but it now DEMANDS the harvest rather than forgetting it: the verdict names
  // the runbook, the event records that a harvest is owed, and skipping is an
  // explicit, reasoned choice instead of the default.
  abort(_, flags) {
    const { runDir, state } = loadRun(flags)
    if (state.stage === 'DONE') return emit({ verdict: 'OK', note: 'run already finished' })
    const from = state.stage
    appendEvent(runDir, { event: 'run_aborted', from })
    state.aborted = true
    state.stage = 'DONE'
    state.stage_status = 'complete'
    writeState(runDir, state)
    const skipReason = typeof flags['no-harvest'] === 'string' ? flags['no-harvest'].trim() : ''
    const skipped = !!flags['no-harvest']
    appendEvent(runDir, skipped
      ? { event: 'harvest_skipped', from, reason: skipReason }
      : { event: 'harvest_pending', from })
    return emit({
      verdict: 'ABORTED',
      run: state.run_id,
      aborted_at: from,
      harvest: skipped ? 'skipped' : 'required',
      ...(skipped ? {} : { harvest_runbook: paths.harvestRunbook() }),
      note: `run marked aborted at ${runDir}. Its git branch (if any) was left untouched — remove it manually if unwanted.`
        + (state.git?.worktree ? ` Its worktree at ${state.git.worktree} was kept — clean up with 'pipeline worktree remove --run ${state.run_id}'.` : ''),
      next_action: skipped
        ? `harvest skipped on the developer's instruction ("${skipReason || 'no reason given'}") — recorded. This run's learnings stay unread.`
        : `HARVEST THIS RUN before moving on: spawn the harvest agent on ${paths.harvestRunbook()} for run ${state.run_id}. An aborted run still carries everything the next run needs — blocked reasons, gate notes, review findings — and this is the only moment anyone will look at them.`
    })
  },

  // Rounds: the ledger the pilot target is actually about. `human_rounds` only
  // ever saw corrections INSIDE the run, so a run that took two reviewer rounds
  // on its PR still reported a median of 0 — the number the whole pipeline is
  // trying to drive down was the one number nobody recorded. A round is opened
  // when feedback arrives (pre-PR review, PR comments, red CI) and closed when
  // it has been worked; the findings inside it are recorded with `finding`.
  round(positional, flags) {
    const { runDir, state } = loadRun(flags)
    const action = positional[0]
    const events = readEvents(runDir)
    const open = openRound(events)
    if (action === 'open') {
      const source = positional[1] || flags.source
      if (!ROUND_SOURCES.includes(source)) {
        return emit({ verdict: 'ERROR', error: `usage: pipeline round open <${ROUND_SOURCES.join('|')}> [--ref <pr/url>] [--note "<gist>"]` }, 1)
      }
      if (open) {
        return emit({ verdict: 'ERROR', error: `round ${open.n} (${open.source}) is still open — close it first ('pipeline round close') so the ledger says when each round of feedback ended` }, 1)
      }
      const n = events.filter(e => e.event === 'round_opened').length + 1
      appendEvent(runDir, { event: 'round_opened', n, source, stage: state.stage, ref: flags.ref || null, note: flags.note || '' })
      return emit({
        verdict: 'OK',
        round: n,
        source,
        next_action: `round ${n} open — record each finding it brought with 'pipeline finding --class <${FINDING_CLASSES.join('|')}> --missed-by <probe-or-none> --summary "<one line>"', then 'pipeline round close'`
      })
    }
    if (action === 'close') {
      if (!open) return emit({ verdict: 'ERROR', error: `no round is open — 'pipeline round open <${ROUND_SOURCES.join('|')}>' starts one` }, 1)
      const findings = events.filter(e => e.event === 'finding_recorded' && e.round === open.n).length
      appendEvent(runDir, { event: 'round_closed', n: open.n, source: open.source, findings, note: flags.note || '' })
      return emit({ verdict: 'OK', round: open.n, source: open.source, findings, note: `round ${open.n} closed with ${findings} recorded finding(s)` })
    }
    if (action === 'list' || !action) {
      const rounds = events.filter(e => e.event === 'round_opened').map(e => ({
        n: e.n,
        source: e.source,
        ref: e.ref,
        closed: events.some(c => c.event === 'round_closed' && c.n === e.n),
        findings: events.filter(f => f.event === 'finding_recorded' && f.round === e.n).length
      }))
      return emit({ verdict: 'OK', rounds, open: open?.n ?? null })
    }
    return emit({ verdict: 'ERROR', error: `usage: pipeline round <open <source> | close | list>` }, 1)
  },

  // One finding, classified by what it was ABOUT and by which probe would have
  // caught it. `missed_by` is the load-bearing field: a finding whose answer is
  // a named probe tells SCRIBE exactly what to accrete, and a finding whose
  // answer is 'none' is the honest admission that nothing reasonable would have.
  finding(positional, flags) {
    const { runDir, state } = loadRun(flags)
    const cls = flags.class
    const summary = (positional.join(' ').trim() || flags.summary || '').trim()
    const missedBy = typeof flags['missed-by'] === 'string' ? flags['missed-by'].trim() : ''
    if (!FINDING_CLASSES.includes(cls) || !summary || !missedBy) {
      return emit({ verdict: 'ERROR', error: `usage: pipeline finding --class <${FINDING_CLASSES.join('|')}> --missed-by <probe name | none> --summary "<one line>" [--source <${ROUND_SOURCES.join('|')}>] [--accepted|--rejected]` }, 1)
    }
    const events = readEvents(runDir)
    const open = openRound(events)
    const source = flags.source || open?.source || 'pre-pr'
    if (!ROUND_SOURCES.includes(source)) {
      return emit({ verdict: 'ERROR', error: `--source must be one of: ${ROUND_SOURCES.join(', ')}` }, 1)
    }
    const verdict = flags.rejected ? 'rejected' : flags.accepted ? 'accepted' : 'recorded'
    appendEvent(runDir, {
      event: 'finding_recorded',
      round: open?.n ?? null,
      source,
      stage: state.stage,
      class: cls,
      missed_by: missedBy,
      disposition: verdict,
      summary
    })
    return emit({
      verdict: 'OK',
      recorded: { class: cls, missed_by: missedBy, source, disposition: verdict },
      next_action: missedBy.toLowerCase() === 'none'
        ? `recorded. 'none' means no probe would reasonably have caught this — SCRIBE will read that as a genuine limit, not as a gap.`
        : `recorded. SCRIBE must leave this run with a probe named '${missedBy}' in the repo's knowledge store — that is how this finding stops costing a round.`
    })
  },

  // The probes this repo has LEARNED, matched to what the current change
  // touches. PLAN and REVIEW start '## Coupling' from this list, so a finding
  // that cost a round once becomes a command the next run runs for free.
  probes(positional, flags) {
    const ctx = resolveRepo(flags, { requireProfile: true })
    const facts = readProbes(paths.knowledgeDir(ctx.slug))
    const issues = probeIssues(facts)
    if (flags.lint) {
      return emit({
        verdict: issues.length ? 'GAPS' : 'OK',
        repo: ctx.slug,
        facts: facts.length,
        with_probe: facts.filter(f => f.has_probe).length,
        issues,
        note: issues.length
          ? `${issues.length} fact(s) cannot be applied by a future run. A knowledge fact without a runnable probe is a story; the plan's '## Coupling' table can cite only a command.`
          : 'every knowledge fact carries a runnable probe'
      })
    }
    const all = facts.flatMap(f => f.probes)
    if (flags.all) {
      return emit({ verdict: 'OK', repo: ctx.slug, probes: all, rows: all.filter(p => p.tier === 'coupling').map(couplingRow) })
    }
    // Default: scope to what this change actually touches.
    let files = positional.filter(Boolean)
    let scope = 'the paths you passed'
    if (!files.length) {
      const runId = flags.run || runForWorktree(ctx.slug, ctx.repoDir) || onlyActiveRun(ctx.slug)
      if (!runId) {
        return emit({ verdict: 'ERROR', error: `no active run to take a diff from — pass paths ('pipeline probes app/x.rb'), or --all for every probe, or --lint to audit the store` }, 1)
      }
      const state = readState(paths.runDir(ctx.slug, runId))
      const repoDir = state.git?.worktree && fs.existsSync(state.git.worktree) ? state.git.worktree : ctx.repoDir
      files = changedFiles(repoDir, state.git?.base || 'master', { includeUntracked: true })
      scope = `run ${runId}'s diff vs ${state.git?.base}`
    }
    const matched = matchingProbes(facts, files)
    const coupling = matched.filter(p => p.tier === 'coupling')
    const inspect = matched.filter(p => p.tier === 'inspect')
    return emit({
      verdict: 'OK',
      repo: ctx.slug,
      scope,
      changed_files: files.length,
      probes: matched,
      // Searches whose hit count belongs in '## Coupling' (the gate re-runs them)…
      coupling_rows: coupling.map(couplingRow),
      // …and inspections that answer a question without producing a row.
      inspect: inspect.map(p => ({ fact: p.fact, run: p.run, asks: p.asks })),
      ...(issues.length && { store_gaps: issues.length }),
      note: matched.length
        ? `${coupling.length} coupling probe(s) to run and record in '## Coupling', ${inspect.length} inspection(s) to answer. These are checks that cost this repo a review round before.`
        : facts.length
          ? `no learned probe matches these paths — fall back to the generic probe list (the change-probes skill). If this change later takes a review round, that round names the probe this store is missing.`
          : `this repo has no knowledge store yet — SCRIBE writes it at the end of a run.`
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

  // Declare a profile slot not-applicable to THIS run's shape (e.g. lint/test
  // slots on a lockfile-only dependency bump), so its recurring "not applicable
  // to this change" skip stops re-surfacing at every gate. Safety: the
  // declaration only re-labels a skip that was happening anyway — the slot's
  // commands still run whenever changed files match, and a red check still
  // blocks. Event-sourced so a state rebuild preserves it.
  'declare-na'(positional, flags) {
    const { ctx, runDir, state } = loadRun(flags)
    const slot = positional[0]
    const validSlots = [...new Set([...Object.keys(ctx.profile?.commands || {}), ...REQUIRED_SLOTS])]
    if (!slot || !validSlots.includes(slot)) {
      return emit({ verdict: 'ERROR', error: `usage: pipeline declare-na <slot> --reason "<why>" [--clear] — slot must be one of: ${validSlots.join(', ')}` }, 1)
    }
    state.slots_na ??= {}
    if (flags.clear) {
      delete state.slots_na[slot]
      appendEvent(runDir, { event: 'slot_na_cleared', slot })
      writeState(runDir, state)
      return emit({ verdict: 'OK', slots_na: state.slots_na, note: `slot '${slot}' declaration cleared — its skips surface normally again` })
    }
    const reason = typeof flags.reason === 'string' ? flags.reason.trim() : ''
    if (!reason) {
      return emit({ verdict: 'ERROR', error: `declare-na needs --reason "<why this check cannot apply to this run>" — the reason lands in the audit log` }, 1)
    }
    state.slots_na[slot] = reason
    appendEvent(runDir, { event: 'slot_declared_na', slot, reason })
    writeState(runDir, state)
    return emit({
      verdict: 'OK',
      slots_na: state.slots_na,
      note: `slot '${slot}' declared not-applicable for this run — its no-target skips are recorded quietly instead of re-surfacing at every gate. The command still runs (and still blocks on red) whenever changed files match it.`
    })
  },

  // Self-reported usage ledger: a stage agent records each repo asset it
  // actually consulted — a knowledge fact, a bound repo skill, a curated doc.
  // (MCP-tool and skill INVOCATIONS are captured automatically by the guard's
  // observe hook; this verb covers what hooks can't see: file reads.) The
  // ledger feeds `pipeline assets`, which shows what earns its place and what
  // is dead weight.
  used(positional, flags) {
    const { runDir, state } = loadRun(flags)
    const KINDS = ['knowledge', 'skill', 'doc', 'runbook', 'mcp']
    const [kind, ...refParts] = positional
    const ref = refParts.join(' ').trim()
    if (!KINDS.includes(kind) || !ref) {
      return emit({ verdict: 'ERROR', error: `usage: pipeline used <${KINDS.join('|')}> <ref> — e.g. 'pipeline used knowledge oversized-payload-500' or 'pipeline used skill .claude/skills/code-review'` }, 1)
    }
    appendEvent(runDir, { event: 'asset_used', kind, ref, stage: state.stage, source: 'agent', ...(typeof flags.note === 'string' && flags.note ? { note: flags.note } : {}) })
    return emit({ verdict: 'OK', recorded: { kind, ref }, note: 'usage recorded — feeds the per-repo assets report (pipeline assets)' })
  },

  // Usage report for the repo's knowledge/skill assets: inventory (bound repo
  // skills/docs from the profile + knowledge fact files) joined against every
  // run's asset_used events. Zero uses across runs = a pruning candidate; the
  // SCRIBE runbook routes those as learnings.
  assets(_, flags) {
    const ctx = resolveRepo(flags, { requireProfile: true })
    const norm = ref => String(ref).replace(/\.md$/, '').replace(/^\.\//, '').replace(/\/$/, '')
    const inventory = []
    for (const [capability, b] of Object.entries(ctx.profile?.bindings || {})) {
      // The knowledge binding points at curated docs, not a skill.
      if (b?.source === 'repo' && b.path) inventory.push({ kind: capability === 'knowledge' ? 'doc' : 'skill', ref: norm(b.path), capability })
    }
    const kdir = paths.knowledgeDir(ctx.slug)
    if (fs.existsSync(kdir)) {
      for (const f of fs.readdirSync(kdir)) {
        if (f.endsWith('.md') && f !== 'index.md') inventory.push({ kind: 'knowledge', ref: norm(f) })
      }
    }
    const usage = []
    const mcpTools = {}
    for (const r of listRuns(ctx.slug)) {
      for (const e of readEvents(paths.runDir(ctx.slug, r.id))) {
        if (e.event !== 'asset_used') continue
        if (e.kind === 'mcp') { mcpTools[e.ref] = (mcpTools[e.ref] || 0) + 1; continue }
        usage.push({ kind: e.kind, ref: norm(e.ref), run: r.id })
      }
    }
    // An asset counts as used when a usage ref matches its normalized path or
    // its basename (agents cite facts by name, skills by path or name), or
    // when the ref lives UNDER the asset's path — a bound docs DIRECTORY is
    // used through reads of the files inside it.
    const matches = (item, u) =>
      (u.kind === item.kind && (u.ref === item.ref || path.basename(u.ref) === path.basename(item.ref)))
      || u.ref === item.ref || u.ref.startsWith(item.ref + '/')
    const claimed = new Set()
    const assets = inventory.map(item => {
      const hits = usage.filter(u => matches(item, u))
      hits.forEach(u => claimed.add(u))
      const runs = [...new Set(hits.map(u => u.run))]
      return { ...item, uses: hits.length, runs: runs.length, last_used: runs.at(-1) ?? null }
    })
    const unused = assets.filter(a => a.uses === 0).map(a => `${a.kind}: ${a.ref}`)
    // Usage that matched no inventory item (docs, runbooks, since-deleted
    // facts) still matters — it shows what agents lean on.
    const unmatchedTally = {}
    for (const u of usage) {
      if (!claimed.has(u)) unmatchedTally[`${u.kind}: ${u.ref}`] = (unmatchedTally[`${u.kind}: ${u.ref}`] || 0) + 1
    }
    return emit({
      verdict: 'OK',
      repo: ctx.slug,
      assets,
      unused,
      other_usage: unmatchedTally,
      mcp_tools: mcpTools,
      note: unused.length
        ? `${unused.length} asset(s) never consulted by any run — review whether they earn their place (stale? unfindable index hook? genuinely dead?) before removing`
        : 'every tracked asset has been consulted by at least one run'
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

// Append a line at the END of a named `## Section`, creating the section at the
// end of the file if it is absent. Surgical on purpose: the artifact is the
// developer's approved document and everything outside the target section —
// including the template's guidance comments — must survive untouched.
function appendToSection(file, sectionName, line) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const isHeading = l => l.trimStart().startsWith('## ')
  const headIdx = lines.findIndex(l => isHeading(l) && l.trim().slice(3).trim() === sectionName)
  if (headIdx === -1) {
    fs.writeFileSync(file, `${raw}${raw.endsWith('\n') ? '' : '\n'}\n## ${sectionName}\n\n${line}\n`)
    return
  }
  let end = lines.length
  for (let i = headIdx + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) { end = i; break }
  }
  let insert = end
  while (insert > headIdx + 1 && lines[insert - 1].trim() === '') insert--
  lines.splice(insert, 0, line)
  fs.writeFileSync(file, lines.join('\n'))
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

// Is this working tree able to run this repo's commands at all? Distinct from
// `doctor` (which reads the profile) and from a stage gate (which reads the
// change): an unprepared tree fails a gate in the language of a broken change,
// and the pilot log shows that costing whole stages to diagnose. The checks
// themselves are a capability slot — `commands.env_checks`, each entry
// optionally carrying `name` and `fix` — so nothing here knows any toolchain.
function envReport(ctx, flags) {
  let workdir = ctx.repoDir
  let runId = null
  try {
    runId = flags.run || runForWorktree(ctx.slug, ctx.repoDir) || onlyActiveRun(ctx.slug)
    if (runId) {
      const st = readState(paths.runDir(ctx.slug, runId))
      if (st.git?.worktree && fs.existsSync(st.git.worktree)) workdir = st.git.worktree
    }
  } catch { /* no run, or unreadable state — then we check the checkout we are in */ }

  const entries = resolveSlot(ctx.profile, 'env_checks')
  const setup = resolveSlot(ctx.profile, 'worktree_setup').map(e => e.run)
  const freshTree = paths.isLinkedWorktree(workdir)
  if (entries.length === 0) {
    return emit({
      verdict: 'UNCONFIGURED',
      repo: ctx.slug,
      workdir,
      ...(setup.length && { worktree_setup: setup }),
      next_action: `this repo has no 'commands.env_checks' — add them via '/pipeline onboard'. Each is a cheap command that proves the tree can actually run the repo (assets built, generated config present, database loaded), with an optional 'fix:' naming the command that repairs it. Without them, an unprepared tree first announces itself as a failing test deep inside a stage.`
    })
  }
  const results = []
  for (const entry of entries) {
    const name = entry.name || commandPrefix(entry.run) || entry.run
    try {
      execSync(entry.run, { cwd: workdir, stdio: 'pipe', timeout: 300_000 })
      results.push({ check: name, status: 'pass' })
    } catch (e) {
      const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n')
      results.push({ check: name, status: 'fail', exit: e.status ?? null, output: out, fix: entry.fix || null })
    }
  }
  const failed = results.filter(r => r.status === 'fail')
  return emit({
    verdict: failed.length ? 'ENV_GAPS' : 'OK',
    repo: ctx.slug,
    workdir,
    ...(runId && { run: runId }),
    fresh_worktree: freshTree,
    checks: results,
    ...(freshTree && setup.length && { worktree_setup: setup }),
    next_action: failed.length
      ? `${failed.length} environment check(s) failed — repair the TREE before reading any gate result as a verdict on the change. ${failed.map(f => f.fix ? `${f.check}: ${f.fix}` : `${f.check}: no fix recorded`).join(' · ')}`
      : `the tree can run this repo's commands — a red gate from here is about the change, not the environment`
  }, failed.length ? 1 : 0)
}

// The round currently taking findings, or null. Event-sourced like everything
// else: the last `round_opened` without a matching `round_closed`.
function openRound(events) {
  let open = null
  for (const e of events) {
    if (e.event === 'round_opened') open = { n: e.n, source: e.source }
    else if (e.event === 'round_closed' && open && e.n === open.n) open = null
  }
  return open
}

// A profile command reduced to the prefix a host permission rule can match:
// leading VAR=VAL assignments dropped, then tokens taken until the first flag
// or {placeholder}. `TZ=UTC yarn jest {targeted_specs}` → `yarn jest`.
function commandPrefix(cmd) {
  const tokens = String(cmd).trim().split(/\s+/)
  const out = []
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('-') || t.includes('{') || t.includes('&&') || t.includes('|')) break
    out.push(t)
  }
  return out.join(' ')
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
