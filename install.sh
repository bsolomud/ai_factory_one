#!/usr/bin/env bash
# One-command install / uninstall. Usage:
#   ./install.sh --claude              install for Claude Code
#   ./install.sh --uninstall           remove from Claude Code (KEEPS your work)
#   ./install.sh --uninstall --purge   remove everything, incl. profiles/runs/knowledge
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  --claude)
    if [ ! -d "$HERE/node_modules" ]; then
      echo "→ installing dependencies"
      (cd "$HERE" && npm install --no-audit --no-fund --silent)
    fi
    # Always rebuild — this is the update path too (re-run after `git pull`).
    # A cached dist/ from a previous install must never shadow pulled source,
    # or the CLI silently ships stale code. Build is fast and deterministic.
    echo "→ building self-contained executables"
    (cd "$HERE" && npm run build --silent)
    exec bash "$HERE/adapters/claude-code/install.sh"
    ;;
  --uninstall)
    exec bash "$HERE/adapters/claude-code/uninstall.sh" "${2:-}"
    ;;
  *)
    echo "ai_factory_one — repo-agnostic AI development pipeline"
    echo
    echo "usage:"
    echo "  ./install.sh --claude              install for Claude Code"
    echo "  ./install.sh --uninstall           remove (keeps your profiles/runs/knowledge)"
    echo "  ./install.sh --uninstall --purge   remove everything"
    echo
    echo "Install adds: the /pipeline skill, the specialist agents (onboarder,"
    echo "context, planner, architect, critic, implementer, qa, reviewer,"
    echo "stage-runner), the gate guard hooks, and the CLI in ~/.ai_factory_one/."
    echo
    echo "Then, in any repo:  /pipeline start <ticket | link | task text>"
    exit 1
    ;;
esac
