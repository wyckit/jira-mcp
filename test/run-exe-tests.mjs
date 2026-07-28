// End-to-end test of the compiled executable in dist/.
//
// Starts a local HTTP server that impersonates Jira, points the .exe at it, and
// drives the real MCP stdio protocol. This exercises the shipped binary over a
// real network stack — no Node on the path being tested other than what is
// embedded in the executable itself.
//
//   node test/run-exe-tests.mjs
import { createServer } from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import assert from "assert";
import { respond } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const exePath = join(here, "..", "dist", process.platform === "win32" ? "jira-mcp.exe" : "jira-mcp");

if (!existsSync(exePath)) {
  console.error(`No executable at ${exePath}\nBuild it first:  node build/build-exe.mjs`);
  process.exit(1);
}

let sawAuthHeader = null;
const httpServer = createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  sawAuthHeader = req.headers.authorization ?? sawAuthHeader;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(respond(u.pathname, u.searchParams.get("jql") || "")));
});

await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const port = httpServer.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const CALLS = [
  { name: "jira_get_changelog", arguments: { issueKey: "ABC-1" } },
  { name: "jira_analyze_workflow", arguments: { jql: "project = ABC" } },
  { name: "jira_compare_issue_sets", arguments: { jqlA: "PRODSET", jqlB: "FAILED", labelA: "shipped", labelB: "stalled" } },
  { name: "jira_search_text", arguments: { jql: "project = ABC", pattern: "inventory qualif" } },
  { name: "jira_trace_graph", arguments: { issueKey: "ABC-1" } },
];

const child = spawn(exePath, [], {
  env: { ...process.env, JIRA_BASE_URL: baseUrl, JIRA_PAT: "exe-test-token" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "exe-test", version: "0" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
CALLS.forEach((c, i) => send({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: c }));

const results = new Map();
let toolCount = 0;
let buf = "";

const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out. stderr:\n${stderr}`)), 60000);
  child.on("error", reject);
  child.stdout.on("data", (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        clearTimeout(timer);
        return reject(new Error(`non-JSON on stdout: ${line.slice(0, 200)}`));
      }
      if (msg.id === 2) toolCount = msg.result.tools.length;
      if (msg.id >= 100) {
        const call = CALLS[msg.id - 100];
        if (msg.error) {
          clearTimeout(timer);
          return reject(new Error(`${call.name} protocol error: ${JSON.stringify(msg.error)}`));
        }
        const text = (msg.result.content || []).map((c) => c.text).join("\n");
        if (msg.result.isError) {
          clearTimeout(timer);
          return reject(new Error(`${call.name} tool error:\n${text}`));
        }
        results.set(call.name, JSON.parse(text));
        if (results.size === CALLS.length) {
          clearTimeout(timer);
          resolve();
        }
      }
    }
  });
});

await done;
child.kill();
httpServer.close();

let passed = 0;
let failed = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    failed++;
  }
};

console.log(`\njira-mcp executable test\n  binary: ${exePath}\n  jira:   ${baseUrl}\n`);

t("executable serves the full tool surface", () => assert.ok(toolCount >= 21, `got ${toolCount}`));

t("authenticates with the PAT as a Bearer token", () =>
  assert.strictEqual(sawAuthHeader, "Bearer exe-test-token"));

t("changelog math survives compilation", () => {
  const r = results.get("jira_get_changelog");
  const hours = r.timeInStatus.map((s) => `${s.status}:${s.hours}`);
  assert.deepStrictEqual(hours, ["Open:24", "In Progress:72", "In Review:24", "In Progress:48", "Done:0"]);
});

t("workflow analysis counts rework loops", () => {
  const r = results.get("jira_analyze_workflow");
  assert.strictEqual(r.analyzed, 3);
  assert.strictEqual(r.reworkTransitions, 1);
});

t("set comparison surfaces the discriminating qualifier", () => {
  const hit = results
    .get("jira_compare_issue_sets")
    .differences.find((d) => d.field === "Inventory Validated" && d.value === "Yes");
  assert.ok(hit && hit.delta === 100);
});

t("text search reads comment threads", () => {
  const r = results.get("jira_search_text");
  assert.strictEqual(r.issuesWithMatches, 1);
  assert.ok(r.hits[0].matches.some((m) => m.source.startsWith("comment by")));
});

t("graph trace applies schema defaults and walks links", () => {
  const r = results.get("jira_trace_graph");
  assert.strictEqual(r.depthRequested, 2, "depth should default to 2");
  assert.strictEqual(r.nodeCount, 3);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
