import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// git worktree lifecycle for per-run working trees. Creation needs git >= 2.5,
// `worktree remove` >= 2.17 (2018) — we don't probe versions; an old git's own
// stderr surfaces verbatim, which is a better message than anything we'd guess.

function git(repoDir, args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

const gitError = e => (e.stderr?.toString() || e.message || '').trim()

// The main clone's working tree, from any of its worktrees: the common git
// dir's parent. Worktree add/remove must run from here — never from inside
// the tree being removed.
export function mainWorktreeDir(repoDir) {
  const common = git(repoDir, ['rev-parse', '--git-common-dir'])
  return path.dirname(path.resolve(repoDir, common))
}

// Detached at the base: attaching a branch would fail whenever another
// worktree already has it checked out. The run's own branch is created at
// BREAKDOWN, inside this tree.
export function createWorktree(repoDir, wtPath, base) {
  try {
    git(repoDir, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  } catch {
    throw new Error(`base branch '${base}' does not exist locally in ${repoDir} — fetch or create it first`)
  }
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  try {
    git(repoDir, ['worktree', 'add', '--detach', wtPath, base])
  } catch (e) {
    throw new Error(`git worktree add failed: ${gitError(e)}`)
  }
}

export function checkoutBranch(wtPath, branch) {
  try {
    git(wtPath, ['checkout', branch])
  } catch (e) {
    throw new Error(`could not check out '${branch}' in the new worktree (checked out in another worktree?): ${gitError(e)}`)
  }
}

// Refuses a dirty tree unless forced (git's own safety); prune is best-effort
// and also cleans up after a tree the developer deleted by hand.
export function removeWorktree(repoDir, wtPath, { force = false } = {}) {
  if (fs.existsSync(wtPath)) {
    try {
      git(repoDir, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath])
    } catch (e) {
      throw new Error(`git worktree remove failed: ${gitError(e)} (pass --force to discard uncommitted changes)`)
    }
  }
  try { git(repoDir, ['worktree', 'prune']) } catch { /* best effort */ }
}

export function deleteBranch(repoDir, branch) {
  try {
    git(repoDir, ['branch', '-D', branch])
  } catch (e) {
    throw new Error(`git branch -D ${branch} failed: ${gitError(e)}`)
  }
}
