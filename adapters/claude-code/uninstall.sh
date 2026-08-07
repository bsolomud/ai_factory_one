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
# (un-merge logic in unmerge-settings.cjs by path, not a heredoc — see install.sh)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="$CLAUDE_DIR/settings.json" GUARD_BIN="$PIPELINE_HOME/bin/guard" node "$HERE/unmerge-settings.cjs" || true

# 3b. Addon unmerges: each addon removes ONLY the settings.json rules it
#     merged. Addon binaries and ~/.claude.json MCP registrations stay — they
#     are user-level tools, usable outside the pipeline.
for addon_merge in "$HERE"/addons/*/merge-permissions.cjs; do
  [ -f "$addon_merge" ] || continue
  SETTINGS="$CLAUDE_DIR/settings.json" node "$addon_merge" unmerge || true
done

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
