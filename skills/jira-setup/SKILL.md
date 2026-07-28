---
name: jira-setup
description: Install, connect, and troubleshoot the Jira MCP server for Jira Server/Data Center. Use when Jira tools are missing or failing — connecting to Jira for the first time, choosing an install method on a locked-down machine, setting JIRA_BASE_URL or JIRA_PAT, or diagnosing errors such as an HTML response instead of JSON, a 401, a 403, or Jira tools not appearing at all.
---

# Connecting the Jira MCP server

This server talks to **Jira Server / Data Center**, authenticating a Personal Access Token as a Bearer token. It does not target Jira Cloud, which uses Basic auth with an API token and `accountId`. If the host is `*.atlassian.net`, this is the wrong server.

## Credentials

Two environment variables, never hardcoded and never committed:

| Variable | Example | Notes |
|----------|---------|-------|
| `JIRA_BASE_URL` | `https://jira.example.com` | Required. No trailing path. |
| `JIRA_PAT` | — | Required. Jira → avatar → **Profile** → **Personal Access Tokens** → **Create token**. Shown once. |

Setting them at the OS level keeps the token out of every config file, which is what makes this shareable. On Windows, the user runs this themselves in their own terminal — never paste a real token into a shared file, a repo, or a chat:

```
setx JIRA_PAT "the-token"
setx JIRA_BASE_URL "https://jira.example.com"
```

`setx` persists for *new* processes, so restart the terminal and Claude Code afterward. Verify with `echo %JIRA_PAT%` in a fresh shell.

### Or a config file

If environment variables are awkward, credentials can live in a JSON file instead. Resolution order, first hit wins:

1. `JIRA_BASE_URL` / `JIRA_PAT` environment variables
2. the path in `JIRA_MCP_CONFIG`
3. `.jira-mcp.json` in the user's home folder
4. `jira-mcp.config.json` beside `server.js` or the executable

```json
{ "baseUrl": "https://jira.example.com", "pat": "your-personal-access-token" }
```

The startup banner reports which source was used, never the value. `credentials: none` means nothing resolved.

**Never write a token into the plugin's `.mcp.json`.** That file ships inside the distributable `.plugin` and would be shared with every recipient. Use one of the four locations above.

**Never ask the user to paste their token into the conversation, and never write a real token into a file yourself.** Give the command or show the file format, and let the user fill in the value.

## Choosing an install method

| Constraint | Method |
|------------|--------|
| Nothing installable on the machine | `jira-mcp.exe` from the repo's Releases — one file, no Node, no admin, no registry |
| Node available, npm blocked | Clone or unzip, then `node server.js` — dependencies are optional |
| Normal machine | Clone, `npm install` optional |

### Running the plugin without Node

The plugin launches through `bin/jira-mcp.cmd`, which picks a runtime at startup in this order:

1. `JIRA_MCP_EXE` — full path to the standalone executable
2. `jira-mcp.exe` sitting in the plugin folder
3. `node server.js`

So on a machine with no Node, download `jira-mcp.exe` from Releases, put it anywhere, and point at it:

```
setx JIRA_MCP_EXE "C:\Tools\jira-mcp.exe"
```

Restart Claude afterward. If the server fails to start and stderr says *no runtime found*, none of the three resolved — check that the path in `JIRA_MCP_EXE` exists exactly as written.

The launcher is a Windows batch file. On macOS or Linux, use `bin/jira-mcp.sh` instead by changing the plugin's `.mcp.json` command to `sh` with that script as its argument.

Registering, once the env vars are set:

```
claude mcp add jira --scope user -- node C:/path/to/jira_mcp/server.js
```

Replace with the absolute path to `jira-mcp.exe` if using the standalone binary. `--scope user` makes it available in every project rather than only the current folder — omitting it is the usual reason tools appear in one directory and not another.

Confirm the connection by running `jira_myself`. It returns the token owner's profile.

## Diagnosing failures

**Tools don't appear at all.** The server isn't registered in this scope, or it exited on startup. Check `claude mcp list`. The server exits immediately with a clear message if `JIRA_BASE_URL` or `JIRA_PAT` is unset — a common cause is setting the variables with `setx` but not restarting Claude Code.

**"returned non-JSON (content likely from a proxy/WAF/login page)".** The request reached something that isn't Jira — almost always a corporate WAF, VPN gate, or SSO portal intercepting it. Connect to the VPN. This is expected off-network and is not a bug in the server.

**403 on every call, with an HTML body.** Same cause as above: a WAF blocking off-network traffic before Jira sees the request.

**401 on every call.** The token is wrong, revoked, or expired. PATs expire if an expiry was set at creation. Reissue and re-register.

**TLS or certificate errors.** The instance uses an internal CA. Add `NODE_EXTRA_CA_CERTS` pointing at the corporate root CA PEM.

**A specific tool fails while others work.** `jira_get_create_meta` varies across Jira DC versions, and `jira_get_dev_info` assumes Bitbucket — empty results there may mean GitHub or GitLab rather than no linked activity.

## Verify the hostname before using a new token

A mistyped Jira hostname can resolve to a parked domain owned by a third party, and the PAT is sent to it in an `Authorization` header. Confirm `JIRA_BASE_URL` is exactly right before the first call. If a token was ever sent to the wrong host, treat it as compromised: revoke and reissue.
