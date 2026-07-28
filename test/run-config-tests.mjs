// Credential resolution: environment first, then a config file, then a clear
// failure. Asserts the token value is never echoed to stderr.
//
//   node test/run-config-tests.mjs
import { spawn } from "child_process";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import assert from "assert";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "server.js");
const dir = mkdtempSync(join(tmpdir(), "jira-mcp-config-"));

function start(env) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    delete base.JIRA_PAT;
    delete base.JIRA_BASE_URL;
    delete base.JIRA_MCP_CONFIG;

    const child = spawn(process.execPath, [serverPath], {
      env: { ...base, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n"
    );
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    setTimeout(() => {
      child.kill();
      let tools = 0;
      for (const line of out.split("\n").filter(Boolean)) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) tools = m.result.tools.length;
        } catch {}
      }
      resolve({ out, err, tools });
    }, 3000);
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

console.log("\ncredential resolution\n");

const cfgPath = join(dir, "cfg.json");
writeFileSync(cfgPath, JSON.stringify({ baseUrl: "https://from-file.example.com", pat: "file-token-value" }));

const fromFile = await start({ JIRA_MCP_CONFIG: cfgPath });
t("a config file supplies credentials when no env vars are set", () => {
  assert.strictEqual(fromFile.tools, 21);
  assert.ok(fromFile.err.includes("from-file.example.com"), "should connect using the file's base URL");
});
t("the banner names the credential source but never the token", () => {
  assert.ok(fromFile.err.includes("credentials:"), "banner should report a source");
  assert.ok(!fromFile.err.includes("file-token-value"), "token value must never be printed");
});

const envWins = await start({
  JIRA_MCP_CONFIG: cfgPath,
  JIRA_BASE_URL: "https://from-env.example.com",
  JIRA_PAT: "env-token-value",
});
t("environment variables take precedence over the config file", () => {
  assert.ok(envWins.err.includes("from-env.example.com"), "env base URL should win");
  assert.ok(envWins.err.includes("credentials: environment"));
  assert.ok(!envWins.err.includes("env-token-value"), "token value must never be printed");
});

const none = await start({ JIRA_MCP_CONFIG: join(dir, "does-not-exist.json") });
t("missing credentials produce an actionable message, not a crash", () => {
  assert.strictEqual(none.tools, 0);
  assert.ok(none.err.includes("no Jira"), "should say what is missing");
  assert.ok(none.err.includes("setx JIRA_PAT"), "should show the env var route");
  assert.ok(none.err.includes(".jira-mcp.json"), "should show the config file route");
  assert.ok(none.err.includes(".mcp.json"), "should warn against putting the token in the shared plugin config");
});

const malformed = join(dir, "bad.json");
writeFileSync(malformed, "{ not valid json");
const broken = await start({ JIRA_MCP_CONFIG: malformed });
t("a malformed config file is reported, not swallowed", () =>
  assert.ok(broken.err.includes("unreadable config"), "should name the unreadable file"));

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed\n` : "\ncredential resolution passed\n");
process.exit(failed ? 1 : 0);
