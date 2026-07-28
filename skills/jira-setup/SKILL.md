---
name: jira-setup
description: Install, connect, and troubleshoot the Jira MCP server for Jira Server/Data Center. Use when Jira tools are missing or failing — connecting to Jira for the first time, choosing an install method on a locked-down machine, setting JIRA_BASE_URL or JIRA_PAT, or diagnosing errors like HTML instead of JSON, 401, 403, or "tool not found".
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

**Never ask the user to paste their token into the conversation, and never write it into a file.** If a token needs to be set, give the command and let them run it.

## Choosing an install method

| Constraint | Method |
|------------|--------|
| Nothing installable on the machine | `jira-mcp.exe` from the repo's Releases — one file, no Node, no admin, no registry |
| Node available, npm blocked | Clone or unzip, then `node server.js` — dependencies are optional |
| Normal machine | Clone, `npm install` optional |

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
