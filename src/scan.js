import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Mechanical scan for repo-local AI assets the pipeline can bind to instead of
// (or alongside) its built-ins. Deterministic — the judgment about WHAT each
// candidate is for happens in the onboarding interview, not here.
const SKILL_ROOTS = ['.ai/skills', '.claude/skills']
const COMMAND_ROOTS = ['.claude/commands']
const AGENT_DOCS = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md']
const KNOWLEDGE_DIRS = ['doc/ai', 'docs/ai', 'doc/adr', 'docs/adr', 'doc/architecture']

export function scanAssets(repoDir) {
  const found = { skills: [], commands: [], agent_docs: [], knowledge_dirs: [] }
  for (const root of SKILL_ROOTS) {
    const dir = path.join(repoDir, root)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name)
      if (fs.statSync(abs).isDirectory()) {
        found.skills.push({ name, path: `${root}/${name}`, entry: firstDoc(abs) })
      } else if (name.endsWith('.md')) {
        found.skills.push({ name: name.replace(/\.md$/, ''), path: `${root}/${name}` })
      }
    }
  }
  for (const root of COMMAND_ROOTS) {
    const dir = path.join(repoDir, root)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith('.md')) found.commands.push({ name: name.replace(/\.md$/, ''), path: `${root}/${name}` })
    }
  }
  for (const doc of AGENT_DOCS) {
    if (fs.existsSync(path.join(repoDir, doc))) found.agent_docs.push({ path: doc })
  }
  for (const dir of KNOWLEDGE_DIRS) {
    if (fs.existsSync(path.join(repoDir, dir))) found.knowledge_dirs.push({ path: dir })
  }
  return found
}

function firstDoc(dir) {
  for (const candidate of ['SKILL.md', 'README.md', 'index.md']) {
    if (fs.existsSync(path.join(dir, candidate))) return candidate
  }
  return null
}

// Content hash of a file OR a directory (sorted walk) — the staleness trigger
// for evidence files and skill bindings.
export function hashPath(abs) {
  if (!fs.existsSync(abs)) return null
  const h = createHash('sha256')
  const stat = fs.statSync(abs)
  if (stat.isFile()) {
    h.update(fs.readFileSync(abs))
  } else {
    for (const rel of walk(abs, '')) {
      h.update(rel)
      h.update(fs.readFileSync(path.join(abs, rel)))
    }
  }
  return 'sha256:' + h.digest('hex')
}

function walk(root, prefix) {
  const out = []
  for (const name of fs.readdirSync(path.join(root, prefix)).sort()) {
    if (name === '.git' || name === 'node_modules') continue
    const rel = prefix ? `${prefix}/${name}` : name
    if (fs.statSync(path.join(root, rel)).isDirectory()) out.push(...walk(root, rel))
    else out.push(rel)
  }
  return out
}
