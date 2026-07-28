// Validates the plugin manifest and skill frontmatter.
//
// Exists because a regex that merely finds a `description:` line is not enough:
// YAML plain scalars cannot contain ": " (colon-space), and when one does the
// whole frontmatter block fails to parse and every field is silently dropped —
// the skill then loads with empty metadata and never triggers. That failure is
// invisible without actually parsing.
//
//   node test/validate-plugin.mjs
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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

// Parses the strict subset of YAML that skill frontmatter is allowed to use,
// and rejects anything a real YAML parser would choke on.
function parseFrontmatter(text, label) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`${label}: no frontmatter block`);
  const out = {};
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) throw new Error(`${label}: line is not a key/value pair -> ${line.slice(0, 60)}`);
    const [, key, value] = kv;
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (!quoted && value.includes(": ")) {
      throw new Error(
        `${label}: '${key}' is an unquoted YAML scalar containing ": " — the frontmatter will fail to ` +
          `parse and all fields will be dropped. Remove the colon or quote the value.`
      );
    }
    if (!quoted && /^[&*!|>%@`]/.test(value)) {
      throw new Error(`${label}: '${key}' starts with a reserved YAML character -> ${value[0]}`);
    }
    out[key] = quoted ? value.slice(1, -1) : value;
  }
  return out;
}

console.log("\nplugin validation\n");

t("plugin.json is valid JSON with a kebab-case name", () => {
  const p = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  if (!p.name) throw new Error("missing name");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.name)) throw new Error(`name must be kebab-case, got "${p.name}"`);
  if (!p.description) throw new Error("missing description");
  if (!/^\d+\.\d+\.\d+$/.test(p.version ?? "")) throw new Error(`version must be semver, got "${p.version}"`);
});

t(".mcp.json declares servers with portable paths and no literal credentials", () => {
  const raw = readFileSync(join(root, ".mcp.json"), "utf8");
  const cfg = JSON.parse(raw);
  if (!cfg.mcpServers || !Object.keys(cfg.mcpServers).length) throw new Error("no mcpServers declared");
  if (!raw.includes("${CLAUDE_PLUGIN_ROOT}")) throw new Error("server paths must use ${CLAUDE_PLUGIN_ROOT}");
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    for (const [k, v] of Object.entries(server.env ?? {})) {
      if (!/^\$\{[A-Z_]+\}$/.test(v)) {
        throw new Error(`${name}.env.${k} must be an environment reference like \${VAR}, got "${v}"`);
      }
    }
    if (/[A-Za-z]:[\\/]/.test(JSON.stringify(server.args ?? []))) {
      throw new Error(`${name} has a hardcoded absolute path in args`);
    }
  }
});

const skillsDir = join(root, "skills");
if (!existsSync(skillsDir)) {
  console.error("  FAIL skills/ directory missing");
  failed++;
} else {
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, "SKILL.md");
    t(`skills/${name}/SKILL.md frontmatter parses and is complete`, () => {
      if (!existsSync(file)) throw new Error("no SKILL.md");
      const fm = parseFrontmatter(readFileSync(file, "utf8"), name);
      if (!fm.name) throw new Error("frontmatter has no name");
      if (fm.name !== name) throw new Error(`frontmatter name "${fm.name}" != directory "${name}"`);
      if (!fm.description) throw new Error("frontmatter has no description");
      if (fm.description.length < 40) throw new Error("description too short to trigger reliably");
    });
  }
}

console.log(failed ? `\n${failed} failed\n` : "\nplugin validation passed\n");
process.exit(failed ? 1 : 0);
