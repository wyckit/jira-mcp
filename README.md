# jira-mcp

An MCP server for **Jira Server / Data Center**, authenticating with a Personal Access Token (Bearer auth, REST API v2).

Built for research and analysis, not just ticket filing: read history, discover the custom fields an org actually uses, trace tickets to code, and aggregate across many issues to see how a workflow really behaves.

> Targets Jira **Server / Data Center**, not Jira Cloud. Server/DC uses `Bearer <PAT>` auth and usernames; Cloud uses Basic auth with an API token and `accountId`.

**Runs with zero dependencies.** No `npm install` required — clone and run. Useful on locked-down machines where the npm registry is unreachable, and a much smaller audit surface if your security team has to approve it.

## Tools

### Core — read and write
| Tool | What it does |
|------|--------------|
| `jira_myself` | Verify auth — returns the PAT owner's profile |
| `jira_search` | JQL search; `extraFields` pulls specific custom fields |
| `jira_get_issue` | Full issue detail, comments, links, attachments; `includeAllFields` for every populated field |
| `jira_create_issue` | Create an issue |
| `jira_update_issue` | Update summary/description/assignee/labels/priority |
| `jira_add_comment` | Comment on an issue |
| `jira_get_transitions` | List available workflow transitions |
| `jira_transition_issue` | Move an issue (by transition id or name) |
| `jira_list_projects` | List visible projects |

### Schema discovery — what fields and rules exist
| Tool | What it does |
|------|--------------|
| `jira_list_fields` | All fields including custom ones. Org-specific qualifiers live here — start here to find field ids |
| `jira_get_create_meta` | Required fields and allowed values per project/issue type — the checks enforced at creation |
| `jira_get_project_workflow` | Every issue type in a project and the statuses its workflow can reach |

### History and traversal
| Tool | What it does |
|------|--------------|
| `jira_get_changelog` | Every field change on an issue, who made it, when, plus time spent in each status |
| `jira_related_issues` | Parent, subtasks, linked issues, and epic children in one hop |
| `jira_trace_graph` | Multi-hop dependency graph (links + subtasks + parents, breadth-first) — the blast radius of a change |
| `jira_get_dev_info` | Linked branches, commits, and pull requests — the bridge from ticket to code |
| `jira_get_remote_links` | External links (Confluence, runbooks, dashboards) |

### Aggregate analysis
| Tool | What it does |
|------|--------------|
| `jira_analyze_workflow` | Across a JQL set: real transition frequencies, median/avg time per status, rework loops, cycle time |
| `jira_analyze_fields` | Across a JQL set: which fields are populated and their value distributions |
| `jira_compare_issue_sets` | Diff two JQL sets field-by-field — surfaces what separates shipped work from stalled work |
| `jira_search_text` | Regex/keyword mining across summaries, descriptions, and comment threads with context snippets — finds where a qualifier or config flag is actually discussed |

## Install as a plugin (recommended)

This repo is also a plugin: the 21 MCP tools plus two skills that teach Claude how to use them.

**If your client accepts a plugin file** (Claude Cowork and the desktop app do — they will tell you only packaged plugins are allowed), download `jira-mcp.plugin` from [Releases](https://github.com/wyckit/jira-mcp/releases) and open it. It appears as a preview you can browse and accept. Build it yourself with:

```bash
npm run package:plugin     # -> dist/jira-mcp.plugin
```

**If your client supports git marketplaces** (Claude Code CLI):

```bash
/plugin marketplace add wyckit/jira-mcp
/plugin install jira-mcp@wyckit
```

Set your credentials as environment variables first — the plugin reads them from the environment, so no token is ever written into a config file or shared repo:

```bash
setx JIRA_BASE_URL "https://your-jira-host"
setx JIRA_PAT "your-personal-access-token"
```

`setx` only affects *new* processes, so restart your terminal and Claude Code afterward.

To develop or test locally without installing:

```bash
claude --plugin-dir /path/to/jira_mcp
```

### What the skills add

MCP gives Claude the tools. The skills give it the judgment for using them — they load only when relevant, so they cost nothing until they're needed.

| Skill | Triggers on | What it carries |
|-------|-------------|-----------------|
| `jira-research` | "why do these tickets stall", "what determines whether X reaches prod", "how does this workflow actually work" | The analysis ladder — discover vocabulary before writing JQL, compare paper rules against real behaviour, treat aggregates as candidates rather than conclusions, prefer median over mean for time-in-status |
| `jira-setup` | "connect to Jira", "the Jira tools aren't working", 401/403/HTML errors | Install path selection, credential setup, and a diagnosis table (HTML response means WAF or VPN, 401 means token, 403 means network) |

`jira-research` exists because the failure mode of Jira analysis is confident wrong answers: someone guesses a JQL query, gets a plausible list, and reports a correlation as a cause. The skill encodes the ordering that prevents that.

## Install manually

Pick the row that matches what the target machine allows.

| Situation | What to use | Needs |
|-----------|-------------|-------|
| Locked-down machine, nothing installable | **`jira-mcp.exe`** from [Releases](https://github.com/wyckit/jira-mcp/releases) | nothing |
| Node available, npm blocked | clone or unzip, `node server.js` | Node 18+ |
| Normal dev machine | clone, `npm install` (optional) | Node 18+ |

### Option A — standalone executable (no Node, no install)

Download `jira-mcp.exe` from the [latest release](https://github.com/wyckit/jira-mcp/releases), put it anywhere (a user folder is fine), and point Claude Code at it:

```bash
claude mcp add jira --scope user -e JIRA_BASE_URL=https://your-jira-host -e JIRA_PAT=YOUR_TOKEN -- C:/path/to/jira-mcp.exe
```

Nothing is installed — no admin rights, no registry writes, no PATH changes, no Node. It's one file you copy and run. About 88 MB, because Node's runtime is embedded in it.

Two caveats worth knowing up front. The binary is **unsigned**, so SmartScreen may warn on first run and environments enforcing AppLocker or WDAC may refuse to execute it — that's the one failure mode this option has, and it's a policy decision you can't work around locally. And it's **Windows x64**; rebuild on another platform with `npm run build:exe` for a native binary there.

Build it yourself instead of trusting a download:

```bash
npm run build:exe     # -> dist/jira-mcp.exe
npm run test:exe      # drives the binary against a local mock Jira
```

The build needs npm on the *build* machine only (for `postject`, Node's official blob injector). The resulting executable has no such requirement.

### Option B — from source

Requires **Node 18 or newer** — that's the only prerequisite. Node 18 is when `fetch` became global, which is the one platform feature this server depends on.

```bash
git clone https://github.com/wyckit/jira-mcp
cd jira-mcp
node server.js          # already works — no install step
```

`npm install` is **optional**. It pulls in the official MCP SDK and zod, which the server prefers when present. Without them it falls back to the dependency-free implementation bundled in `lib/`. Both paths are covered by the same test suite (see [Tests](#tests)), and the startup banner on stderr tells you which one is active:

```
jira-mcp v2 connected — https://jira.example.com (runtime: lite)
```

`runtime: lite` is the bundled implementation, `runtime: sdk` is the official SDK. Force either one with `JIRA_MCP_RUNTIME=lite` or `JIRA_MCP_RUNTIME=sdk`.

If you can't use git either, downloading the repo zip works the same way — the only files needed at runtime are `server.js` and `lib/`.

## Setup

1. **Create a PAT** in Jira: avatar (top right) → **Profile** → **Personal Access Tokens** → **Create token**. Copy it — it's shown once.

2. **Register with Claude Code** (`--scope user` makes it available in every project, not just the current folder):

   ```bash
   claude mcp add jira --scope user -e JIRA_BASE_URL=https://jira.example.com -e JIRA_PAT=YOUR_TOKEN_HERE -- node /absolute/path/to/jira_mcp/server.js
   ```

   | Env var | Required | Purpose |
   |---------|----------|---------|
   | `JIRA_BASE_URL` | yes | Your Jira Server/DC base URL, e.g. `https://jira.example.com` |
   | `JIRA_PAT` | yes | Personal Access Token |
   | `NODE_EXTRA_CA_CERTS` | no | Path to a corporate root CA PEM, if TLS verification fails |
   | `JIRA_MCP_RUNTIME` | no | `lite` or `sdk` to force an implementation; defaults to auto-detect |

3. **Verify**: restart Claude Code, then ask it to run `jira_myself`. It should return your Jira profile.

## Tests

```bash
node test/run-tests.mjs     # or: npm test    — the library, no network
node test/run-exe-tests.mjs # or: npm run test:exe — the built binary, over HTTP
```

`run-tests.mjs` runs the tool surface against mocked Jira responses — no network, no credentials, no dependencies. Covers the changelog/duration math, rework detection, the transition graph, field fill rates, set comparison (including that per-issue noise fields stay filtered out), comment-thread text search, graph traversal, and schema default-filling. It runs **twice** when the SDK is installed — once on each runtime — so the dependency-free path is proven equivalent rather than assumed.

`run-exe-tests.mjs` starts a local HTTP server impersonating Jira, points `dist/jira-mcp.exe` at it, and drives the real MCP stdio protocol. This exercises the shipped binary over a real network stack, and asserts it sends `Authorization: Bearer <PAT>` correctly.

Both suites share their fixtures (`test/fixtures.mjs`), so the library and the executable are held to the same expected output.

## How it works without dependencies

MCP over stdio is newline-delimited JSON-RPC 2.0, and tool schemas are plain JSON Schema. Neither needs a library:

| File | Role |
|------|------|
| `lib/mcp-lite.mjs` | Minimal MCP server + stdio transport (`initialize`, `tools/list`, `tools/call`, `ping`) |
| `lib/zod-lite.mjs` | Builds JSON Schema from the same chained calls zod uses, applies defaults, checks required args |
| `lib/runtime.mjs` | Loads the official SDK if installed, otherwise the two above |

`server.js` imports from `lib/runtime.mjs` and is identical on both paths — there is only one copy of the tool logic, so the two runtimes cannot drift.

## A research workflow that works

Start broad, then narrow — don't open with a JQL guess:

1. `jira_list_projects` — find the project keys that matter.
2. `jira_list_fields` with a filter like `environment`, `inventory`, or `release` — learn what your org actually calls things. **Do this before writing JQL**; custom field names are the vocabulary everything else depends on.
3. `jira_get_project_workflow` and `jira_get_create_meta` — see the statuses and the rules on paper.
4. `jira_analyze_workflow` over ~90 days of tickets — see how the workflow behaves in practice, and where it diverges from the diagram.
5. `jira_compare_issue_sets` — contrast the tickets that made it to production against those that didn't.
6. `jira_search_text` — once the aggregates suggest a qualifier (a field, a flag, a check), mine descriptions and comments for where people actually discuss it. Comments are where the real rules get written down.
7. `jira_get_issue` / `jira_get_changelog` / `jira_trace_graph` / `jira_get_dev_info` on the handful of tickets the aggregates flagged — this is where actual understanding comes from.

The aggregate tools narrow the search space; they do not produce conclusions on their own. Treat what they surface as candidates to confirm by reading the tickets.

## Notes

- The PAT is read from the environment at runtime and is never stored in this repo. Keep it in your MCP registration's env config — don't hardcode or commit it.
- Many self-hosted Jira instances sit behind a VPN or a WAF. If every call returns HTML or a 403 instead of JSON, you're most likely off-network — the server reports this explicitly rather than failing with a JSON parse error.
- PATs expire if you set an expiry when creating them; a 401 from every tool usually means the token expired.
- Analysis tools sample up to 300 issues and page through results. Each `jira_analyze_workflow` issue costs a changelog fetch, so start with the default sample size on a large project.
- `jira_get_dev_info` assumes Bitbucket (`applicationType: "stash"`). If your org links GitHub or GitLab instead, that tool needs a one-line change.
- Double-check your `JIRA_BASE_URL` spelling. A typo'd hostname can resolve to a parked domain owned by someone else, and your token goes to them in an `Authorization` header.

## License

MIT
