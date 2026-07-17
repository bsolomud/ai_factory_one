import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Pipeline home: ALL state lives here, never inside a target repo.
// $AI_PIPELINE_HOME override exists so tests (and CI) run against a sandbox.
export function home() {
  return process.env.AI_PIPELINE_HOME || path.join(os.homedir(), '.ai-pipeline')
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
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

// Slug derived from origin URL so clones of the same repo share a profile;
// falls back to the directory name for remoteless repos.
export function repoSlug(repoDir) {
  let origin = null
  try {
    origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' }).trim()
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
