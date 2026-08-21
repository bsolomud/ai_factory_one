import { execFileSync } from 'node:child_process'
import fs, { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Pipeline home: ALL state lives here, never inside a target repo.
// $AI_FACTORY_HOME override exists so tests (and CI) run against a sandbox.
export function home() {
  return process.env.AI_FACTORY_HOME || path.join(os.homedir(), '.ai_factory_one')
}

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

// The installed copy of pipeline.yml/stages/templates wins over the package's own,
// so `pipeline update` (replace home copies) works without touching the repo clone.
export function asset(...parts) {
  const installed = path.join(home(), ...parts)
  return existsSync(installed) ? installed : path.join(packageRoot(), ...parts)
}

export function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

// Slug derived from origin URL so clones of the same repo share a profile;
// falls back to the directory name for remoteless repos.
export function repoSlug(repoDir) {
  let origin = null
  try {
    origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch { /* no origin remote */ }
  const base = origin || path.basename(repoDir)
  return base
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function repoHome(slug) {
  return path.join(home(), 'repos', slug)
}

export function profilePath(slug) {
  return path.join(repoHome(slug), 'profile.yml')
}

export function runDir(slug, runId) {
  return path.join(repoHome(slug), 'runs', runId)
}

// Per-repo learned-facts store (written by SCRIBE, read by CONTEXT/PLAN):
// one fact per file plus an index.md with one line per fact.
export function knowledgeDir(slug) {
  return path.join(repoHome(slug), 'knowledge')
}

// Per-run working trees live under the pipeline home (like all run state):
// the installed Claude Code permissions already cover the home, so any
// session can work in a worktree with zero settings changes.
export function worktreeDir(slug, runId) {
  return path.join(home(), 'worktrees', slug, runId)
}

// A linked worktree has a .git FILE (pointer to the main clone's git dir)
// where the main clone has a directory — one stat, no subprocess.
export function isLinkedWorktree(repoDir) {
  try {
    return fs.statSync(path.join(repoDir, '.git')).isFile()
  } catch {
    return false
  }
}

// Canonicalize a possibly-not-yet-existing path (macOS: /var → /private/var
// symlinks break naive prefix comparison against git's resolved toplevel).
export function realpathish(p) {
  let head = p
  const tail = []
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head)
    if (parent === head) return p
    tail.unshift(path.basename(head))
    head = parent
  }
  return path.join(fs.realpathSync.native(head), ...tail)
}

// Registry of where each known repo lives locally, so /pipeline works from any
// folder: recorded on every successful profile resolution, read by `repos`.
export function recordRepoLocation(slug, repoDir) {
  try {
    fs.mkdirSync(repoHome(slug), { recursive: true })
    fs.writeFileSync(path.join(repoHome(slug), 'location'), repoDir + '\n')
  } catch { /* registry is best-effort */ }
}

export function knownRepos() {
  const reposDir = path.join(home(), 'repos')
  if (!existsSync(reposDir)) return []
  return fs.readdirSync(reposDir)
    .filter(slug => fs.statSync(path.join(reposDir, slug)).isDirectory())
    .map(slug => {
      const locFile = path.join(reposDir, slug, 'location')
      const location = existsSync(locFile) ? fs.readFileSync(locFile, 'utf8').trim() : null
      return {
        slug,
        path: location && existsSync(location) ? location : null,
        has_profile: existsSync(path.join(reposDir, slug, 'profile.yml'))
      }
    })
}
