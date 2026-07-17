import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArtifact, sections, pathsInSection } from './artifacts.js'
import { changedFiles, matchesAny, resolveSlot, substitute, targetedTests } from './profile.js'

// Every validator: (ctx, param) → {ok:true} | {ok:false, reasons:[...]} | {skip:true, reason}.
// Failure strings are instructions a model can act on — they land in Claude's
// context as the tool error, so each one must make the next move obvious.
//
// ctx: { runDir, repoDir, profile, state, stageDef, stageName }

const artifactAbs = (ctx, rel) => path.join(ctx.runDir, rel)

export const validators = {

  artifact_complete(ctx, rel) {
    const file = artifactAbs(ctx, rel)
    const artifact = parseArtifact(file)
    if (!artifact) {
      return fail(`artifact ${rel} does not exist — create it from the matching template in templates/ and fill every section`)
    }
    const status = artifact.frontmatter?.status
    if (status !== 'complete') {
      return fail(`artifact ${rel} has frontmatter status '${status ?? 'missing'}' — finish the stage's work, then set 'status: complete' as your LAST edit to the file`)
    }
    return ok()
  },

  sections(ctx, names) {
    const rel = ctx.stageDef.output
    if (!rel) return fail(`stage ${ctx.stageName} has a 'sections' validator but no output artifact — fix pipeline.yml`)
    const artifact = parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist — create it from its template first`)
    const present = sections(artifact.body)
    const reasons = []
    for (const name of names) {
      if (!(name in present)) reasons.push(`artifact ${rel} is missing the required section '## ${name}' — add it`)
      else if (present[name] === '') reasons.push(`section '## ${name}' in ${rel} is empty — fill it in (write 'None.' if genuinely not applicable)`)
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  files_exist_in_repo(ctx, sectionName) {
    const rel = ctx.stageDef.output
    const artifact = parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const section = sections(artifact.body)[sectionName]
    if (section === undefined) return fail(`artifact ${rel} has no '## ${sectionName}' section to verify`)
    const reasons = []
    for (const { path: p, isNew } of pathsInSection(section)) {
      if (isNew) continue
      if (!fs.existsSync(path.join(ctx.repoDir, p))) {
        reasons.push(`'## ${sectionName}' in ${rel} references ${p}, which does not exist in the repo — correct the path, or mark the line with (new) if the plan creates it`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  profile_command(ctx, slot) {
    const entries = resolveSlot(ctx.profile, slot)
    if (entries.length === 0) {
      return skip(`profile slot '${slot}' is empty for this repo — check skipped, recorded as UNVERIFIED`)
    }
    const base = ctx.state?.git?.base || 'master'
    const files = changedFiles(ctx.repoDir, base)
    const tests = targetedTests(ctx.repoDir, files, ctx.profile)
    const reasons = []
    const skipped = []
    let ran = 0
    for (const entry of entries) {
      if (entry.when && !files.some(f => matchesAny(f, [entry.when]))) continue
      const resolved = substitute(entry.run, { files, tests })
      if (resolved.skip) { skipped.push(`'${entry.run}' skipped: ${resolved.skip}`); continue }
      try {
        execSync(resolved.cmd, { cwd: ctx.repoDir, stdio: 'pipe', timeout: 600_000 })
        ran++
      } catch (e) {
        const tail = lastLines(`${e.stdout ?? ''}\n${e.stderr ?? ''}`, 50)
        reasons.push(`command failed (exit ${e.status ?? '?'}): ${resolved.cmd}\n${tail}\nFix the failures, then run 'pipeline advance' again`)
      }
    }
    if (reasons.length) return { ok: false, reasons }
    if (ran === 0) return skip(`slot '${slot}': no command applied to this change (${skipped.join('; ') || 'no matching files'}) — recorded as UNVERIFIED`)
    return ok()
  },

  git_clean_within(ctx) {
    const planRel = findPlanArtifact(ctx)
    const artifact = planRel && parseArtifact(artifactAbs(ctx, planRel))
    if (!artifact) return fail(`cannot enforce the write boundary: plan artifact not found — the plan stage must complete first`)
    const affected = pathsInSection(sections(artifact.body)['Affected files'] ?? '').map(p => p.path)
    if (affected.length === 0) return fail(`the plan's '## Affected files' section lists no paths — the write boundary cannot be derived`)
    const base = ctx.state?.git?.base || 'master'
    const files = changedFiles(ctx.repoDir, base)
    const allowedTests = targetedTests(ctx.repoDir, affected, ctx.profile)
    const noTouch = ctx.profile?.no_touch || []
    const testDirs = Object.values(ctx.profile?.test_layout || {})
    const reasons = []
    for (const file of files) {
      if (matchesAny(file, noTouch)) {
        reasons.push(`working tree touches ${file}, which matches a no_touch rule in the repo profile — revert this change; the pipeline must never modify it`)
        continue
      }
      const isAllowed = affected.some(a => file === a || file.startsWith(a.endsWith('/') ? a : a + '/'))
        || allowedTests.includes(file)
        || testDirs.some(d => file.startsWith(d))
      if (!isAllowed) {
        reasons.push(`working tree touches ${file}, which is outside the approved plan's '## Affected files' — revert it, or append a plan amendment and get it approved first`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  min_commits_per_subtask(ctx) {
    const subtask = ctx.state?.substate?.subtask
    if (!subtask) return skip(`no subtask cursor set — commit check skipped, recorded as UNVERIFIED`)
    const base = ctx.state?.git?.base || 'master'
    let count = 0
    try {
      count = parseInt(execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: ctx.repoDir, encoding: 'utf8' }).trim(), 10)
    } catch {
      return fail(`could not count commits on ${base}..HEAD — is the branch created and based on ${base}?`)
    }
    if (count < subtask) {
      return fail(`subtask ${subtask} requires at least ${subtask} commit(s) on the branch (one commit per subtask — recovery depends on it); found ${count} — commit your work with a message referencing the subtask`)
    }
    return ok()
  },

  substate_set(ctx, keys) {
    const reasons = []
    for (const key of keys) {
      if (ctx.state?.substate?.[key] == null) {
        reasons.push(`substate '${key}' is not set — initialize it with: pipeline set-substate ${key}=<value>`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  }
}

// Run a stage's validator list, collecting ALL failures (not fail-fast — the
// model fixes everything in one pass) and every skip (the honesty ledger).
export function runValidators(ctx) {
  const spec = ctx.stageDef.validate || []
  const reasons = []
  const unverified = []
  for (const item of spec) {
    const [name, param] = Object.entries(item)[0]
    const fn = validators[name]
    if (!fn) { reasons.push(`pipeline.yml names unknown validator '${name}'`); continue }
    const result = fn(ctx, param)
    if (result.skip) unverified.push(`${ctx.stageName}/${name}: ${result.reason}`)
    else if (!result.ok) reasons.push(...result.reasons)
  }
  return { ok: reasons.length === 0, reasons, unverified }
}

function findPlanArtifact(ctx) {
  // The plan artifact is whichever stage output ends in -plan.md (graph-driven, not hardcoded).
  for (const def of Object.values(ctx.config?.stages || {})) {
    if (def.output?.endsWith('-plan.md')) return def.output
  }
  return 'artifacts/02-plan.md'
}

const ok = () => ({ ok: true })
const fail = reason => ({ ok: false, reasons: [reason] })
const skip = reason => ({ skip: true, reason })
const lastLines = (s, n) => s.trim().split('\n').slice(-n).join('\n')
