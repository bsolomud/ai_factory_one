import fs from 'node:fs'
import path from 'node:path'
import { hashPath, scanAssets } from './scan.js'
import { loadPipeline } from './config.js'
import { loadProfile } from './profile.js'
import { reconcile } from './reconcile.js'
import { appendEvent, newState, readState, writeState } from './state.js'
import { runValidators } from './validators.js'
import * as paths from './paths.js'

// Exit codes: 0 = success verdicts, 1 = BLOCKED/error. A non-zero exit surfaces
// as a tool error to the model — a far stronger signal than prose.

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
    paths.recordRepoLocation(ctx.slug, ctx.repoDir) // registered even before a profile exists
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
    const selected = flags.run ? active.find(r => r.id === flags.run) : active.length === 1 ? active[0] : null
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
    const { state, notes } = reconcile({ runDir, repoDir: ctx.repoDir, config, runId: selected.id, repoSlug: ctx.slug })
    const def = config.stages[state.stage]
    return emit({
      verdict: 'ACTIVE_RUN',
      repo: ctx.slug,
      run: state.run_id,
      stage: state.stage,
      stage_status: state.stage_status,
      substate: state.substate,
      unverified: state.unverified,
      reconcile_notes: notes,
      stage_prompt: def ? paths.asset(def.prompt) : null,
      run_dir: runDir,
      next_action: nextAction(state)
    })
  },

  'new-run'(positional, flags) {
    const runId = positional[0]
    if (!runId) return emit({ verdict: 'ERROR', error: 'usage: pipeline new-run <ticket-id>' }, 1)
    const ctx = resolveRepo(flags, { requireProfile: true })
    const runDir = paths.runDir(ctx.slug, runId)
    if (fs.existsSync(runDir)) {
      return emit({ verdict: 'ERROR', error: `run ${runId} already exists — resume it via 'pipeline status --run ${runId}'` }, 1)
    }
    const config = loadPipeline()
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true })
    scaffoldArtifacts(runDir, config, runId)
    const base = ctx.profile?.conventions?.base_branch || 'master'
    const state = newState({ runId, repo: ctx.slug, stage: config.first, base })
    if (flags.autonomy) {
      if (!['gated', 'auto_low_risk', 'dry_run'].includes(flags.autonomy)) {
        return emit({ verdict: 'ERROR', error: `invalid --autonomy '${flags.autonomy}' (gated | auto_low_risk | dry_run)` }, 1)
      }
      state.autonomy = flags.autonomy
    }
    writeState(runDir, state)
    appendEvent(runDir, { event: 'run_created', run: runId, base })
    return emit({
      verdict: 'CREATED',
      run: runId,
      stage: state.stage,
      stage_prompt: paths.asset(config.stages[state.stage].prompt),
      run_dir: runDir
    })
  },

  advance(_, flags) {
    const { ctx, config, runDir, state } = loadRun(flags)
    if (state.stage === 'DONE') return emit({ verdict: 'DONE', note: 'this run is complete' })
    if (state.stage_status === 'awaiting_gate') {
      return emit({
        verdict: 'BLOCKED',
        reasons: [`stage ${state.stage} is awaiting gate approval — the developer must run 'pipeline approve' themselves (in Claude Code: type '! pipeline approve'). Do not run it on their behalf.`]
      }, 1)
    }
    const stageName = state.stage
    const stageDef = config.stages[stageName]
    const result = runValidators({ runDir, repoDir: ctx.repoDir, profile: ctx.profile, state, stageDef, stageName, config })
    for (const u of result.unverified) if (!state.unverified.includes(u)) state.unverified.push(u)
    if (!result.ok) {
      appendEvent(runDir, { event: 'blocked', stage: stageName, reasons: result.reasons.length })
      writeState(runDir, state)
      return emit({ verdict: 'BLOCKED', stage: stageName, reasons: result.reasons, unverified: result.unverified }, 1)
    }
    for (const u of result.unverified) appendEvent(runDir, { event: 'check_skipped', stage: stageName, reason: u })
    const gate = stageDef.gate || { required: false }
    if (!gate.required) {
      return emit(transition(runDir, config, state, { by: 'none' }))
    }
    state.stage_status = 'awaiting_gate'
    writeState(runDir, state)
    appendEvent(runDir, { event: 'validated', stage: stageName, subtask: state.substate.subtask ?? undefined })
    if (gate.auto_approvable && state.autonomy === 'auto_low_risk') {
      return emit(approveGate(runDir, config, state, { by: 'auto', note: 'auto-approved (auto_low_risk)' }))
    }
    return emit({
      verdict: 'GATE',
      stage: stageName,
      subtask: state.substate.subtask ?? undefined,
      unverified: state.unverified,
      next_action: `validators passed — the developer must review and run 'pipeline approve' (in Claude Code: '! pipeline approve'). STOP here.`
    })
  },

  approve(_, flags) {
    const { config, runDir, state } = loadRun(flags)
    if (state.stage === 'DONE') return emit({ verdict: 'ERROR', error: 'run already complete' }, 1)
    if (state.stage_status !== 'awaiting_gate') {
      return emit({ verdict: 'ERROR', error: `nothing awaiting approval — stage ${state.stage} is ${state.stage_status}; run 'pipeline advance' first` }, 1)
    }
    return emit(approveGate(runDir, config, state, { by: flags.by || 'human', note: flags.note || '' }))
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

  reconcile(_, flags) {
    const ctx = resolveRepo(flags, { requireProfile: true })
    const runId = flags.run || onlyActiveRun(ctx.slug)
    if (!runId) return emit({ verdict: 'ERROR', error: 'no active run (or pass --run <id>)' }, 1)
    const config = loadPipeline()
    const { state, notes, rebuilt } = reconcile({ runDir: paths.runDir(ctx.slug, runId), repoDir: ctx.repoDir, config, runId, repoSlug: ctx.slug })
    return emit({ verdict: 'OK', rebuilt, stage: state.stage, stage_status: state.stage_status, notes })
  }
}

// ---------------------------------------------------------------- helpers

function transition(runDir, config, state, { by }) {
  const next = config.stages[state.stage].next
  appendEvent(runDir, { event: 'advanced', from: state.stage, to: next, by })
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

function approveGate(runDir, config, state, { by, note }) {
  const stageDef = config.stages[state.stage]
  const gateEntry = { stage: state.stage, subtask: state.substate.subtask ?? null, approved: true, by, at: new Date().toISOString(), note }
  state.gates.push(gateEntry)
  appendEvent(runDir, { event: 'gate_approved', stage: state.stage, subtask: gateEntry.subtask ?? undefined, by, note })
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
  if (profile) paths.recordRepoLocation(slug, repoDir)
  if (requireProfile && !profile) {
    throw new Error(`no profile for repo '${slug}' — run onboarding first (pipeline status explains how)`)
  }
  return { repoDir, slug, profile }
}

function loadRun(flags) {
  const ctx = resolveRepo(flags, { requireProfile: true })
  const runId = flags.run || onlyActiveRun(ctx.slug)
  if (!runId) throw new Error(`no single active run — pass --run <id> (see 'pipeline status')`)
  const runDir = paths.runDir(ctx.slug, runId)
  const config = loadPipeline()
  const state = readState(runDir) // StateError propagates → caller told to run status (auto-reconciles)
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
      .replace('__RUN__', runId)
      .replace('__STAGE__', stageName)
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
