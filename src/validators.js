import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { acAccounting, acceptanceCriteriaIds, acRef, backtickPaths, boundaryAmendments, parseArtifact, sections, pathsInSection } from './artifacts.js'
import { artifactFor } from './config.js'
import { proofStamp } from './scan.js'
import { changedFiles, matchesAny, REQUIRED_SLOTS, resolveSlot, sourceFilesNeedingSpecs, substitute, targetedTests, untrackedFiles } from './profile.js'
import { SKIP_KINDS } from './state.js'

// Every validator: (ctx, param) → {ok:true} | {ok:false, reasons:[...]} | {skip:true, reason}.
// Failure strings are instructions a model can act on — they land in Claude's
// context as the tool error, so each one must make the next move obvious.
//
// ctx: { runDir, repoDir, profile, state, stageDef, stageName }

const artifactAbs = (ctx, rel) => path.join(ctx.runDir, rel)

// One advance runs several validators that all ask git for the same file
// lists — memoized on the shared ctx so a subtask gate spawns each git
// subprocess once, not once per validator.
const ctxChangedFiles = (ctx, opts = {}) => {
  const memo = (ctx._memo ??= {})
  const key = opts.includeUntracked ? 'changed+untracked' : 'changed'
  return memo[key] ??= changedFiles(ctx.repoDir, ctx.state?.git?.base || 'master', opts)
}
const ctxUntrackedFiles = ctx => (ctx._memo ??= {}).untracked ??= untrackedFiles(ctx.repoDir)

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
        : skip(`optional slot '${slot}' is not configured for this repo — skipped (not a coverage gap; nothing to do)`, 'not_configured')
    }
    const files = ctxChangedFiles(ctx)
    const tests = targetedTests(ctx.repoDir, files, ctx.profile)
    const reasons = []
    const skipped = []
    let ran = 0
    for (const entry of entries) {
      if (entry.when && !files.some(f => matchesAny(f, [entry.when]))) continue
      // Scope {changed_files} to the files this command's `when` glob actually
      // matches, so e.g. `rubocop {changed_files}` (when **/*.rb) never receives
      // a .md/.json path from a mixed changeset (a real pilot failure).
      const scoped = entry.when ? files.filter(f => matchesAny(f, [entry.when])) : files
      // Same for {targeted_specs}: a mixed-language subtask resolves specs for
      // BOTH languages, and handing the whole union to every matching command
      // makes `rspec` choke on a .test.js path (and `jest` on a _spec.rb one) —
      // a real pilot failure that blocked advance on green work. Extension-style
      // globs (**/*.rb, **/*.js) scope specs correctly because a spec shares its
      // subject's extension. Directory-style globs (app/**) match no spec under
      // spec/**, so scoping would empty the list and silently skip the command —
      // fall back to the full set there, preserving the previous behavior.
      const scopedTests = entry.when ? tests.filter(f => matchesAny(f, [entry.when])) : tests
      const testsForCmd = scopedTests.length ? scopedTests : tests
      const resolved = substitute(entry.run, { files: scoped, tests: testsForCmd })
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
      // A developer-declared N/A slot (declare-na) only re-labels this exact
      // outcome — a no-target skip — to the quiet kind, so a dependency-bump
      // run stops re-explaining the same skip at every gate. It never applies
      // to a coverage gap (needsSpecs above) or a red check (reasons above).
      const na = ctx.state?.slots_na?.[slot]
      if (na) {
        return skip(`slot '${slot}': declared not-applicable for this run ("${na}") and resolved to no target — skipped quietly`, 'declared_na')
      }
      return skip(`slot '${slot}': not applicable to this change — the changed files map to no ${slot} target (${skipped.join('; ') || 'no matching files'}). Expected for config/view/spec-only changes; recorded as UNVERIFIED for the audit trail, not a coverage gap. Run a broader check yourself if the change warrants it.`, 'no_target')
    }
    return ok()
  },

  // Deterministic secret scan over what the branch ADDS (committed diff +
  // working tree + new untracked files, minus the ambient baseline). A pilot
  // run reached the PR gate with a real support address as a committed config
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
    for (const f of ctxUntrackedFiles(ctx)) {
      if (ambient.has(f)) continue
      const abs = path.join(ctx.repoDir, f)
      try {
        // Bound the scan: an oversized or binary run-created file (log, dump,
        // sqlite) is not scannable text — the boundary check owns those.
        if (fs.statSync(abs).size > MAX_SECRET_SCAN_BYTES) continue
        const content = fs.readFileSync(abs, 'utf8')
        if (content.slice(0, 8192).includes('\0')) continue
        for (const line of content.split('\n')) scanLine(f, line)
      } catch { /* unreadable — the boundary check owns unexpected files */ }
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
    const planRel = artifactFor(ctx.config, '-plan.md')
    if (!planRel) return fail(`cannot enforce the write boundary: no stage in pipeline.yml outputs a '-plan.md' artifact`)
    const artifact = parseArtifact(artifactAbs(ctx, planRel))
    if (!artifact) return fail(`cannot enforce the write boundary: plan artifact not found — the plan stage must complete first`)
    const declared = pathsInSection(sections(artifact.body)['Affected files'] ?? '').map(p => p.path)
    if (declared.length === 0) return fail(`the plan's '## Affected files' section lists no paths — the write boundary cannot be derived`)
    // The approved plan is frozen; a legitimate widening lands as an appended
    // amendment (`pipeline amend-boundary`), so the boundary is the union.
    const affected = [...new Set([...declared, ...boundaryAmendments(artifact.body)])]
    // Boundary enforcement DOES want untracked files: a run's brand-new file that
    // isn't committed yet is still an out-of-plan write we must catch.
    const files = ctxChangedFiles(ctx, { includeUntracked: true })
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
    const outOfPlan = []
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
        outOfPlan.push(file)
        reasons.push(`working tree touches ${file}, which is outside the approved plan's '## Affected files' — revert it, or, if the change genuinely needs this file, widen the boundary on the record: 'pipeline amend-boundary ${file} --reason "<why this file is needed>"' (it appends to the plan's '## Amendments' and is audit-logged; the developer sees it at the gate)`)
      }
    }
    // The wrong-base signature, named at the moment it hurts. A run based on the
    // trunk while its work stacks on a feature branch reports every file in that
    // branch as out-of-plan — hundreds of reasons, none of them this run's doing,
    // and a reader who does not already know this failure mode reads it as "my
    // change is wildly out of scope". start_sha is what makes the distinction
    // decidable: a file that has not changed since the run began was not touched
    // by this run, whatever the diff against the base says.
    const preexisting = untouchedSinceStart(ctx, outOfPlan)
    if (preexisting.length) {
      reasons.push(`BASE CHECK — ${preexisting.length} of the ${outOfPlan.length} out-of-plan file(s) above have not changed since this run started; this run did not touch them. They differ from the run base ('${ctx.state?.git?.base}') because that base is behind the branch this work sits on. Fix the base, not the files: 'pipeline set-base <the branch this run stacks on>'. Then re-run 'pipeline advance' — most of the reasons above should disappear. (Examples: ${preexisting.slice(0, 3).join(', ')}.)`)
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // Every acceptance criterion agreed at CONTEXT must be accounted for in the
  // test report — mapped to a test in '## Risk-to-test map' or explicitly
  // parked in '## Deferred' (never silently dropped). Was prose-only in the
  // QA prompt before; a dropped criterion is a guaranteed "wait, it doesn't
  // do X" round after merge.
  ac_traceability(ctx) {
    const contextRel = artifactFor(ctx.config, '-context.md')
    if (!contextRel) return fail(`cannot check acceptance-criteria coverage: no stage in pipeline.yml outputs a '-context.md' artifact`)
    const context = parseArtifact(artifactAbs(ctx, contextRel))
    if (!context) return fail(`cannot check acceptance-criteria coverage: context artifact not found`)
    const ids = acceptanceCriteriaIds(context.body)
    if (ids.length === 0) {
      return fail(`the context artifact's '## Acceptance criteria' has no numbered rows — number them (| # | Criterion | Verified by |); the ids are the traceability keys the test report must reference as AC#<n>`)
    }
    const rel = ctx.stageDef.output
    const report = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!report) return fail(`artifact ${rel} does not exist yet`)
    const secs = sections(report.body)
    const { missing } = acAccounting(ids, secs['Risk-to-test map'] ?? '', secs['Deferred'] ?? '')
    const reasons = missing.map(n =>
      `acceptance criterion AC#${n} is not accounted for in ${rel} — add a '## Risk-to-test map' row naming the test that proves it (or 'not tested because <reason>'), or park it under '## Deferred'; criteria are never silently dropped`)
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // A pilot-observed class of plan defect, as an exit code: `advance` gates every
  // subtask on green targeted tests, so a breaking change and the spec that
  // adapts to it MUST land in the same subtask — split them and the breaking
  // subtask can never pass its own gate. Requires each subtask to declare its
  // slice of '## Affected files'; checks the slices partition the boundary.
  subtask_coupling(ctx) {
    const planRel = artifactFor(ctx.config, '-plan.md')
    if (!planRel) return fail(`cannot check subtask coupling: no stage in pipeline.yml outputs a '-plan.md' artifact`)
    const artifact = parseArtifact(artifactAbs(ctx, planRel))
    if (!artifact) return fail(`cannot check subtask coupling: plan artifact not found — the plan stage must complete first`)
    const secs = sections(artifact.body)
    const subtasks = parseSubtaskFiles(secs['Subtasks'] ?? '')
    if (subtasks.length === 0) {
      return fail(`the plan's '## Subtasks' section declares no subtasks with Files — write it as a table (# | Subtask | Files) where Files is each subtask's slice of '## Affected files' (backticked paths); the coupling check gates on it`)
    }
    const affected = new Set(pathsInSection(secs['Affected files'] ?? '').map(p => p.path))
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
        if (!affected.has(f)) {
          reasons.push(`subtask ${st.n} lists ${f}, which is not in '## Affected files' — the write boundary and the subtasks must agree; add it there or remove it here`)
        }
      }
    }
    for (const p of affected) {
      if (!claimedBy.has(p)) reasons.push(`'## Affected files' lists ${p} but no subtask claims it — add it to the Files of the subtask that changes it (or drop it from the plan)`)
    }
    // The load-bearing check: a source file's mapped spec must not live in a
    // DIFFERENT subtask — that split is exactly what aborted a pilot run.
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

  // ── Evidence discipline ───────────────────────────────────────────────────
  // A pipeline artifact is a pile of CLAIMS; a reviewer arrives with EVIDENCE.
  // The PR review round is where the two finally meet, so the round count
  // tracks the number of unproven claims — a quantity code quality does not
  // bound. Measured on two pilot PRs: 23 reviewer findings, and the blockers
  // were never "this line is wrong" but "this is coupled to something outside
  // your diff" — a sibling code path, a downstream reader, a framework-implicit
  // scope, state persisted for the NEXT run, rows already in production.
  // These validators make the artifact's own claims falsifiable at the gate.

  // Re-runs the search command each evidence row records and compares the hit
  // count against the number the row declares. A claim that cannot survive its
  // own command is not evidence — and a count that has drifted since it was
  // written means the ground moved under the claim.
  evidence_verified(ctx, sectionName) {
    const rel = ctx.stageDef.output
    if (!rel) return fail(`stage ${ctx.stageName} has an 'evidence_verified' validator but no output artifact — fix pipeline.yml`)
    const artifact = parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const section = sections(artifact.body)[sectionName]
    if (section === undefined) return fail(`artifact ${rel} has no '## ${sectionName}' section — add it`)

    // Honest escape hatch: a change really can couple to nothing, but saying so
    // costs a reason. A bare "None." would let the expensive section be skipped
    // by reflex, which is the failure this validator exists to prevent.
    const none = section.match(/^none\b[\s—:-]*(.*)$/is)
    if (none) {
      return none[1].trim().length >= 12
        ? ok()
        : fail(`'## ${sectionName}' in ${rel} says "None" without a reason — write 'None — <why this change couples to nothing outside its own diff>' (a reason, not a full stop). If you cannot write that sentence honestly, the section is not empty.`)
    }

    const rows = evidenceRows(section)
    if (rows.length === 0) {
      return fail(`'## ${sectionName}' in ${rel} records no evidence rows — write it as a table (Subject | Evidence command | Hits | Disposition) where the command is a read-only search (git grep / grep / rg) and Hits is the number of lines it prints. The gate RE-RUNS each command and compares.`)
    }
    const reasons = []
    for (const { subject, command, hits, disposition, line } of rows) {
      const where = subject || `row ${line}`
      if (!command) {
        reasons.push(`'## ${sectionName}' row "${where}" in ${rel} carries no backticked evidence command — every row states how it was checked, as a read-only search (git grep / grep / rg) in a \`backticked\` cell`)
        continue
      }
      const argv = evidenceArgv(command)
      if (!argv) {
        reasons.push(`'## ${sectionName}' row "${where}" records \`${command}\`, which is not a re-runnable read-only search — the gate re-runs it, so it must start with 'git grep', 'grep' or 'rg' and carry no shell operators (no |, ;, &&, $(), >)`)
        continue
      }
      if (hits == null) {
        reasons.push(`'## ${sectionName}' row "${where}" declares no Hits count — record the number of lines \`${command}\` prints (0 is a real, useful answer: it is how you prove nothing else writes this)`)
        continue
      }
      if (!disposition) {
        reasons.push(`'## ${sectionName}' row "${where}" has an empty Disposition — say what the hits MEAN for this change: 'safe because …', 'handled in this diff', or 'out of scope because …'. An undispositioned hit is an unread caller.`)
        continue
      }
      const result = runEvidence(ctx.repoDir, argv)
      if (result.error) {
        reasons.push(`'## ${sectionName}' row "${where}": the gate could not re-run \`${command}\` — ${result.error}. Record a command that runs from the repo root.`)
        continue
      }
      if (result.hits !== hits) {
        reasons.push(`'## ${sectionName}' row "${where}" declares ${hits} hit(s) for \`${command}\`, but re-running it now prints ${result.hits}. Either the count was never taken from the command, or the code moved since — re-run it, re-read the hits, and re-check the disposition against what it returns NOW.`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // Every acceptance criterion needs a test that has been SEEN to fail without
  // the fix. A green suite proves the tests pass, not that they would notice
  // the bug coming back: on a pilot PR the reviewer deleted a load-bearing call
  // and the suite stayed green, which is how a shipped fix reads as covered
  // while pinning nothing. The stamp makes the proof expire when the code under
  // test changes, so a later fix round cannot inherit an earlier round's proof.
  ac_proofs(ctx) {
    const contextRel = artifactFor(ctx.config, '-context.md')
    const context = contextRel && parseArtifact(artifactAbs(ctx, contextRel))
    if (!context) return fail(`cannot check acceptance-criteria proofs: context artifact not found`)
    const ids = acceptanceCriteriaIds(context.body)
    if (ids.length === 0) return ok() // ac_traceability owns the "no criteria" failure — one voice per defect

    const rel = ctx.stageDef.output
    const report = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!report) return fail(`artifact ${rel} does not exist yet`)
    const proofs = report.frontmatter?.proofs
    if (!Array.isArray(proofs)) {
      return fail(`artifact ${rel} frontmatter needs a proof ledger — proofs: [{ ac: 1, test: '<the test that proves it>', mutation: '<what you broke to see it go red>' }, …]. For each criterion: break the fix, watch the mapped test go RED, restore it, watch it go GREEN, and record what you broke. A criterion whose test never went red is untested, whatever the coverage report says.`)
    }
    const reasons = []
    const proved = new Set()
    proofs.forEach((p, i) => {
      const n = typeof p?.ac === 'number' ? p.ac : parseInt(String(p?.ac ?? '').replace(/^AC[#-]?/i, ''), 10)
      if (!Number.isInteger(n)) {
        reasons.push(`proofs[${i}] in ${rel} names no acceptance criterion — set 'ac: <n>' matching a numbered row in the context's '## Acceptance criteria'`)
        return
      }
      if (!ids.includes(n)) {
        reasons.push(`proofs[${i}] in ${rel} claims AC#${n}, which is not a numbered criterion in the context artifact — correct the id`)
        return
      }
      if (!String(p.test || '').trim()) {
        reasons.push(`the proof for AC#${n} in ${rel} names no test — record the test that goes red, as path:line`)
        return
      }
      if (!String(p.mutation || '').trim()) {
        reasons.push(`the proof for AC#${n} in ${rel} records no mutation — state exactly what you broke to make the test fail ("reverted the guard at app/x.rb:41"). Without it nobody can re-run the proof, which is how proofs quietly rot.`)
        return
      }
      proved.add(n)
    })

    const deferred = sections(report.body)['Deferred'] ?? ''
    for (const n of ids) {
      if (proved.has(n)) continue
      if (acRef(n).test(deferred)) continue
      reasons.push(`acceptance criterion AC#${n} has no proof in ${rel} — add a 'proofs:' entry recording the test you watched go RED without the fix, or park AC#${n} under '## Deferred' with the reason. A criterion mapped to a test that was never seen to fail is a coverage claim, not coverage.`)
    }

    // Staleness: the ledger is evidence about one state of the code under test.
    const stamp = report.frontmatter?.proof_stamp
    const planRel = artifactFor(ctx.config, '-plan.md')
    const plan = planRel && parseArtifact(artifactAbs(ctx, planRel))
    const affected = plan ? pathsInSection(sections(plan.body)['Affected files'] ?? '').map(p => p.path) : []
    if (affected.length > 0 && proved.size > 0) {
      const current = proofStamp(ctx.repoDir, affected)
      if (!stamp) {
        reasons.push(`artifact ${rel} frontmatter needs 'proof_stamp: ${current}' — run 'pipeline proof-stamp' right after the last proof and paste what it prints. The stamp is what makes the ledger expire when the code under test changes; without it a later fix round silently inherits an earlier round's proof.`)
      } else if (String(stamp).trim() !== current) {
        reasons.push(`the proof ledger in ${rel} is STALE — it was stamped ${stamp}, but the code under test now hashes to ${current}. Something in the plan's '## Affected files' changed after the proofs were recorded, so none of them is evidence about the code you are about to ship. Re-run every proof (break it, see red, restore, see green), then re-stamp with 'pipeline proof-stamp'.`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // Every criterion declares WHICH POPULATION it is about. The most expensive
  // pilot defect was a fix that repaired the writer and left every existing row
  // broken — locally correct, ~20% of the actual job, and the criterion never
  // failed because it was written about the mechanism instead of the world.
  ac_population(ctx) {
    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const section = sections(artifact.body)['Acceptance criteria'] ?? ''
    const reasons = []
    let seen = 0
    for (const line of section.split('\n')) {
      const cells = tableCells(line)
      if (!cells || !/^\d+$/.test(cells[0] ?? '')) continue
      seen++
      const n = cells[0]
      const population = (cells[3] ?? '').toLowerCase()
      if (!population) {
        reasons.push(`acceptance criterion AC#${n} declares no Population — add the 4th column (# | Criterion | Verified by | Population) and answer one of: new (only records created after this ships) / existing (rows already out there) / both / n-a. The question "what about the rows that are already broken?" is the one that turns a partial fix into a shipped fix.`)
        continue
      }
      if (!/\b(new|existing|both|n-?\/?a)\b/.test(population)) {
        reasons.push(`acceptance criterion AC#${n} declares population '${cells[3]}', which is not one of: new / existing / both / n-a. Pick the vocabulary term so the plan and QA can act on it.`)
      }
    }
    if (seen === 0) {
      return fail(`the context artifact's '## Acceptance criteria' has no numbered table rows — write it as | # | Criterion | Verified by | Population |, numbered from 1`)
    }
    return reasons.length ? { ok: false, reasons } : ok()
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
// `checks` carries the per-validator verdict so a caller can tell WHICH
// validator produced a reason. `advance` ignores it (a failure is a failure);
// `check` (the dry run) needs it to separate real work from the
// finalization-only stamp an in-progress artifact legitimately lacks.
export function runValidators(ctx) {
  const spec = ctx.stageDef.validate || []
  const reasons = []
  const unverified = []
  const checks = []
  for (const item of spec) {
    // A list item is either a bare validator name (- no_secrets) or a
    // name→param map (- profile_command: lint_changed). Only validators that
    // actually consume a param take one — a param on the others is not
    // accepted, so pipeline.yml can never carry decorative config.
    const [name, param] = typeof item === 'string' ? [item] : Object.entries(item)[0]
    const fn = validators[name]
    if (!fn) {
      const reason = `pipeline.yml names unknown validator '${name}'`
      reasons.push(reason)
      checks.push({ name, param, status: 'fail', reasons: [reason] })
      continue
    }
    const result = fn(ctx, param)
    if (result.skip) {
      unverified.push({ text: `${ctx.stageName}/${name}: ${result.reason}`, kind: result.kind || 'other' })
      checks.push({ name, param, status: 'skip', reasons: [result.reason] })
    } else if (!result.ok) {
      reasons.push(...result.reasons)
      checks.push({ name, param, status: 'fail', reasons: result.reasons })
    } else {
      checks.push({ name, param, status: 'pass', reasons: [] })
    }
  }
  return { ok: reasons.length === 0, reasons, unverified, checks }
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

// Untracked files larger than this are not scannable text (logs, dumps,
// sqlite) — no_secrets skips them; the boundary check owns unexpected files.
const MAX_SECRET_SCAN_BYTES = 1024 * 1024

// Per-subtask file claims from '## Subtasks'. Accepts a table row
// (| 1 | title | `a`, `b` |) or a numbered list item (1. title — `a`, `b`);
// lines without a leading number attach their paths to the current subtask.
// Paths are extracted by the same shared rule as '## Affected files'
// (backtickPaths) — subtask_coupling compares those two sets against each
// other, so they must never parse differently.
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
    current.files.push(...backtickPaths(line))
  }
  return subtasks
}

// Cells of one markdown table row, or null if the line is not a row. The
// separator row (|---|---|) is a row shape but carries no data.
function tableCells(line) {
  const t = line.trim()
  if (!t.startsWith('|')) return null
  if (/^\|[-\s|:]+\|?$/.test(t)) return null
  // Split on unescaped pipes only. An alternation inside a search pattern
  // (`git grep -nE 'a\|b'`) is markdown-escaped like any other literal pipe in a
  // cell; splitting on it blindly would chop the command in half and report the
  // row as malformed, which pushes authors toward weaker patterns.
  return t.replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(c => c.replace(/\\\|/g, '|').trim())
}

// Evidence rows: Subject | Evidence command | Hits | Disposition. The header
// row is the first row carrying no backticked command — dropped, not parsed.
function evidenceRows(text) {
  const rows = []
  text.split('\n').forEach((line, i) => {
    const cells = tableCells(line)
    if (!cells || cells.length < 2) return
    const command = (cells[1].match(/`([^`]+)`/) || [])[1] ?? null
    const hitsCell = (cells[2] ?? '').trim()
    const hits = /^\d+$/.test(hitsCell) ? parseInt(hitsCell, 10) : null
    const subject = cells[0].replace(/`/g, '').trim()
    // Header row: no command, and the column label where a count belongs.
    if (!command && /^(hits?|count|n)$/i.test(hitsCell)) return
    rows.push({ subject, command, hits, disposition: cells.slice(3).join(' ').trim(), line: i + 1 })
  })
  return rows
}

// Read-only searches only. The gate RE-RUNS what the artifact recorded, so the
// command must be incapable of changing anything — and it is parsed into argv
// and executed without a shell, which makes metacharacters inert rather than
// merely discouraged.
const EVIDENCE_PREFIXES = [['git', 'grep'], ['grep'], ['rg']]
const SHELL_OPERATORS = /[|;&><`$(){}]/

function tokenizeCommand(cmd) {
  const tokens = []
  for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) tokens.push(m[1] ?? m[2] ?? m[3])
  return tokens
}

// Exported as the ONE definition of "a command this pipeline is willing to
// re-run on the developer's behalf" — the Coupling gate re-runs it, and a
// knowledge fact's probe is offered to the planner to run. Both must mean the
// same thing, or a probe could be accreted that the gate then refuses.
export const readOnlySearchArgv = cmd => evidenceArgv(cmd)

function evidenceArgv(cmd) {
  // Operators are checked OUTSIDE quotes only: `git grep -n 'a|b'` is a regex,
  // not a pipeline, and refusing it would push authors toward weaker patterns.
  const unquoted = cmd.replace(/"[^"]*"|'[^']*'/g, '')
  if (SHELL_OPERATORS.test(unquoted)) return null
  const argv = tokenizeCommand(cmd)
  if (argv.length === 0) return null
  return EVIDENCE_PREFIXES.some(p => p.every((tok, i) => argv[i] === tok)) ? argv : null
}

function runEvidence(repoDir, argv) {
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      cwd: repoDir, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, stdio: 'pipe'
    })
    return { hits: countLines(out) }
  } catch (e) {
    // The grep family exits 1 for "no match". That is a RESULT, not a failure —
    // and the most valuable one there is: it is how a claim of absence ("no
    // other writer touches this column") gets proved instead of asserted.
    if (e.status === 1) return { hits: 0 }
    return { error: (e.stderr || e.message || '').trim().split('\n')[0] || `exit ${e.status ?? '?'}` }
  }
}

const countLines = out => out.split('\n').filter(l => l !== '').length

// Of the given files, the ones identical to how they stood when the run began —
// i.e. the run demonstrably did not touch them, committed or not. Empty (no
// claim made) when the run has no recorded start point or git refuses: a
// diagnostic that guesses is worse than one that stays quiet.
function untouchedSinceStart(ctx, files) {
  const start = ctx.state?.git?.start_sha
  if (!start || files.length === 0) return []
  try {
    // No pathspec: one call, and no argv-length risk when the wrong base has
    // produced hundreds of out-of-plan paths — which is exactly the case this
    // diagnostic is for.
    const changed = new Set(
      execFileSync('git', ['diff', '--name-only', start], { cwd: ctx.repoDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        .split('\n').map(f => f.trim()).filter(Boolean)
    )
    // An untracked file is invisible to `git diff`, so it would read as
    // "unchanged since the run began" when in fact the run just created it.
    // Ambient untracked files were filtered out by the caller; whatever is
    // untracked here is the run's own work.
    const untracked = new Set(ctxUntrackedFiles(ctx))
    return files.filter(f => !changed.has(f) && !untracked.has(f))
  } catch {
    return []
  }
}

const ok = () => ({ ok: true })
const fail = reason => ({ ok: false, reasons: [reason] })
// kind is a persisted protocol (events.jsonl) — unknown kinds are normalized
// to 'other' rather than frozen misclassified on disk.
const skip = (reason, kind = 'other') => ({ skip: true, reason, kind: SKIP_KINDS.includes(kind) ? kind : 'other' })
const lastLines = (s, n) => s.trim().split('\n').slice(-n).join('\n')
