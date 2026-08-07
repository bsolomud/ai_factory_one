#!/usr/bin/env bash
# Addon: codebase-memory-mcp — local code-graph MCP server (third-party,
# github.com/DeusData/codebase-memory-mcp). Idempotent: every step detects
# "already done" and skips. Installs the upstream binary, ensures the MCP
# registration in ~/.claude.json, and pre-approves the read-only graph tools
# in settings.json so the research agents never prompt for them.
# Sandbox-testable via CLAUDE_DIR / CLAUDE_JSON / CBM_BIN / PATH overrides.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-${CLAUDE_HOME:-$HOME/.claude}}"
CLAUDE_JSON="${CLAUDE_JSON:-$HOME/.claude.json}"   # Claude Code's MCP registry
CBM_BIN="${CBM_BIN:-codebase-memory-mcp}"          # test shim override

# 1. Binary. The upstream installer handles platform detection and also
#    registers the MCP entry itself; step 2 covers the pre-installed case.
if command -v "$CBM_BIN" >/dev/null 2>&1; then
  echo "codebase-memory-mcp: binary already installed ($("$CBM_BIN" --version 2>/dev/null || echo present)) — skipping install"
else
  echo "codebase-memory-mcp: installing upstream binary"
  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
fi

# 2. MCP registration in ~/.claude.json — no-op when already registered.
# (merge logic in a .cjs by path, NOT a heredoc — see adapter install.sh step 4)
BIN_PATH="$(command -v "$CBM_BIN" || true)"
CLAUDE_JSON="$CLAUDE_JSON" BIN_PATH="$BIN_PATH" node "$HERE/ensure-registration.cjs"

# 3. Pre-approve the read-only graph tools (merge + dedupe, like the core).
SETTINGS="$CLAUDE_DIR/settings.json" node "$HERE/merge-permissions.cjs"

# 4. Next step — always with the ABSOLUTE path: the upstream installer defaults
#    to ~/.local/bin, which is not on the default macOS PATH. The MCP
#    registration (step 2) uses the absolute path, so Claude sessions work
#    either way; only the user's own shell needs the PATH fix.
echo "codebase-memory-mcp: done. Index each repo once (the watcher keeps it fresh):"
echo "  ${BIN_PATH:-$CBM_BIN} cli index_repository --repo-path <repo>"
if [ -n "$BIN_PATH" ]; then
  BIN_DIR="$(dirname "$BIN_PATH")"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo "codebase-memory-mcp: NOTE — $BIN_DIR is not on your PATH. To call it by name, run:"
      echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bash_profile && source ~/.bash_profile"
      ;;
  esac
fi
