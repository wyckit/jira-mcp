// Resolves the MCP server implementation and schema builder.
//
// Prefers the official @modelcontextprotocol/sdk + zod when they are installed.
// Falls back to the bundled dependency-free implementations in this folder, so
// the server runs from a bare `git clone` with no `npm install` — useful on
// locked-down machines where the npm registry is unreachable.
//
// Set JIRA_MCP_RUNTIME=lite to force the bundled implementation (used by tests
// to exercise both paths), or JIRA_MCP_RUNTIME=sdk to require the real SDK and
// fail loudly if it is missing.

const requested = (process.env.JIRA_MCP_RUNTIME || "auto").toLowerCase();

async function loadSdk() {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);
  return { McpServer, StdioServerTransport, z, runtime: "sdk" };
}

async function loadLite() {
  const [{ McpServer, StdioServerTransport }, { z }] = await Promise.all([
    import("./mcp-lite.mjs"),
    import("./zod-lite.mjs"),
  ]);
  return { McpServer, StdioServerTransport, z, runtime: "lite" };
}

let resolved;
if (requested === "lite") {
  resolved = await loadLite();
} else if (requested === "sdk") {
  resolved = await loadSdk();
} else {
  try {
    resolved = await loadSdk();
  } catch {
    resolved = await loadLite();
  }
}

export const { McpServer, StdioServerTransport, z, runtime } = resolved;
