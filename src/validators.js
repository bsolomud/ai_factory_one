import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { acAccounting, acceptanceCriteriaIds, acRef, backtickPaths, boundaryAmendments, humanPart, parseArtifact, sections, pathsInSection } from './artifacts.js'
import { artifactFor } from './config.js'
import { proofStamp } from './scan.js'
import { isStacked } from './basehealth.js'
import { changedFiles, isTestFile, matchesAny, REQUIRED_SLOTS, resolveSlot, sourceFilesNeedingSpecs, substitute, targetedTests, untrackedFiles } from './profile.js'
import { readEvents, SKIP_KINDS } from './state.js'

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

// no_touch exemptions recorded by `pipeline allow-touch` (read from the audit
// log, which only the CLI writes). A file is exempt while its working-tree
// content still equals what the authorized commit left — the exemption covers
// the developer's change, never an edit made on top of it.
function touchExemptions(ctx) {
  const shas = new Map()
  for (const e of readEvents(ctx.runDir)) {
    if (e.event !== 'touch_allowed' || !e.commit) continue
    for (const p of e.paths || []) shas.set(p, [...(shas.get(p) || []), e.commit])
  }
  return file => (shas.get(file) || []).some(sha => {
    try {
      execFileSync('git', ['diff', '--quiet', sha, '--', file], { cwd: ctx.repoDir, stdio: 'pipe' })
      return true
    } catch {
      return false // differs from the authorized content, or the commit is gone
    }
  })
}

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

  // A stacked run asks its base's own CI before calling a failure
  // pre-existing. A pilot run: 45 failures inherited from a red base were logged
  // as "pre-existing" untied to the base, then re-diagnosed from scratch at CI.
  // Runs on the trunk owe nothing; an UNKNOWN answer is an answer.
  base_health(ctx) {
    const trunk = ctx.profile?.conventions?.base_branch || 'master'
    const base = ctx.state?.git?.base
    if (!isStacked(base, trunk)) return ok()
    const last = readEvents(ctx.runDir).filter(e => e.event === 'base_health').at(-1)
    if (!last || last.base !== base) {
      return fail(`this run stacks on '${base}', not '${trunk}' — run 'pipeline base-health' and read it before classifying any failing test as pre-existing: a red base explains failures this change did not cause`)
    }
    if (last.verdict !== 'RED') return ok()
    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    const section = artifact && sections(artifact.body)['Base health']
    if (!section) {
      return fail(`the base '${base}' is red on its own CI — add '## Base health' to ${rel}: which failures also fail on the base (with the CI link), so they read as "base red", not as this change`)
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

  // Review until a round comes back clean, not until nothing is "blocking".
  // A pilot run: the pre-PR reviewer found a 500 on invalid UTF-8, filed it as
  // "advisory, pre-existing", and the gate let it through — it was the PR
  // reviewer's first comment. Measured 2026-10-29: the developer whose PRs
  // merge without comments runs a review → fix → fresh review loop until a
  // round finds nothing, with the same grader that later reviews ours. So the
  // last pre-PR round must close with no finding left standing: each is fixed
  // (and a fresh round confirms it), refuted (--rejected), or deferred by the
  // developer with a sentence the PR carries (--deferred, deferred_in_pr).
  review_converged(ctx) {
    const events = readEvents(ctx.runDir)
    const opened = events.filter(e => e.event === 'round_opened')
    if (!opened.length) {
      return fail(`no review round is recorded — 'pipeline round open pre-pr', record each finding with 'pipeline finding', then 'pipeline round close'`)
    }
    const last = opened.at(-1)
    if (last.source !== 'pre-pr') {
      return fail(`the latest round is round ${last.n} (${last.source} feedback) — the code changed since the last pre-PR review. Open a fresh one ('pipeline round open pre-pr') with a new reviewer over the whole diff`)
    }
    if (!events.some(e => e.event === 'round_closed' && e.n === last.n)) {
      return fail(`review round ${last.n} is still open — record its findings, then 'pipeline round close'`)
    }
    // The latest record of a finding wins: the developer's later --deferred, or
    // a refutation, settles one recorded earlier in the same round.
    const latest = new Map()
    for (const e of events.filter(e => e.event === 'finding_recorded' && e.round === last.n)) latest.set(normClaim(e.summary), e)
    const standing = [...latest.values()].filter(e => !['rejected', 'deferred'].includes(e.disposition))
    if (!standing.length) return ok()
    return fail(`review round ${last.n} closed with ${standing.length} finding(s) still standing — advisory and pre-existing ones included, because the PR reviewer will raise them all: ${standing.map(f => `"${f.summary.slice(0, 90)}"`).join('; ')}. Fix them and run a fresh review round until one comes back clean (a nit's fix in a round of its own). A finding that is not real: record it again with the same --summary, --round ${last.n} and --rejected. One the developer chooses to leave: the same, with --deferred "<plain sentence for the PR>"`)
  },

  // A pilot run: the test report said "not tested because it is accepted
  // behaviour" about what a single-user sync does; REVIEW re-read the code,
  // agreed, and the PR body repeated the claim. It was wrong, and the developer
  // found it after the CI gate. A row the test report leaves untested is a claim
  // about behaviour, and REVIEW is the last pair of eyes before a reviewer reads
  // it as fact. So each one gets a row in '## Untested claims': a test file
  // that shows the behaviour, or 'Not verified' plus a plain sentence the PR
  // must carry (untested_in_pr). Never a block on the claim being unproven —
  // only on it being unaccounted for.
  untested_claims(ctx) {
    const reportRel = artifactFor(ctx.config, '-test-report.md')
    const report = reportRel && parseArtifact(artifactAbs(ctx, reportRel))
    if (!report) return ok() // no test report, no untested rows to account for
    const map = tableRows(sections(report.body)['Risk-to-test map'])
    const riskCol = 0
    const coverageCol = columnIndex(map.header, /coverage/, map.header.length - 1)
    const untested = map.rows
      .filter(r => /^\s*not tested/i.test(r[coverageCol] ?? ''))
      .map(r => r[riskCol] ?? '')
      .filter(Boolean)
    if (!untested.length) return ok()

    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const section = sections(artifact.body)['Untested claims']
    const shape = `| Claim | Proof | PR note | — Claim: the test report's Risk cell, same wording; Proof: the repo-relative path of a test file you ran that shows the behaviour (e.g. \`spec/models/x_spec.rb:12\`), or 'Not verified'; PR note: for 'Not verified', one plain sentence for the PR's 'Testing notes', copied there word for word`
    if (section === undefined) {
      return fail(`${reportRel} leaves ${untested.length} row(s) 'not tested', and each is a claim a PR reviewer will read as fact. Add '## Untested claims' under '# Pipeline details' in ${rel}: ${shape}. Check each claim against the code by RUNNING something, not by reading.`)
    }
    const claims = tableRows(section)
    const proofCol = columnIndex(claims.header, /proof/, 1)
    const noteCol = columnIndex(claims.header, /note/, 2)
    const reasons = []
    for (const risk of untested) {
      const row = claims.rows.find(r => normClaim(r[0] ?? '').includes(normClaim(risk)))
      if (!row) {
        reasons.push(`'## Untested claims' has no row for "${risk.slice(0, 100)}" (${reportRel}: not tested). Add it: ${shape}`)
        continue
      }
      const proof = (row[proofCol] ?? '').trim()
      if (/^not verified/i.test(proof)) {
        if (!(row[noteCol] ?? '').replace(/[—–-]/g, '').trim()) {
          reasons.push(`"${risk.slice(0, 80)}" is 'Not verified' but has no PR note — write one plain sentence the PR's 'Testing notes' will carry, so the PR reviewer knows this was not checked`)
        }
        continue
      }
      const tests = backtickPaths(proof).filter(p => isTestFile(p, ctx.profile) && fs.existsSync(path.join(ctx.repoDir, p)))
      if (!tests.length) {
        reasons.push(`"${risk.slice(0, 80)}": Proof must name an existing test file by its repo-relative path in backticks (got "${proof.slice(0, 80)}"), or say 'Not verified' and give a PR note. Reading the code is not proof — a pilot run's false claim survived exactly that.`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // Every decision the developer reversed is stated in the PR draft, in the
  // words recorded with it (a pilot run: the PR body described the
  // reversed behaviour for a whole review round).
  decisions_current(ctx) {
    const changes = readEvents(ctx.runDir).filter(e => e.event === 'decision_changed')
    if (!changes.length) return ok()
    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const body = normClaim(artifact.body)
    const reasons = changes
      .filter(c => !body.includes(normClaim(c.now)))
      .map(c => `the developer changed a decision ("${c.was}" → "${c.now}"), but ${rel} does not say "${c.now}" — state the new decision in the Description word for word, and remove what still describes the old one`)
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // A PR opened before a decision changed still carries the old description
  // until it is re-published; 'pipeline pr-opened' after the body update is
  // the record that it was.
  pr_body_current(ctx) {
    const events = readEvents(ctx.runDir)
    const lastPr = events.findLastIndex(e => e.event === 'pr_opened')
    if (lastPr === -1) return ok()
    const stale = events.slice(lastPr + 1).filter(e => e.event === 'decision_changed')
    if (!stale.length) return ok()
    const n = events[lastPr].number
    return fail(`PR #${n} was published before the developer changed ${stale.length === 1 ? 'a decision' : `${stale.length} decisions`} (${stale.map(c => `"${c.was}" → "${c.now}"`).join('; ')}) — its body still describes the old one. Update it from the approved draft ('gh pr edit ${n} --body-file …'), then 'pipeline pr-opened ${events[lastPr].url || n}'.`)
  },

  // A finding the developer left unfixed is stated in the PR draft, in the
  // sentence recorded with it — the PR reviewer reads it from the author.
  deferred_in_pr(ctx) {
    const notes = readEvents(ctx.runDir).filter(e => e.event === 'finding_recorded' && e.disposition === 'deferred' && e.pr_note)
    if (!notes.length) return ok()
    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const body = normClaim(artifact.body)
    const reasons = [...new Set(notes.map(n => n.pr_note))]
      .filter(note => !body.includes(normClaim(note)))
      .map(note => `a review finding was left unfixed on the developer's call, but ${rel} does not say so — put this under 'Reviewer guidance', word for word: "${note}"`)
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // The PR half of untested_claims: every 'Not verified' claim's PR note
  // appears in the PR draft's 'Testing notes', word for word.
  untested_in_pr(ctx) {
    const reviewRel = artifactFor(ctx.config, '-review.md')
    const review = reviewRel && parseArtifact(artifactAbs(ctx, reviewRel))
    const section = review && sections(review.body)['Untested claims']
    if (!section) return ok()
    const claims = tableRows(section)
    const proofCol = columnIndex(claims.header, /proof/, 1)
    const noteCol = columnIndex(claims.header, /note/, 2)
    const notes = claims.rows
      .filter(r => /^\s*not verified/i.test(r[proofCol] ?? ''))
      .map(r => (r[noteCol] ?? '').trim())
      .filter(n => n.replace(/[—–-]/g, '').trim())
    if (!notes.length) return ok()
    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const testing = normClaim(sections(artifact.body)['Testing notes'] ?? '')
    const reasons = notes
      .filter(n => !testing.includes(normClaim(n)))
      .map(n => `'## Testing notes' in ${rel} must carry this sentence word for word (${reviewRel}, Untested claims — nobody ran a test for it): "${n}"`)
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // A pilot run: the first REVIEW agent "applied" the bound team review skill by
  // reading it and writing a generic review; the developer had to ask for a
  // real pass, which then found a blocking false claim. When the profile binds
  // a repo review skill, the review shows what it did with each step it ran:
  // '## Team skill trace' (| Step | What the skill asks | What I did |), every
  // 'What I did' citing a file:line or a command, the skill recorded as used,
  // and each skill file the trace cites recorded too.
  skill_trace(ctx) {
    const binding = ctx.profile?.bindings?.review
    if (binding?.source !== 'repo' || !binding.path) return ok()
    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const section = sections(artifact.body)['Team skill trace']
    const shape = `| Step | What the skill asks | What I did |, one row per step of \`${binding.path}\` you executed, each 'What I did' citing a \`file:line\` or a \`command\` you ran`
    if (section === undefined) {
      return fail(`this repo binds its own review skill (${binding.path}) — execute it, do not just read it. Add '## Team skill trace' under '# Pipeline details' in ${rel}: ${shape}`)
    }
    const trace = tableRows(section)
    if (!trace.rows.length) return fail(`'## Team skill trace' in ${rel} has no rows — ${shape}`)
    const reasons = []
    const didCol = columnIndex(trace.header, /did/, trace.header.length - 1)
    for (const row of trace.rows) {
      if (/verdict/i.test(row[0] ?? '')) continue // the verdict sums up the cited steps; it has nothing of its own to cite
      if (!/`[^`]+`/.test(row[didCol] ?? '')) {
        reasons.push(`'## Team skill trace' step "${(row[0] ?? '').slice(0, 60)}": 'What I did' cites nothing — name the \`file:line\` it was applied to or the \`command\` you ran`)
      }
    }
    const used = readEvents(ctx.runDir)
      .filter(e => e.event === 'asset_used' && e.kind === 'skill' && e.stage === 'REVIEW')
      .map(e => normRef(e.ref))
    const skillRef = normRef(binding.path)
    if (!used.some(u => u === skillRef || u.startsWith(skillRef + '/'))) {
      reasons.push(`the bound review skill was not recorded — run 'pipeline used skill ${binding.path}'`)
    }
    const skillDir = path.join(ctx.repoDir, binding.path)
    const cited = new Set()
    for (const line of section.split('\n')) {
      for (const m of line.matchAll(/`([^`\s]+\.md)(:\d+(-\d+)?)?`/g)) {
        const name = m[1].replace(/^\.\//, '')
        const inSkill = [path.join(skillDir, name), path.join(ctx.repoDir, name)]
          .find(p => p.startsWith(skillDir + path.sep) && fs.existsSync(p))
        if (inSkill) cited.add(path.relative(ctx.repoDir, inSkill))
      }
    }
    for (const file of cited) {
      const ref = normRef(file)
      if (!used.some(u => u === ref || ref.endsWith('/' + u) || u.endsWith('/' + path.basename(ref)))) {
        reasons.push(`the trace cites ${file} but it was not recorded — run 'pipeline used skill ${file}'`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
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
    const exempt = touchExemptions(ctx)
    const reasons = []
    const outOfPlan = []
    for (const file of files) {
      if (ambient.has(file)) continue
      if (matchesAny(file, noTouch)) {
        if (exempt(file)) continue
        reasons.push(`working tree touches ${file}, which matches a no_touch rule in the repo profile — revert this change; the pipeline must never modify it. If the developer explicitly asked for this change and it is committed: 'pipeline allow-touch --commit <sha> --reason "<what they asked for>"' exempts exactly that commit's content`)
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
    for (const { subject, command, rawCommand, hits, disposition, line } of rows) {
      const where = subject || `row ${line}`
      if (!command) {
        reasons.push(`'## ${sectionName}' row "${where}" in ${rel} carries no backticked evidence command — every row states how it was checked, as a read-only search (git grep / grep / rg) in a \`backticked\` cell`)
        continue
      }
      const readings = evidenceReadings(command, rawCommand)
      if (!readings.length) {
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
      const results = readings.map(argv => runEvidence(ctx.repoDir, argv))
      if (results.some(r => r.hits === hits)) continue
      const counted = [...new Set(results.filter(r => !r.error).map(r => r.hits))]
      if (!counted.length) {
        reasons.push(`'## ${sectionName}' row "${where}": the gate could not re-run \`${command}\` — ${results[0].error}. Record a command that runs from the repo root.`)
        continue
      }
      const reread = readings.length > 1 ? ` (read ${readings.length} ways, as the pattern's \`|\` is ambiguous: ${counted.join(' or ')})` : ` ${counted[0]}`
      reasons.push(`'## ${sectionName}' row "${where}" declares ${hits} hit(s) for \`${command}\`, but re-running it now prints${reread}. Either the count was never taken from the command, or the code moved since — re-run it, re-read the hits, and re-check the disposition against what it returns NOW. For an alternation, \`-e A -e B\` is unambiguous.`)
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
  //
  // The answer lives in '## Criteria population' (| # | Population |) below the
  // '# Pipeline details' marker, keyed by the criterion number — NOT as a column
  // of the criteria table. The criteria table is the developer's, written in
  // plain words; "population: both" is pipeline vocabulary and stays out of it.
  ac_population(ctx) {
    const rel = ctx.stageDef.output
    const artifact = rel && parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist yet`)
    const ids = acceptanceCriteriaIds(artifact.body)
    if (ids.length === 0) {
      return fail(`the context artifact's '## Acceptance criteria' has no numbered table rows — write it as | # | Now | After this ships | How to check |, numbered from 1`)
    }
    const section = sections(artifact.body)['Criteria population']
    if (section === undefined) {
      return fail(`artifact ${rel} has no '## Criteria population' section — add it under '# Pipeline details' as a table | # | Population |, one row per criterion, where Population is one of: new (only records created after this ships) / existing (rows already out there) / both / n-a. The question "what about the rows that are already broken?" is the one that turns a partial fix into a shipped fix.`)
    }
    const declared = new Map()
    for (const line of section.split('\n')) {
      const cells = tableCells(line)
      if (!cells || !/^\d+$/.test(cells[0] ?? '')) continue
      declared.set(parseInt(cells[0], 10), (cells[1] ?? '').trim())
    }
    const reasons = []
    for (const n of ids) {
      const population = declared.get(n)
      if (!population) {
        reasons.push(`acceptance criterion AC#${n} has no row in '## Criteria population' — add | ${n} | new / existing / both / n-a | and answer, out loud with the developer: what about the records that are already wrong?`)
        continue
      }
      if (!/\b(new|existing|both|n-?\/?a)\b/.test(population.toLowerCase())) {
        reasons.push(`acceptance criterion AC#${n} declares population '${population}', which is not one of: new / existing / both / n-a. Pick the vocabulary term so the plan and QA can act on it.`)
      }
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // The part of the artifact a developer reads — everything above the
  // '# Pipeline details' marker (the whole body when there is no marker). Three
  // pilot plans ran to 5-6k words with 3k+ words of prose before the first
  // table; the summary header we added on top of that changed nothing, because
  // the prose was written to win the critic, not to inform the reader. So the
  // budget is enforced: the named sections must sit above the marker and be
  // filled, the prose stays under HUMAN_WORD_BUDGET words, a table cell stays
  // under HUMAN_CELL_WORDS, and no line carries more than two bold spans.
  human_part(ctx, names) {
    const rel = ctx.stageDef.output
    if (!rel) return fail(`stage ${ctx.stageName} has a 'human_part' validator but no output artifact — fix pipeline.yml`)
    const artifact = parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist — create it from its template first`)
    const { human, hasMarker } = humanPart(artifact.body)
    const above = sections(human)
    const all = sections(artifact.body)
    const reasons = []
    for (const name of names ?? []) {
      if (name in above) {
        if (above[name] === '') reasons.push(`section '## ${name}' in ${rel} is empty — it is the part a developer reads; write it in plain words`)
      } else if (name in all) {
        reasons.push(`section '## ${name}' in ${rel} sits below the '# Pipeline details' marker — it is written for the developer, move it above the marker`)
      } else {
        reasons.push(`artifact ${rel} is missing the required section '## ${name}' — add it above the '# Pipeline details' marker, written for a developer who has never seen this pipeline`)
      }
    }
    const optional = new Set([...(names ?? []), HUMAN_OPTIONAL_SECTION])
    const pipelineSections = Object.keys(all).filter(n => !optional.has(n))
    if (!hasMarker && pipelineSections.length) {
      reasons.push(`artifact ${rel} has no '# Pipeline details' line — put one (on its own line, after the sections a developer reads) above every section that exists for the stage agents and the gates`)
    }
    const words = proseWordCount(human)
    if (words > HUMAN_WORD_BUDGET) {
      reasons.push(`the part of ${rel} above '# Pipeline details' runs to ${words} words of prose; the budget is ${HUMAN_WORD_BUDGET}. Cut it — a developer needs what changes and why, not the argument that got you there. Evidence, alternatives considered, and answers to the critic go below the marker`)
    }
    for (const { line, cell } of longCells(human)) {
      reasons.push(`a table cell above '# Pipeline details' in ${rel} runs to ${cell.split(/\s+/).length} words (line ${line}: "${cell.slice(0, 60)}…"); keep cells under ${HUMAN_CELL_WORDS} words — split the row or move the detail below the marker`)
    }
    for (const { line, text } of boldHeavyLines(human)) {
      reasons.push(`line ${line} of ${rel} carries more than two bold spans ("${text.slice(0, 60)}…") — bold one thing per line or nothing; emphasis everywhere is emphasis nowhere`)
    }
    return reasons.length ? { ok: false, reasons } : ok()
  },

  // No pipeline vocabulary in the part a developer reads. The words a stage
  // agent needs (criterion ids, population, coupling, critic rounds) all have a
  // home below '# Pipeline details'; above it, the reader is a junior developer
  // who has never opened this repo's pipeline and should not have to.
  plain_language(ctx) {
    const rel = ctx.stageDef.output
    if (!rel) return fail(`stage ${ctx.stageName} has a 'plain_language' validator but no output artifact — fix pipeline.yml`)
    const artifact = parseArtifact(artifactAbs(ctx, rel))
    if (!artifact) return fail(`artifact ${rel} does not exist — create it from its template first`)
    const { human } = humanPart(artifact.body)
    const reasons = []
    let inFence = false
    human.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return }
      if (inFence) return
      for (const { term, re } of PIPELINE_VOCABULARY) {
        if (re.test(line)) {
          reasons.push(`line ${i + 1} of ${rel} uses pipeline vocabulary '${term}' ("${line.trim().slice(0, 70)}") — rewrite it for a developer who has never seen this pipeline, or move the line below '# Pipeline details'`)
          break
        }
      }
    })
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
  return rawTableCells(t).map(c => c.replace(/\\\|/g, '|').trim())
}

// Cells as written, `\|` kept: in a code span it is ambiguous between the
// markdown escape and a BRE alternation the author actually ran.
function rawTableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
}

// A markdown table as { header (lowercased cells), rows } — the first row is
// the header; the separator row is skipped by tableCells.
function tableRows(text) {
  let header = null
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const cells = tableCells(line)
    if (!cells) continue
    if (!header) header = cells.map(c => c.toLowerCase())
    else rows.push(cells)
  }
  return { header: header ?? [], rows }
}

const columnIndex = (header, re, fallback) => {
  const i = header.findIndex(h => re.test(h))
  return i === -1 ? fallback : i
}

// Claims are matched on wording, ignoring markdown emphasis and spacing.
const normClaim = s => String(s).toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
const normRef = ref => String(ref).replace(/^\.\//, '').replace(/\/$/, '').replace(/\.md$/, '')

// Evidence rows: Subject | Evidence command | Hits | Disposition. The header
// row is the first row carrying no backticked command — dropped, not parsed.
function evidenceRows(text) {
  const rows = []
  text.split('\n').forEach((line, i) => {
    const cells = tableCells(line)
    if (!cells || cells.length < 2) return
    const command = (cells[1].match(/`([^`]+)`/) || [])[1] ?? null
    const rawCommand = ((rawTableCells(line)[1] ?? '').match(/`([^`]+)`/) || [])[1] ?? command
    const hitsCell = (cells[2] ?? '').trim()
    const hits = /^\d+$/.test(hitsCell) ? parseInt(hitsCell, 10) : null
    const subject = cells[0].replace(/`/g, '').trim()
    // Header row: no command, and the column label where a count belongs.
    if (!command && /^(hits?|count|n)$/i.test(hitsCell)) return
    rows.push({ subject, command, rawCommand, hits, disposition: cells.slice(3).join(' ').trim(), line: i + 1 })
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
  // A backslash-escaped character is literal to the shell too (`a\|b`).
  const unquoted = cmd.replace(/"[^"]*"|'[^']*'/g, '').replace(/\\./g, '')
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

// One recorded command, every reading of it an honest author could have run.
// A pilot run: `git grep -n "A\|B"` in a table cell — the markdown unescape turned
// the BRE alternation into a literal pipe and the gate counted 0. Another:
// `grep -rn "a|b"` counted 14 in the agent's shell (whose grep treats `|` as
// alternation) and 0 when re-run with the system grep. A row passes when ANY
// reading reproduces its count; it is still falsified when none does.
function evidenceReadings(command, rawCommand) {
  const readings = []
  const add = argv => {
    if (argv && !readings.some(r => r.join('\0') === argv.join('\0'))) readings.push(argv)
  }
  add(evidenceArgv(command))
  if (rawCommand && rawCommand !== command) add(evidenceArgv(rawCommand))
  for (const argv of [...readings]) {
    const at = argv[0] === 'git' ? 2 : 1
    const bre = argv[0] !== 'rg' && !argv.slice(at).some(a => /^-[a-zA-Z]*[EPFG]|^--(extended|perl|basic)-regexp$|^--fixed-strings$/.test(a))
    if (bre && argv.slice(at).some(a => /(?<!\\)\|/.test(a))) add([...argv.slice(0, at), '-E', ...argv.slice(at)])
  }
  return readings
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

// The developer-facing part of an artifact (see human_part / plain_language).
// One screen: 300 words of prose is what a reader takes in before scrolling,
// and 30 words is the longest a table cell stays a cell rather than a paragraph.
export const HUMAN_WORD_BUDGET = 300
export const HUMAN_CELL_WORDS = 30
export const HUMAN_OPTIONAL_SECTION = 'Questions for you'

// Words that mean something to a stage agent and nothing to a developer who
// has never opened the pipeline. Each has a home below '# Pipeline details'.
export const PIPELINE_VOCABULARY = [
  'BLUF', 'TL;DR', 'Needs you', 'AC#n', 'population', 'disposition', 'coupling',
  'critic', 'advisory', 'blocking', 'verdict', 'load-bearing', 'tripwire',
  'subtask', 'artifact', 'write boundary', 'blast radius', '§', 'substate',
  'UNVERIFIED', 'gate', 'stage', 'handoff', 'dispatcher', 'runbook'
].map(term => ({ term, re: vocabularyPattern(term) }))

function vocabularyPattern(term) {
  switch (term) {
    case 'TL;DR': return /\bTL;?DR\b/i
    case 'AC#n': return /\bAC[#-]?\d+\b/
    case '§': return /§/
    case 'advisory': return /\badvisor(y|ies)\b/i
    case 'subtask': return /\bsub-?tasks?\b/i
    case 'artifact': return /\bartifacts?\b/i
    case 'gate': return /\bgates?\b/i
    case 'stage': return /\b(CONTEXT|PLAN|BREAKDOWN|IMPLEMENT|TEST|REVIEW|SCRIBE)\b|\bstages?\b/
    case 'UNVERIFIED': return /\bUNVERIFIED\b/
    default: return new RegExp(`\\b${term.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i')
  }
}

// Prose words: lines that are not headings, table rows, or fenced code
// (a mermaid diagram is not prose). Markdown emphasis and list markers are
// stripped so the count is of words, not of markup.
function proseWordCount(text) {
  let inFence = false
  let words = 0
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue }
    if (inFence) continue
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('|')) continue
    const cleaned = line.replace(/^[-*>]+\s*|^\d+[.)]\s*/, '').replace(/[*_`]/g, '')
    words += cleaned.split(/\s+/).filter(Boolean).length
  }
  return words
}

function longCells(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    const cells = tableCells(line)
    if (!cells) return
    for (const cell of cells) {
      if (cell.split(/\s+/).filter(Boolean).length > HUMAN_CELL_WORDS) out.push({ line: i + 1, cell })
    }
  })
  return out
}

function boldHeavyLines(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    const spans = line.match(/\*\*[^*\n]+\*\*/g) ?? []
    if (spans.length > 2) out.push({ line: i + 1, text: line.trim() })
  })
  return out
}
