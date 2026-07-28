// Exercises the server over real stdio MCP with fetch mocked, and asserts on the
// analysis output. No network, no credentials — safe to run anywhere.
//
// Runs the whole suite twice: once on the official MCP SDK (if installed) and
// once on the bundled dependency-free runtime, so the no-npm path is proven
// equivalent rather than assumed.
//
//   npm test
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import assert from "assert";

const here = dirname(fileURLToPath(import.meta.url));
const mock = pathToFileURL(join(here, "mock-jira.mjs")).href;
const serverPath = join(here, "..", "server.js");

const CALLS = [
  { name: "jira_get_changelog", arguments: { issueKey: "ABC-1" } },
  { name: "jira_analyze_workflow", arguments: { jql: "project = ABC" } },
  { name: "jira_analyze_fields", arguments: { jql: "project = ABC" } },
  { name: "jira_compare_issue_sets", arguments: { jqlA: "PRODSET", jqlB: "FAILED", labelA: "shipped", labelB: "stalled" } },
  { name: "jira_search_text", arguments: { jql: "project = ABC", pattern: "inventory qualif" } },
  { name: "jira_trace_graph", arguments: { issueKey: "ABC-1", depth: 2 } },
  // Exercises default-filling: depth/maxNodes omitted must come from the schema.
  { name: "jira_trace_graph", arguments: { issueKey: "ABC-1" } },
];

function runServer(runtimeMode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", mock, serverPath], {
      env: {
        ...process.env,
        JIRA_PAT: "test-token",
        JIRA_BASE_URL: "https://jira.example.com",
        JIRA_MCP_RUNTIME: runtimeMode,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    CALLS.forEach((c, i) => send({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: c }));

    const results = new Map();
    let toolCount = 0;
    let initResult = null;
    let buf = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`[${runtimeMode}] timed out. stderr:\n${stderr}`));
    }, 30000);

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
        } catch (e) {
          clearTimeout(timer);
          child.kill();
          return reject(new Error(`[${runtimeMode}] non-JSON on stdout: ${line.slice(0, 200)}`));
        }
        if (msg.id === 1) initResult = msg.result;
        if (msg.id === 2) toolCount = msg.result.tools.length;
        if (msg.id >= 100) {
          const call = CALLS[msg.id - 100];
          if (msg.error) {
            clearTimeout(timer);
            child.kill();
            return reject(new Error(`[${runtimeMode}] ${call.name} protocol error: ${JSON.stringify(msg.error)}`));
          }
          const text = (msg.result.content || []).map((c) => c.text).join("\n");
          if (msg.result.isError) {
            clearTimeout(timer);
            child.kill();
            return reject(new Error(`[${runtimeMode}] ${call.name} tool error:\n${text}`));
          }
          results.set(msg.id, JSON.parse(text));
          if (results.size === CALLS.length) {
            clearTimeout(timer);
            child.kill();
            resolve({ results, toolCount, initResult, stderr });
          }
        }
      }
    });
  });
}

function assertAll({ results, toolCount, initResult }, label) {
  let passed = 0;
  let failed = 0;
  const byName = (n) => results.get(100 + CALLS.findIndex((c) => c.name === n));

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

  console.log(`\n--- runtime: ${label} ---`);

  t("initialize returns serverInfo and tool capability", () => {
    assert.strictEqual(initResult.serverInfo.name, "jira-mcp");
    assert.ok(initResult.capabilities.tools, "tools capability must be advertised");
  });

  t("all tools register", () => assert.ok(toolCount >= 21, `expected >=21 tools, got ${toolCount}`));

  t("changelog reconstructs status durations from history", () => {
    const r = byName("jira_get_changelog");
    assert.strictEqual(r.changeCount, 4);
    const hours = r.timeInStatus.map((s) => `${s.status}:${s.hours}`);
    assert.deepStrictEqual(hours, ["Open:24", "In Progress:72", "In Review:24", "In Progress:48", "Done:0"]);
  });

  t("resolved issue is not treated as still open", () => {
    // Regression: resolutiondate missing from the field list inflated the final
    // status duration up to now() for every resolved issue.
    const last = byName("jira_get_changelog").timeInStatus.at(-1);
    assert.strictEqual(last.stillOpen, false);
    assert.strictEqual(last.hours, 0);
  });

  t("workflow analysis counts rework loops", () => {
    const r = byName("jira_analyze_workflow");
    assert.strictEqual(r.analyzed, 3);
    assert.strictEqual(r.reworkTransitions, 1, "ABC-1 re-enters In Progress once");
    assert.strictEqual(r.resolvedCount, 2);
  });

  t("workflow analysis builds the transition graph", () => {
    const g = Object.fromEntries(byName("jira_analyze_workflow").transitionFrequency.map((x) => [x.transition, x.count]));
    assert.strictEqual(g["Open → In Progress"], 3);
    assert.strictEqual(g["In Progress → Done"], 2);
    assert.strictEqual(g["In Review → In Progress"], 1);
  });

  t("field analysis reports custom fields and fill rates", () => {
    const env = byName("jira_analyze_fields").fields.find((f) => f.field === "Environment");
    assert.ok(env, "Environment custom field should appear");
    assert.strictEqual(env.custom, true);
    assert.strictEqual(env.fillRate, "100%");
  });

  t("set comparison surfaces the discriminating qualifier", () => {
    const hit = byName("jira_compare_issue_sets").differences.find(
      (d) => d.field === "Inventory Validated" && d.value === "Yes"
    );
    assert.ok(hit, "should flag Inventory Validated=Yes as separating the sets");
    assert.strictEqual(hit.delta, 100);
  });

  t("set comparison filters per-issue noise fields", () => {
    assert.ok(
      !byName("jira_compare_issue_sets").differences.some((d) => d.field === "Summary"),
      "summary is unique per issue and can never be a real discriminator"
    );
  });

  t("text search finds matches inside comment threads", () => {
    const r = byName("jira_search_text");
    assert.strictEqual(r.issuesWithMatches, 1);
    const sources = r.hits[0].matches.map((m) => m.source);
    assert.ok(sources.some((s) => s.startsWith("comment by")), "should match inside a comment");
    assert.ok(sources.includes("description"), "should match in the description");
  });

  t("graph trace walks links, subtasks and parents", () => {
    const r = byName("jira_trace_graph");
    assert.strictEqual(r.nodeCount, 3);
    assert.ok(r.edges.some((e) => e.from === "ABC-1" && e.relationship === "blocks" && e.to === "ABC-2"));
    assert.ok(r.edges.some((e) => e.from === "ABC-1" && e.relationship === "parent of" && e.to === "ABC-3"));
  });

  t("schema defaults are applied when arguments are omitted", () => {
    // Last call omits depth and maxNodes entirely.
    const r = results.get(100 + CALLS.length - 1);
    assert.strictEqual(r.depthRequested, 2, "depth should default to 2");
    assert.strictEqual(r.nodeCount, 3);
  });

  return { passed, failed };
}

const modes = [];
try {
  await import("@modelcontextprotocol/sdk/server/mcp.js");
  await import("zod");
  modes.push(["sdk", "official MCP SDK + zod"]);
} catch {
  console.log("\n(note: MCP SDK not installed — testing the dependency-free runtime only)");
}
modes.push(["lite", "bundled, zero dependencies"]);

console.log("\njira-mcp test suite");

let totalPassed = 0;
let totalFailed = 0;
for (const [mode, label] of modes) {
  const out = await runServer(mode);
  const { passed, failed } = assertAll(out, label);
  totalPassed += passed;
  totalFailed += failed;
}

console.log(`\n${totalPassed} passed, ${totalFailed} failed across ${modes.length} runtime(s)\n`);
process.exit(totalFailed ? 1 : 0);
