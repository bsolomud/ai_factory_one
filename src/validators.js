import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { acceptanceCriteriaIds, parseArtifact, sections, pathsInSection } from './artifacts.js'
import { changedFiles, matchesAny, REQUIRED_SLOTS, resolveSlot, sourceFilesNeedingSpecs, substitute, targetedTests, untrackedFiles } from './profile.js'

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
      return REQUIRED_SLOTS.includes(slot)
        ? skip(`profile slot '${slot}' is empty for this repo — check skipped, recorded as UNVERIFIED (a real coverage gap; add the command via '/pipeline onboard')`, 'no_command')
        : skip(`optional slot '${slot}' is not configured for this repo — not applicable, recorded as UNVERIFIED (not a coverage gap)`, 'not_configured')
    }
    const base = ctx.state?.git?.base || 'master'
    const files = changedFiles(ctx.repoDir, base)
    const tests = targetedTests(ctx.repoDir, files, ctx.profile)
    const reasons = []
    const skipped = []
    let ran = 0
    for (const entry of entries) {
      if (entry.when && !files.some(f => matchesAny(f, [entry.when]))) continue
      // Scope {changed_files} to the files this command's `when` glob actually
      // matches, so e.g. `rubocop {changed_files}` (when **/*.rb) never receives
      // a .md/.json path from a mixed changeset (MB-46745). Tests stay global —
      // targetedTests already resolved them from the whole change.
      const scoped = entry.when ? files.filter(f => matchesAny(f, [entry.when])) : files
      const resolved = substitute(entry.run, { files: scoped, tests })
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
    if (ran === 0) {
      // Nothing ran. Distinguish a genuine coverage gap (source changed but has
      // no mirror spec) from expected bookkeeping (config/view/spec-only change).
      const needsSpecs = slot === 'test_targeted' ? sourceFilesNeedingSpecs(ctx.repoDir, files, ctx.profile) : []
      if (needsSpecs.length) {
        // Convention-safe escape hatch: if (and only if) the repo opted into an
        // explicit test_fallback command, run THAT — never a hardcoded full suite
        // (repo profiles forbid full-suite runs). Otherwise flag loudly.
        const fallback = resolveSlot(ctx.profile, 'test_fallback')
        if (fallback.length) {
          for (const entry of fallback) {
            const resolved = substitute(entry.run, { files, tests })
            if (resolved.skip) continue
            try {
              execSync(resolved.cmd, { cwd: ctx.repoDir, stdio: 'pipe', timeout: 600_000 })
              ran++
            } catch (e) {
              const tail = lastLines(`${e.stdout ?? ''}\n${e.stderr ?? ''}`, 50)
              reasons.push(`test_fallback failed (exit ${e.status ?? '?'}): ${resolved.cmd}\n${tail}\nFix the failures, then run 'pipeline advance' again`)
            }
          }
          if (reasons.length) return { ok: false, reasons }
          if (ran > 0) return ok()
        }
        return skip(`slot '${slot}': source files changed with NO mirror spec: ${needsSpecs.join(', ')} — add a spec (preferred) or verify manually; recorded as UNVERIFIED (possible coverage gap). Define commands.test_fallback in the profile to auto-cover this case.`, 'no_command')
      }
      return skip(`slot '${slot}': not applicable to this change — the changed files map to no ${slot} target (${skipped.join('; ') || 'no matching files'}). Expected for config/view/spec-only changes; recorded as UNVERIFIED for the audit trail, not a coverage gap. Run a broader check yourself if the change warrants it.`, 'no_target')
    }
    return ok()
  },

  // Deterministic secret scan over what the branch ADDS (committed diff +
  // working tree + new untracked files, minus the ambient baseline). MB-46498
  // reached the PR gate with a real support address as a committed config
  // default — one whole reopen cycle that a diff-time check catches at the
  // subtask gate. A deliberate dummy value is disarmed by putting
  // `pipeline:allow-secret` in a comment on the same line.
  no_secrets(ctx) {
    const base = ctx.state?.git?.base || 'master'
    const reasons = []
    const scanLine = (file, line) => {
      if (line.includes('pipeline:allow-secret')) return
      for (const [label, re] of SECRET_PATTERNS) {
        if (re.test(line)) {
          reasons.push(`possible ${label} added in ${file}: "${line.trim().slice(0, 120)}" — never commit a real credential or secret default; inject it via the environment (per the context '## Decisions' secrets policy). If this is a deliberate dummy value, disarm the line with a 'pipeline:allow-secret' comment.`)
          return
        }
      }
    }
    let diff = ''
    try {
      diff = execFileSync('git', ['diff', base, '-U0', '--no-color'], { cwd: ctx.repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    } catch {
      return skip(`could not diff against '${base}' — secret scan skipped, recorded as UNVERIFIED`, 'no_target')
    }
    let file = '?'
    for (const line of diff.split('\n')) {
      const header = line.match(/^\+\+\+ b\/(.*)$/)
      if (header) { file = header[1]; continue }
      if (line.startsWith('+') && !line.startsWith('+++')) scanLine(file, line.slice(1))
    }
    const ambient = new Set(ctx.state?.git?.baseline_untracked || [])
    for (const f of untrackedFiles(ctx.repoDir)) {
      if (ambient.has(f)) continue
      try {
        for (const line of fs.readFileSync(path.join(ctx.repoDir, f), 'utf8').split('\n')) scanLine(f, line)
      } catch { /* binary or unreadable — the boundary check owns unexpected files */ }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // REVIEW effectiveness was invisible: findings lived only in prose, so
  // metrics couldn't see them and a blocking finding could ride into PR
  // unresolved. The reviewer declares machine-readable counts in the artifact
  // frontmatter; the gate refuses to pass with unresolved blocking findings
  // (fix them, or move them to '## Disputed' for the developer to arbitrate).
  review_counts(ctx) {
    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const f = artifact.frontmatter?.findings
    const counts = ['blocking', 'advisory', 'fixed', 'disputed']
    if (!f || typeof f !== 'object' || counts.some(k => typeof f[k] !== 'number')) {
      return fail(`artifact ${rel} frontmatter needs machine-readable review counts — findings: { blocking: n, advisory: n, fixed: n, disputed: n } — metrics and this gate read them; keep them consistent with '## Findings'`)
    }
    if (f.blocking > 0) {
      return fail(`the review declares ${f.blocking} unresolved BLOCKING finding(s) — run the fix loop (implementer fixes, fresh reviewer verifies, record under '## Fixes applied', decrement blocking), or move the finding with both positions to '## Disputed' for the developer to arbitrate at the gate`)
    }
    return ok()
  },

  git_clean_within(ctx) {
    const planRel = findPlanArtifact(ctx)
    const artifact = planRel && parseArtifact(artifactAbs(ctx, planRel))
    if (!artifact) return fail(`cannot enforce the write boundary: plan artifact not found — the plan stage must complete first`)
    const affected = pathsInSection(sections(artifact.body)['Affected files'] ?? '').map(p => p.path)
    if (affected.length === 0) return fail(`the plan's '## Affected files' section lists no paths — the write boundary cannot be derived`)
    const base = ctx.state?.git?.base || 'master'
    // Boundary enforcement DOES want untracked files: a run's brand-new file that
    // isn't committed yet is still an out-of-plan write we must catch.
    const files = changedFiles(ctx.repoDir, base, { includeUntracked: true })
    const allowedTests = targetedTests(ctx.repoDir, affected, ctx.profile)
    const noTouch = ctx.profile?.no_touch || []
    const testDirs = Object.values(ctx.profile?.test_layout || {})
    // Files that were already sitting untracked when the run started (snapshotted in
    // new-run). They are the developer's ambient scratch — the pipeline did not create
    // them, so they must never block the boundary gate (they also can't be checked for
    // no_touch: an untracked file has no diff to inspect). Only untracked files that
    // appeared DURING the run are the pipeline's responsibility.
    const ambient = new Set(ctx.state?.git?.baseline_untracked || [])
    const reasons = []
    for (const file of files) {
      if (ambient.has(file)) continue
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

  // Every acceptance criterion agreed at CONTEXT must be accounted for in the
  // test report — mapped to a test in '## Risk-to-test map' or explicitly
  // parked in '## Deferred' (never silently dropped). Was prose-only in the
  // QA prompt before; a dropped criterion is a guaranteed "wait, it doesn't
  // do X" round after merge.
  ac_traceability(ctx) {
    const contextRel = findArtifactBySuffix(ctx, '-context.md')
    const context = contextRel && parseArtifact(artifactAbs(ctx, contextRel))
    if (!context) return fail(`cannot check acceptance-criteria coverage: context artifact not found`)
    const ids = acceptanceCriteriaIds(context.body)
    if (ids.length === 0) {
      return fail(`the context artifact's '## Acceptance criteria' has no numbered rows — number them (| # | Criterion | Verified by |); the ids are the traceability keys the test report must reference as AC#<n>`)
    }
    const rel = ctx.stageDef.output
    const report = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!report) return fail(`artifact ${rel} does not exist yet`)
    const secs = sections(report.body)
    const mapText = secs['Risk-to-test map'] ?? ''
    const deferredText = secs['Deferred'] ?? ''
    const reasons = []
    for (const n of ids) {
      const ref = new RegExp(`AC[#-]?${n}\\b`)
      if (!ref.test(mapText) && !ref.test(deferredText)) {
        reasons.push(`acceptance criterion AC#${n} is not accounted for in ${rel} — add a '## Risk-to-test map' row naming the test that proves it (or 'not tested because <reason>'), or park it under '## Deferred'; criteria are never silently dropped`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // The MB-46745 class of plan defect, as an exit code: `advance` gates every
  // subtask on green targeted tests, so a breaking change and the spec that
  // adapts to it MUST land in the same subtask — split them and the breaking
  // subtask can never pass its own gate. Requires each subtask to declare its
  // slice of '## Affected files'; checks the slices partition the boundary.
  subtask_coupling(ctx) {
    const planRel = findPlanArtifact(ctx)
    const artifact = planRel && parseArtifact(artifactAbs(ctx, planRel))
    if (!artifact) return fail(`cannot check subtask coupling: plan artifact not found — the plan stage must complete first`)
    const secs = sections(artifact.body)
    const subtasks = parseSubtaskFiles(secs['Subtasks'] ?? '')
    if (subtasks.length === 0) {
      return fail(`the plan's '## Subtasks' section declares no subtasks with Files — write it as a table (# | Subtask | Files) where Files is each subtask's slice of '## Affected files' (backticked paths); the coupling check gates on it`)
    }
    const affected = pathsInSection(secs['Affected files'] ?? '').map(p => p.path)
    const reasons = []
    const claimedBy = new Map()
    for (const st of subtasks) {
      if (st.files.length === 0) {
        reasons.push(`subtask ${st.n} lists no Files — declare which '## Affected files' paths it changes (backticked, in its Files column)`)
        continue
      }
      for (const f of st.files) {
        if (claimedBy.has(f) && claimedBy.get(f) !== st.n) {
          reasons.push(`${f} is claimed by both subtask ${claimedBy.get(f)} and subtask ${st.n} — every affected file belongs to exactly ONE subtask (each subtask is one reviewable diff)`)
        } else {
          claimedBy.set(f, st.n)
        }
        if (!affected.includes(f)) {
          reasons.push(`subtask ${st.n} lists ${f}, which is not in '## Affected files' — the write boundary and the subtasks must agree; add it there or remove it here`)
        }
      }
    }
    for (const p of affected) {
      if (!claimedBy.has(p)) reasons.push(`'## Affected files' lists ${p} but no subtask claims it — add it to the Files of the subtask that changes it (or drop it from the plan)`)
    }
    // The load-bearing check: a source file's mapped spec must not live in a
    // DIFFERENT subtask — that split is exactly what aborted MB-46745.
    for (const st of subtasks) {
      for (const f of st.files) {
        for (const spec of targetedTests(ctx.repoDir, [f], ctx.profile)) {
          const owner = claimedBy.get(spec)
          if (owner != null && owner !== st.n) {
            reasons.push(`subtask ${st.n} changes ${f} but its spec ${spec} is in subtask ${owner} — a breaking change and the spec that adapts to it must be ONE subtask (advance gates each subtask on green targeted tests; split, subtask ${st.n} can never pass its own gate). Merge them or restructure the split.`)
          }
        }
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  min_commits_per_subtask(ctx) {
    const subtask = ctx.state?.substate?.subtask
    if (!subtask) return skip(`no subtask cursor set — commit check skipped, recorded as UNVERIFIED`, 'no_target')
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
// Skips carry a machine `kind` (no_command | not_configured | no_target |
// other) so metrics never have to classify by regexing the prose reason.
export function runValidators(ctx) {
  const spec = ctx.stageDef.validate || []
  const reasons = []
  const unverified = []
  for (const item of spec) {
    const [name, param] = Object.entries(item)[0]
    const fn = validators[name]
    if (!fn) { reasons.push(`pipeline.yml names unknown validator '${name}'`); continue }
    const result = fn(ctx, param)
    if (result.skip) unverified.push({ text: `${ctx.stageName}/${name}: ${result.reason}`, kind: result.kind || 'other' })
    else if (!result.ok) reasons.push(...result.reasons)
  }
  return { ok: reasons.length === 0, reasons, unverified }
}

// Kept deliberately literal-value shaped: an ENV lookup or interpolation never
// matches, only a quoted secret-looking literal or a well-known token format —
// the scan must be quiet enough that a BLOCK always deserves attention.
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  // No leading \b: real keys are compound (sync_support_password, admin_api_key).
  ['credential assignment', /(?:api[_-]?key|secret[_-]?key|secret|token|password|passwd)\b\s*(?:[:=]|=>)\s*['"][^'"\s]{8,}['"]/i]
]

// Per-subtask file claims from '## Subtasks'. Accepts a table row
// (| 1 | title | `a`, `b` |) or a numbered list item (1. title — `a`, `b`);
// lines without a leading number attach their paths to the current subtask.
function parseSubtaskFiles(text) {
  const subtasks = []
  let current = null
  for (const line of text.split('\n')) {
    if (/^\s*\|[-\s|:]+\|\s*$/.test(line)) continue // table separator row
    const table = line.match(/^\s*\|\s*(\d+)\s*\|/)
    const list = line.match(/^\s*(?:-\s*\[.\]\s*)?(\d+)[.)]\s/)
    const n = table ? parseInt(table[1], 10) : list ? parseInt(list[1], 10) : null
    if (n != null) { current = { n, files: [] }; subtasks.push(current) }
    if (!current) continue
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const cleaned = m[1].replace(/:\d+(-\d+)?$/, '').trim()
      if (cleaned.includes('/') || /\.\w+$/.test(cleaned)) current.files.push(cleaned)
    }
  }
  return subtasks
}

function findPlanArtifact(ctx) {
  // The plan artifact is whichever stage output ends in -plan.md (graph-driven, not hardcoded).
  return findArtifactBySuffix(ctx, '-plan.md') || 'artifacts/02-plan.md'
}

function findArtifactBySuffix(ctx, suffix) {
  for (const def of Object.values(ctx.config?.stages || {})) {
    if (def.output?.endsWith(suffix)) return def.output
  }
  return suffix === '-context.md' ? 'artifacts/01-context.md' : null
}

const ok = () => ({ ok: true })
const fail = reason => ({ ok: false, reasons: [reason] })
const skip = (reason, kind = 'other') => ({ skip: true, reason, kind })
const lastLines = (s, n) => s.trim().split('\n').slice(-n).join('\n')
