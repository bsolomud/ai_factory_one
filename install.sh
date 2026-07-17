#!/usr/bin/env bash
# One-command install. Usage:
#   ./install.sh --claude     install for Claude Code (skill + agents + guard hooks)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  --claude)
    if [ ! -d "$HERE/node_modules" ]; then
      echo "→ installing dependencies"
      (cd "$HERE" && npm install --no-audit --no-fund --silent)
    fi
    if [ ! -f "$HERE/dist/pipeline" ]; then
      echo "→ building self-contained executables"
      (cd "$HERE" && npm run build --silent)
    fi
    exec bash "$HERE/adapters/claude-code/install.sh"
    ;;
  *)
    echo "ai_factory_one — repo-agnostic AI development pipeline"
    echo
    echo "usage: ./install.sh --claude"
    echo
    echo "Installs for Claude Code: the /pipeline skill, the specialist agents"
    echo "(planner, architect, critic, implementer, qa, reviewer), the gate"
    echo "guard hooks, and the pipeline CLI in ~/.ai_factory_one/."
    echo
    echo "Then, in any repo:  /pipeline start <ticket | link | task text>"
    exit 1
    ;;
esac
