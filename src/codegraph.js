import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as paths from './paths.js'

// The repo's code graph (codebase-memory-mcp), named for the agents.
//
// Every research agent since the worktree default worked in
// ~/.ai_factory_one/worktrees/<slug>/<run>, while the graph indexes the main
// checkout. Asked "does list_projects show this repo indexed?", each agent saw
// a foreign root_path, concluded "no", and fell back to grep: 8 of 49 agents in
// one pilot repo looked, 2 queried. The graph IS this repo — a snapshot of the main
// checkout at some commit. So the CLI names it, with the snapshot and the
// command that lists the files where the snapshot and the run's tree disagree.
//
// Optional, read-only, fail-silent: no binary, no index, a slow or broken
// server → null, and nothing else changes.

// CBM_BIN, when set, is the only candidate (tests; a non-default install).
function binary() {
  const c = process.env.CBM_BIN ?? path.join(os.homedir(), '.local', 'bin', 'codebase-memory-mcp')
  return c && fs.existsSync(c) ? c : null
}

function listProjects(bin) {
  const out = execFileSync(bin, ['cli', 'list_projects'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
  const json = out.trim().split('\n').reverse().find(l => l.startsWith('{'))
  return JSON.parse(json || '{}').projects || []
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 5_000 }).trim()

// The main checkout of the repo `workdir` belongs to (itself, unless a linked worktree).
function mainCheckout(workdir) {
  const common = git(workdir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return path.basename(common) === '.git' ? path.dirname(common) : git(workdir, 'rev-parse', '--show-toplevel')
}

export function codeGraph(workdir) {
  try {
    const bin = binary()
    if (!bin || !workdir) return null
    const projects = listProjects(bin)
    const here = paths.realpathish(workdir)
    const main = paths.realpathish(mainCheckout(workdir))
    const rootOf = p => paths.realpathish(p.git?.canonical_root || p.root_path || '')
    // An index of the run's own tree beats one of the main checkout.
    const project = projects.find(p => rootOf(p) === here) || projects.find(p => rootOf(p) === main)
    if (!project) return null
    const sha = project.git?.head_sha || null
    const exact = rootOf(project) === here
    let drift = null
    if (sha) {
      try { drift = git(workdir, 'diff', '--name-only', sha).split('\n').filter(Boolean).length } catch { /* snapshot commit unknown here */ }
    }
    const snapshot = `${project.git?.branch || '?'}@${sha ? sha.slice(0, 11) : '?'}`
    const scope = exact ? `this tree at ${snapshot}` : `the main checkout (${rootOf(project)}) at ${snapshot}, not from your workdir`
    const driftNote = drift == null
      ? 'its commit is unknown in your tree — treat every answer as a lead only'
      : drift === 0
        ? 'your tree matches it'
        : `${drift} file(s) differ from your tree — list them with \`git -C ${workdir} diff --name-only ${sha.slice(0, 11)}\`; for those, read the file, not the graph`
    return {
      project: project.name,
      snapshot,
      scope: exact ? 'tree' : 'main-checkout',
      drift_files: drift,
      line: `project=${project.name} — THIS repo, indexed from ${scope}; ${driftNote}. Use it to find callers/usages (search_graph, trace_path, get_code_snippet); cite file paths you read, and keep grep commands as the evidence gates re-run.`
    }
  } catch {
    return null
  }
}
