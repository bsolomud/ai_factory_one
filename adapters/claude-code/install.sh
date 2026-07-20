#!/usr/bin/env bash
# Install ai_factory_one: core assets → pipeline home, adapter → Claude Code.
# Idempotent; re-run after updating the package. Sandbox-testable via
# AI_FACTORY_HOME / CLAUDE_HOME overrides.
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PIPELINE_HOME="${AI_FACTORY_HOME:-$HOME/.ai_factory_one}"
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"

echo "package:       $PACKAGE_ROOT"
echo "pipeline home: $PIPELINE_HOME"
echo "claude dir:    $CLAUDE_DIR"

# 1. Core (host-neutral) assets → pipeline home. Replaced on every install —
#    profiles/runs/knowledge under repos/ are never touched.
mkdir -p "$PIPELINE_HOME/bin" "$PIPELINE_HOME/repos"
cp "$PACKAGE_ROOT/pipeline.yml" "$PIPELINE_HOME/pipeline.yml"
rm -rf "$PIPELINE_HOME/stages" "$PIPELINE_HOME/templates"
cp -R "$PACKAGE_ROOT/stages" "$PIPELINE_HOME/stages"
cp -R "$PACKAGE_ROOT/templates" "$PIPELINE_HOME/templates"
cat "$PACKAGE_ROOT/package.json" | node -e "process.stdin.pipe(process.stdout)" >/dev/null 2>&1 || true
node -e "console.log(JSON.parse(require('fs').readFileSync('$PACKAGE_ROOT/package.json','utf8')).version)" > "$PIPELINE_HOME/VERSION"

# 2. Executables: prefer the self-contained bundles; fall back to wrappers
#    around the package source (requires the package's node_modules).
if [ -f "$PACKAGE_ROOT/dist/pipeline" ]; then
  cp "$PACKAGE_ROOT/dist/pipeline" "$PIPELINE_HOME/bin/pipeline"
  cp "$PACKAGE_ROOT/dist/guard" "$PIPELINE_HOME/bin/guard"
else
  printf '#!/usr/bin/env bash\nexec node "%s/bin/pipeline" "$@"\n' "$PACKAGE_ROOT" > "$PIPELINE_HOME/bin/pipeline"
  printf '#!/usr/bin/env bash\nexec node "%s/bin/guard" "$@"\n' "$PACKAGE_ROOT" > "$PIPELINE_HOME/bin/guard"
fi
chmod +x "$PIPELINE_HOME/bin/pipeline" "$PIPELINE_HOME/bin/guard"

# 3. Claude Code adapter: skill + ALL agents (symlinks, so package updates flow).
mkdir -p "$CLAUDE_DIR/skills" "$CLAUDE_DIR/agents"
ln -sfn "$PACKAGE_ROOT/adapters/claude-code/skills/pipeline" "$CLAUDE_DIR/skills/pipeline"
for agent in "$PACKAGE_ROOT"/adapters/claude-code/agents/*.md; do
  ln -sf "$agent" "$CLAUDE_DIR/agents/$(basename "$agent")"
done

# 4. Guard hooks: MERGE into settings.json — never overwrite, never duplicate.
SETTINGS="$CLAUDE_DIR/settings.json" PIPELINE_HOME="$PIPELINE_HOME" node <<'EOF'
const fs = require('fs')
const file = process.env.SETTINGS
const guardBin = `${process.env.PIPELINE_HOME}/bin/guard`
let settings = {}
if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'))
settings.hooks ??= {}
settings.hooks.PreToolUse ??= []
const wanted = [
  { matcher: 'Bash', cmd: `${guardBin} bash` },
  { matcher: 'Edit|Write|NotebookEdit', cmd: `${guardBin} write` }
]
for (const { matcher, cmd } of wanted) {
  const present = settings.hooks.PreToolUse.some(entry =>
    (entry.hooks || []).some(h => h.command === cmd))
  if (!present) settings.hooks.PreToolUse.push({ matcher, hooks: [{ type: 'command', command: cmd }] })
}

// Pre-approve the pipeline's own CLI + reading its home, so /pipeline never
// prompts for its own machinery. Absolute (as invoked by hooks) + ~ form (as
// the SKILL invokes it). Merged, deduped — user's own rules are untouched.
const home = process.env.PIPELINE_HOME
settings.permissions ??= {}
settings.permissions.allow ??= []
const allowWanted = [
  `Bash(${home}/bin/pipeline:*)`,
  'Bash(~/.ai_factory_one/bin/pipeline:*)',
  'Bash(pipeline:*)',
  'Bash(echo:*)',
  `Read(${home}/**)`,
  'Read(~/.ai_factory_one/**)'
]
for (const rule of allowWanted) if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule)
settings.permissions.additionalDirectories ??= []
for (const dir of [home, '~/.ai_factory_one']) {
  if (!settings.permissions.additionalDirectories.includes(dir)) settings.permissions.additionalDirectories.push(dir)
}

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
console.log(`hooks + permissions merged into ${file}`)
EOF

echo "installed. Try: /pipeline in any repo (new Claude Code session)."
