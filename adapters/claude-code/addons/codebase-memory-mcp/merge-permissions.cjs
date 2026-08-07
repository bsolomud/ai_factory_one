// Merge (default) or unmerge (`node merge-permissions.cjs unmerge`) the
// read-only graph tools into settings.json permissions.allow. The mutating
// tools (index_repository, delete_project, manage_adr, ingest_traces,
// query_graph) are deliberately NOT allow-listed — agents never get them.
const fs = require('fs')
const file = process.env.SETTINGS
const unmerge = process.argv[2] === 'unmerge'
const PREFIX = 'mcp__codebase-memory-mcp__'
const RULES = [
  'index_status', 'list_projects', 'get_architecture', 'search_graph',
  'search_code', 'trace_path', 'get_code_snippet', 'detect_changes'
].map(t => PREFIX + t)

let settings = {}
if (fs.existsSync(file)) {
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
    if (unmerge) process.exit(0)
    throw new Error(`cannot parse ${file}`)
  }
} else if (unmerge) process.exit(0)

if (unmerge) {
  // Strip by prefix, not the exact list — also cleans rules from older
  // versions of this addon. Prune empties like the core unmerge.
  if (settings.permissions?.allow) {
    const before = settings.permissions.allow.length
    settings.permissions.allow = settings.permissions.allow.filter(r => !(typeof r === 'string' && r.startsWith(PREFIX)))
    console.log(`codebase-memory-mcp: removed ${before - settings.permissions.allow.length} permission rule(s)`)
    if (settings.permissions.allow.length === 0) delete settings.permissions.allow
  }
  if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions
} else {
  settings.permissions ??= {}
  settings.permissions.allow ??= []
  let added = 0
  for (const rule of RULES) {
    if (!settings.permissions.allow.includes(rule)) { settings.permissions.allow.push(rule); added++ }
  }
  console.log(`codebase-memory-mcp: ${added} permission rule(s) merged into ${file}`)
}
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
