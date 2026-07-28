// Tests bin/jira-mcp.cmd — the launcher that lets one plugin run against either
// the standalone executable or Node.
//
// The launcher sits between the MCP client and the server, so the thing most
// likely to break is stdout hygiene: a single stray byte from the shell (an
// echoed command, a banner) corrupts the JSON-RPC stream. These tests assert
// the first stdout byte is '{' on every resolution path.
//
//   node test/run-launcher-tests.mjs
import { spawn } from "child_process";
import { mkdtempSync, cpSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import assert from "assert";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "dist", process.platform === "win32" ? "jira-mcp.exe" : "jira-mcp");

if (process.platform !== "win32") {
  console.log("\nlauncher tests: skipped (Windows only)\n");
  process.exit(0);
}

// Builds an isolated plugin root so each resolution path can be forced.
function stage({ withExe }) {
  const dir = mkdtempSync(join(tmpdir(), "jira-mcp-launcher-"));
  cpSync(join(root, "bin"), join(dir, "bin"), { recursive: true });
  cpSync(join(root, "lib"), join(dir, "lib"), { recursive: true });
  cpSync(join(root, "server.js"), join(dir, "server.js"));
  if (withExe) cpSync(exe, join(dir, "jira-mcp.exe"));
  return dir;
}

function run(pluginRoot, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd", ["/c", join(pluginRoot, "bin", "jira-mcp.cmd")], {
      env: {
        ...process.env,
        JIRA_BASE_URL: "https://jira.example.com",
        JIRA_PAT: "launcher-test-token",
        JIRA_MCP_EXE: "",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stdout=${out.slice(0, 200)} stderr=${err.slice(0, 300)}`));
    }, 30000);

    child.on("error", reject);
    setTimeout(() => {
      clearTimeout(timer);
      child.kill();
      let tools = 0;
      for (const line of out.split("\n").filter(Boolean)) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) tools = m.result.tools.length;
        } catch {
          /* assertion below reports raw stdout */
        }
      }
      resolve({ out, err, tools });
    }, 6000);
  });
}

let failed = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    failed++;
  }
};

console.log("\nlauncher tests\n");

// --- resolves the executable when one sits in the plugin root -------------
if (existsSync(exe)) {
  const dir = stage({ withExe: true });
  const r = await run(dir);
  t("resolves jira-mcp.exe from the plugin root", () => assert.strictEqual(r.tools, 21));
  t("exe path: stdout carries only JSON-RPC", () =>
    assert.ok(r.out.trimStart().startsWith("{"), `stdout began with: ${JSON.stringify(r.out.slice(0, 120))}`));

  // --- explicit JIRA_MCP_EXE wins -----------------------------------------
  const bare = stage({ withExe: false });
  const r2 = await run(bare, { JIRA_MCP_EXE: exe });
  t("honours an explicit JIRA_MCP_EXE path", () => assert.strictEqual(r2.tools, 21));
  rmSync(dir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
} else {
  console.log("  skip executable paths — dist/jira-mcp.exe not built");
}

// --- falls back to Node when no executable is present ---------------------
const nodeOnly = stage({ withExe: false });
const r3 = await run(nodeOnly);
t("falls back to node server.js when no executable is present", () => assert.strictEqual(r3.tools, 21));
t("node path: stdout carries only JSON-RPC", () =>
  assert.ok(r3.out.trimStart().startsWith("{"), `stdout began with: ${JSON.stringify(r3.out.slice(0, 120))}`));
rmSync(nodeOnly, { recursive: true, force: true });

console.log(failed ? `\n${failed} failed\n` : "\nlauncher tests passed\n");
process.exit(failed ? 1 : 0);
