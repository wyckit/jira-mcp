// Exercises the server over real stdio MCP with fetch mocked, and asserts on the
// analysis output. No network, no credentials — safe to run anywhere.
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
];

const child = spawn(process.execPath, ["--import", mock, serverPath], {
  env: { ...process.env, JIRA_PAT: "test-token", JIRA_BASE_URL: "https://jira.example.com" },
  stdio: ["pipe", "pipe", "inherit"],
});

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
let buf = "";

child.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 2) toolCount = msg.result.tools.length;
    if (msg.id >= 100) {
      const call = CALLS[msg.id - 100];
      if (msg.error) {
        console.error(`FAIL ${call.name}: protocol error ${JSON.stringify(msg.error)}`);
        process.exit(1);
      }
      const text = (msg.result.content || []).map((c) => c.text).join("\n");
      if (msg.result.isError) {
        console.error(`FAIL ${call.name}: tool error\n${text}`);
        process.exit(1);
      }
      results.set(call.name, JSON.parse(text));
      if (results.size === CALLS.length) {
        child.kill();
        check();
      }
    }
  }
});

setTimeout(() => {
  console.error("FAIL: timed out waiting for responses");
  child.kill();
  process.exit(1);
}, 30000);

function check() {
  let passed = 0;
  const t = (label, fn) => {
    try {
      fn();
      console.log(`  ok  ${label}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL ${label}\n       ${e.message}`);
      process.exitCode = 1;
    }
  };

  console.log("\njira-mcp test suite\n");

  t("all tools register", () => assert.ok(toolCount >= 21, `expected >=21 tools, got ${toolCount}`));

  t("changelog reconstructs status durations from history", () => {
    const r = results.get("jira_get_changelog");
    assert.strictEqual(r.changeCount, 4);
    const hours = r.timeInStatus.map((s) => `${s.status}:${s.hours}`);
    assert.deepStrictEqual(hours, ["Open:24", "In Progress:72", "In Review:24", "In Progress:48", "Done:0"]);
  });

  t("resolved issue is not treated as still open", () => {
    // Regression: resolutiondate missing from the field list inflated the final
    // status duration up to now() for every resolved issue.
    const last = results.get("jira_get_changelog").timeInStatus.at(-1);
    assert.strictEqual(last.stillOpen, false);
    assert.strictEqual(last.hours, 0);
  });

  t("workflow analysis counts rework loops", () => {
    const r = results.get("jira_analyze_workflow");
    assert.strictEqual(r.analyzed, 3);
    assert.strictEqual(r.reworkTransitions, 1, "ABC-1 re-enters In Progress once");
    assert.strictEqual(r.resolvedCount, 2);
  });

  t("workflow analysis builds the transition graph", () => {
    const r = results.get("jira_analyze_workflow");
    const byName = Object.fromEntries(r.transitionFrequency.map((x) => [x.transition, x.count]));
    assert.strictEqual(byName["Open → In Progress"], 3);
    assert.strictEqual(byName["In Progress → Done"], 2);
    assert.strictEqual(byName["In Review → In Progress"], 1);
  });

  t("field analysis reports custom fields and fill rates", () => {
    const r = results.get("jira_analyze_fields");
    const env = r.fields.find((f) => f.field === "Environment");
    assert.ok(env, "Environment custom field should appear");
    assert.strictEqual(env.custom, true);
    assert.strictEqual(env.fillRate, "100%");
  });

  t("set comparison surfaces the discriminating qualifier", () => {
    const r = results.get("jira_compare_issue_sets");
    const hit = r.differences.find((d) => d.field === "Inventory Validated" && d.value === "Yes");
    assert.ok(hit, "should flag Inventory Validated=Yes as separating the sets");
    assert.strictEqual(hit.delta, 100);
  });

  t("set comparison filters per-issue noise fields", () => {
    const r = results.get("jira_compare_issue_sets");
    assert.ok(
      !r.differences.some((d) => d.field === "Summary"),
      "summary is unique per issue and can never be a real discriminator"
    );
  });

  t("text search finds matches inside comment threads", () => {
    const r = results.get("jira_search_text");
    assert.strictEqual(r.issuesWithMatches, 1);
    const sources = r.hits[0].matches.map((m) => m.source);
    assert.ok(sources.some((s) => s.startsWith("comment by")), "should match inside a comment");
    assert.ok(sources.includes("description"), "should match in the description");
  });

  t("graph trace walks links, subtasks and parents", () => {
    const r = results.get("jira_trace_graph");
    assert.strictEqual(r.nodeCount, 3);
    assert.ok(r.edges.some((e) => e.from === "ABC-1" && e.relationship === "blocks" && e.to === "ABC-2"));
    assert.ok(r.edges.some((e) => e.from === "ABC-1" && e.relationship === "parent of" && e.to === "ABC-3"));
  });

  const total = 10;
  console.log(`\n${passed}/${total} passed\n`);
  if (process.exitCode) process.exit(process.exitCode);
  process.exit(0);
}
