# jira-mcp

An MCP server for **Jira Server / Data Center**, authenticating with a Personal Access Token (Bearer auth, REST API v2).

Built for research and analysis, not just ticket filing: read history, discover the custom fields an org actually uses, trace tickets to code, and aggregate across many issues to see how a workflow really behaves.

> Targets Jira **Server / Data Center**, not Jira Cloud. Server/DC uses `Bearer <PAT>` auth and usernames; Cloud uses Basic auth with an API token and `accountId`.

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

## Setup

Requires Node 18+.

1. **Create a PAT** in Jira: avatar (top right) → **Profile** → **Personal Access Tokens** → **Create token**. Copy it — it's shown once.

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Register with Claude Code** (`--scope user` makes it available in every project, not just the current folder):

   ```bash
   claude mcp add jira --scope user -e JIRA_BASE_URL=https://jira.example.com -e JIRA_PAT=YOUR_TOKEN_HERE -- node /absolute/path/to/jira_mcp/server.js
   ```

   | Env var | Required | Purpose |
   |---------|----------|---------|
   | `JIRA_BASE_URL` | yes | Your Jira Server/DC base URL, e.g. `https://jira.example.com` |
   | `JIRA_PAT` | yes | Personal Access Token |
   | `NODE_EXTRA_CA_CERTS` | no | Path to a corporate root CA PEM, if TLS verification fails |

4. **Verify**: restart Claude Code, then ask it to run `jira_myself`. It should return your Jira profile.

## Tests

```bash
npm test
```

Runs the tool surface against mocked Jira responses — no network, no credentials. Covers the changelog/duration math, rework detection, the transition graph, field fill rates, set comparison (including that per-issue noise fields stay filtered out), comment-thread text search, and graph traversal.

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
