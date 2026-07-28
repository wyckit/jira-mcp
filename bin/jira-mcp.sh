#!/bin/sh
# POSIX counterpart of jira-mcp.cmd. The standalone executable is Windows-only,
# so this resolves JIRA_MCP_EXE (if you built one for this platform) then Node.
#
# Nothing may be written to stdout — that stream carries the JSON-RPC protocol.
set -e
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "$JIRA_MCP_EXE" ] && [ -x "$JIRA_MCP_EXE" ]; then
  exec "$JIRA_MCP_EXE"
fi

if [ -x "$PLUGIN_ROOT/jira-mcp" ]; then
  exec "$PLUGIN_ROOT/jira-mcp"
fi

if command -v node >/dev/null 2>&1; then
  exec node "$PLUGIN_ROOT/server.js"
fi

echo "jira-mcp: no runtime found. Set JIRA_MCP_EXE, or install Node 18 or newer." >&2
exit 1
