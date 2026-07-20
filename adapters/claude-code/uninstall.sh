#!/usr/bin/env bash
# Uninstall ai_factory_one from Claude Code — reverses install.sh precisely.
# By default KEEPS your work (profiles, runs, learned knowledge under repos/).
# Pass --purge to remove those too. Sandbox-testable via AI_FACTORY_HOME /
# CLAUDE_HOME overrides.
set -euo pipefail

PIPELINE_HOME="${AI_FACTORY_HOME:-$HOME/.ai_factory_one}"
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

echo "pipeline home: $PIPELINE_HOME"
echo "claude dir:    $CLAUDE_DIR"

# 1. Remove the skill symlink (only if it is a symlink we created).
if [ -L "$CLAUDE_DIR/skills/pipeline" ]; then
  rm -f "$CLAUDE_DIR/skills/pipeline"
  echo "removed skill: skills/pipeline"
fi

# 2. Remove agent symlinks — only pipeline-*.md entries that are symlinks
#    (leaves any real files the user authored untouched).
if [ -d "$CLAUDE_DIR/agents" ]; then
  for link in "$CLAUDE_DIR"/agents/pipeline-*.md; do
    [ -L "$link" ] && rm -f "$link" && echo "removed agent: agents/$(basename "$link")"
  done
fi

# 3. Un-merge the guard hooks from settings.json — remove ONLY our entries,
#    prune empties, preserve everything else. No file, nothing to do.
SETTINGS="$CLAUDE_DIR/settings.json" GUARD_BIN="$PIPELINE_HOME/bin/guard" node <<'EOF' || true
const fs = require('fs')
const file = process.env.SETTINGS
if (!fs.existsSync(file)) process.exit(0)
let settings
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { process.exit(0) }
const hooks = settings.hooks?.PreToolUse
if (!Array.isArray(hooks)) process.exit(0)

// Ours: the guard from THIS pipeline home (exact), plus the branded default
// path as a fallback — so a user's unrelated hooks are never touched.
const guardBin = process.env.GUARD_BIN
const isOurs = cmd => typeof cmd === 'string' &&
  (cmd === `${guardBin} bash` || cmd === `${guardBin} write` ||
   /ai_factory_one\/bin\/guard (bash|write)$/.test(cmd))

let removed = 0
settings.hooks.PreToolUse = hooks
  .map(entry => {
    const kept = (entry.hooks || []).filter(h => { if (isOurs(h.command)) { removed++; return false } return true })
    return { ...entry, hooks: kept }
  })
  .filter(entry => (entry.hooks || []).length > 0) // drop entries emptied by removal

// Prune now-empty containers so we leave settings.json as clean as we found it.
if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse
if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
console.log(`removed ${removed} guard hook(s) from ${file}`)
EOF

# 4. Remove the pipeline home. Keep repos/ (your work) unless --purge.
if [ -d "$PIPELINE_HOME" ]; then
  if [ "$PURGE" = "1" ]; then
    rm -rf "$PIPELINE_HOME"
    echo "purged pipeline home (including all profiles, runs, knowledge)"
  else
    rm -rf "$PIPELINE_HOME/bin" "$PIPELINE_HOME/stages" "$PIPELINE_HOME/templates" \
           "$PIPELINE_HOME/pipeline.yml" "$PIPELINE_HOME/VERSION"
    # If nothing but an empty repos/ (or nothing) remains, remove the home too.
    if [ -z "$(ls -A "$PIPELINE_HOME" 2>/dev/null)" ] || \
       { [ "$(ls -A "$PIPELINE_HOME" 2>/dev/null)" = "repos" ] && [ -z "$(ls -A "$PIPELINE_HOME/repos" 2>/dev/null)" ]; }; then
      rm -rf "$PIPELINE_HOME"
      echo "removed pipeline home (was empty of user data)"
    else
      echo "removed framework files; KEPT your work in $PIPELINE_HOME/repos (run with --purge to delete it too)"
    fi
  fi
fi

echo "uninstalled."
