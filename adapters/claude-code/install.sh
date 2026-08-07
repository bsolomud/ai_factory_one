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
# NOTE: the merge logic lives in merge-settings.cjs, invoked by path — NOT as a
# heredoc. bash 5.2 delivers heredocs through a pipe it fully writes BEFORE
# starting the reader; on macOS kernels whose unread pipes buffer only
# PIPE_BUF (512) bytes, any heredoc bigger than that deadlocks the installer.
SETTINGS="$CLAUDE_DIR/settings.json" PIPELINE_HOME="$PIPELINE_HOME" node "$PACKAGE_ROOT/adapters/claude-code/merge-settings.cjs"

# 5. Addons (opt-in via --with=<name>[,<name>...] on install.sh). Each addon is
#    a self-contained idempotent script; unknown names fail loudly. Addons run
#    AFTER the core merge so settings.json is guaranteed to exist.
if [ -n "${PIPELINE_ADDONS:-}" ]; then
  ADDON_ROOT="$PACKAGE_ROOT/adapters/claude-code/addons"
  IFS=',' read -r -a ADDON_NAMES <<< "$PIPELINE_ADDONS"
  for name in "${ADDON_NAMES[@]}"; do
    [ -z "$name" ] && continue
    if [ ! -f "$ADDON_ROOT/$name/install.sh" ]; then
      echo "unknown addon '$name' — available: $(ls "$ADDON_ROOT" 2>/dev/null | tr '\n' ' ')" >&2
      exit 1
    fi
    echo "→ addon: $name"
    PACKAGE_ROOT="$PACKAGE_ROOT" PIPELINE_HOME="$PIPELINE_HOME" CLAUDE_DIR="$CLAUDE_DIR" \
      bash "$ADDON_ROOT/$name/install.sh"
  done
fi

echo "installed. Try: /pipeline in any repo (new Claude Code session)."
