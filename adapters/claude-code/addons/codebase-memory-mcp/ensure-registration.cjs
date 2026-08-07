// Ensure ~/.claude.json has the codebase-memory-mcp server entry. Idempotent;
// never touches anything but mcpServers['codebase-memory-mcp'].
const fs = require('fs')
const file = process.env.CLAUDE_JSON
const bin = process.env.BIN_PATH

if (!bin) {
  console.log('codebase-memory-mcp: binary not on PATH — skipping MCP registration')
  process.exit(0)
}
let cfg = {}
if (fs.existsSync(file)) {
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
    // A corrupt registry is the user's to fix — never rewrite it blind.
    console.error(`codebase-memory-mcp: cannot parse ${file} — leaving it untouched, register manually`)
    process.exit(0)
  }
}
cfg.mcpServers ??= {}
if (cfg.mcpServers['codebase-memory-mcp']) {
  console.log('codebase-memory-mcp: already registered — skipping')
  process.exit(0)
}
cfg.mcpServers['codebase-memory-mcp'] = { command: bin }
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
console.log(`codebase-memory-mcp: registered in ${file}`)
