#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
const PAT = process.env.JIRA_PAT;

if (!BASE_URL) {
  console.error(
    "JIRA_BASE_URL environment variable is required (e.g. https://jira.example.com — your Jira Server/DC base URL)."
  );
  process.exit(1);
}
if (!PAT) {
  console.error("JIRA_PAT environment variable is required (Jira Personal Access Token).");
  process.exit(1);
}

// Jira Server/Data Center PATs authenticate as a Bearer token.
// `path` is the full REST path so callers can reach api/2, agile, and dev-status alike.
async function jiraRaw(method, path, { query, body } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Jira ${method} ${path} failed (${res.status} ${res.statusText}): ${text.slice(0, 2000)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A WAF or SSO portal intercepting the call returns HTML, not JSON.
    throw new Error(
      `Jira ${method} ${path} returned non-JSON (content likely from a proxy/WAF/login page). ` +
        `First 300 chars: ${text.slice(0, 300)}`
    );
  }
}

const jira = (method, path, opts) => jiraRaw(method, `/rest/api/2${path}`, opts);

function ok(data) {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

// Trim issue payloads so responses stay readable instead of dumping every field.
function slimIssue(issue) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status?.name,
    issueType: f.issuetype?.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    created: f.created,
    updated: f.updated,
    resolution: f.resolution?.name ?? null,
    labels: f.labels,
    components: f.components?.map((c) => c.name),
    fixVersions: f.fixVersions?.map((v) => v.name),
    parent: f.parent?.key,
    url: `${BASE_URL}/browse/${issue.key}`,
  };
}

const DEFAULT_FIELDS =
  "summary,status,issuetype,priority,assignee,reporter,created,updated,resolution,resolutiondate,labels,components,fixVersions,parent";

// Page through /search until `limit` issues are collected. Jira caps a single
// response well below most analysis set sizes, so analysis tools rely on this.
async function searchAll(jql, { limit = 100, fields = DEFAULT_FIELDS, expand } = {}) {
  const issues = [];
  let startAt = 0;
  let total = null;
  while (issues.length < limit) {
    const pageSize = Math.min(100, limit - issues.length);
    const data = await jira("GET", "/search", {
      query: { jql, startAt, maxResults: pageSize, fields, expand },
    });
    total = data.total;
    issues.push(...data.issues);
    startAt += data.issues.length;
    if (data.issues.length === 0 || startAt >= data.total) break;
  }
  return { issues, total: total ?? issues.length };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

// Reconstructs the status history of an issue from its changelog.
function statusTimeline(issue) {
  const events = [];
  for (const h of issue.changelog?.histories ?? []) {
    for (const item of h.items ?? []) {
      if (item.field === "status") {
        events.push({
          at: new Date(h.created),
          from: item.fromString,
          to: item.toString,
          by: h.author?.displayName ?? null,
        });
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  return events;
}

// Time spent in each status, derived from consecutive transition timestamps.
function statusDurations(issue) {
  const events = statusTimeline(issue);
  const out = [];
  let since = new Date(issue.fields.created);
  for (const e of events) {
    out.push({ status: e.from, hours: (e.at - since) / 3.6e6 });
    since = e.at;
  }
  const currentStatus = issue.fields.status?.name;
  const resolved = Boolean(issue.fields.resolutiondate);
  const end = resolved ? new Date(issue.fields.resolutiondate) : new Date();
  out.push({ status: currentStatus, hours: (end - since) / 3.6e6, stillOpen: !resolved });
  return out.filter((d) => d.status && d.hours >= 0);
}

const server = new McpServer({ name: "jira-mcp", version: "2.0.0" });

/* ------------------------------------------------------------------ */
/* Core: auth, read, write                                             */
/* ------------------------------------------------------------------ */

server.tool(
  "jira_myself",
  "Verify authentication: returns the profile of the user the PAT belongs to.",
  {},
  async () => ok(await jira("GET", "/myself"))
);

server.tool(
  "jira_search",
  "Search issues with JQL. Returns a compact list (key, summary, status, assignee, ...).",
  {
    jql: z.string().describe('JQL query, e.g. \'project = ABC AND status != Done ORDER BY updated DESC\''),
    maxResults: z.number().int().min(1).max(500).default(25).describe("Max issues to return (paged automatically)"),
    startAt: z.number().int().min(0).default(0).describe("Pagination offset"),
    extraFields: z
      .array(z.string())
      .optional()
      .describe("Additional field ids to include, e.g. ['customfield_12345']. Use jira_list_fields to find ids."),
  },
  async ({ jql, maxResults, startAt, extraFields }) => {
    const fields = extraFields?.length ? `${DEFAULT_FIELDS},${extraFields.join(",")}` : DEFAULT_FIELDS;
    // Jira DC silently caps a single /search page at 100 — page through searchAll
    // so maxResults means what it says. startAt>0 keeps single-page semantics.
    const data =
      startAt > 0
        ? await jira("GET", "/search", { query: { jql, maxResults: Math.min(maxResults, 100), startAt, fields } })
        : await searchAll(jql, { limit: maxResults, fields }).then((r) => ({
            total: r.total,
            startAt: 0,
            issues: r.issues,
          }));
    return ok({
      total: data.total,
      startAt: data.startAt,
      returned: data.issues.length,
      issues: data.issues.map((i) => {
        const slim = slimIssue(i);
        if (extraFields?.length) {
          slim.extra = Object.fromEntries(extraFields.map((f) => [f, i.fields?.[f] ?? null]));
        }
        return slim;
      }),
    });
  }
);

server.tool(
  "jira_get_issue",
  "Get one issue by key, including description and recent comments.",
  {
    issueKey: z.string().describe("Issue key, e.g. ABC-123"),
    includeComments: z.boolean().default(true).describe("Include the comment thread"),
    includeAllFields: z
      .boolean()
      .default(false)
      .describe("Include every populated field, custom fields included (verbose but complete)"),
  },
  async ({ issueKey, includeComments, includeAllFields }) => {
    const issue = await jira("GET", `/issue/${encodeURIComponent(issueKey)}`);
    const out = {
      ...slimIssue(issue),
      description: issue.fields?.description ?? null,
      subtasks: issue.fields?.subtasks?.map((s) => ({
        key: s.key,
        summary: s.fields?.summary,
        status: s.fields?.status?.name,
      })),
      links: issue.fields?.issuelinks?.map((l) => ({
        type: l.type?.name,
        outward: l.outwardIssue ? { key: l.outwardIssue.key, summary: l.outwardIssue.fields?.summary } : undefined,
        inward: l.inwardIssue ? { key: l.inwardIssue.key, summary: l.inwardIssue.fields?.summary } : undefined,
      })),
      attachments: issue.fields?.attachment?.map((a) => ({ filename: a.filename, size: a.size, created: a.created })),
    };
    if (includeComments) {
      const comments = issue.fields?.comment?.comments ?? [];
      out.commentCount = comments.length;
      out.comments = comments.slice(-20).map((c) => ({
        author: c.author?.displayName,
        created: c.created,
        body: c.body,
      }));
    }
    if (includeAllFields) {
      const names = await jira("GET", "/field");
      const byId = new Map(names.map((f) => [f.id, f.name]));
      out.allFields = {};
      for (const [id, val] of Object.entries(issue.fields || {})) {
        if (val === null || val === undefined || (Array.isArray(val) && val.length === 0)) continue;
        out.allFields[`${byId.get(id) ?? id} (${id})`] = val;
      }
    }
    return ok(out);
  }
);

server.tool(
  "jira_create_issue",
  "Create a new issue.",
  {
    projectKey: z.string().describe("Project key, e.g. ABC"),
    issueType: z.string().default("Task").describe('Issue type name, e.g. "Task", "Bug", "Story"'),
    summary: z.string().describe("Issue summary/title"),
    description: z.string().optional().describe("Issue description (Jira wiki markup or plain text)"),
    assignee: z.string().optional().describe("Assignee username (Jira Server uses 'name', not accountId)"),
    labels: z.array(z.string()).optional().describe("Labels to apply"),
    priority: z.string().optional().describe('Priority name, e.g. "High"'),
  },
  async ({ projectKey, issueType, summary, description, assignee, labels, priority }) => {
    const fields = { project: { key: projectKey }, issuetype: { name: issueType }, summary };
    if (description) fields.description = description;
    if (assignee) fields.assignee = { name: assignee };
    if (labels) fields.labels = labels;
    if (priority) fields.priority = { name: priority };
    const data = await jira("POST", "/issue", { body: { fields } });
    return ok({ created: data.key, url: `${BASE_URL}/browse/${data.key}` });
  }
);

server.tool(
  "jira_update_issue",
  "Update fields on an existing issue (only the fields you pass are changed).",
  {
    issueKey: z.string().describe("Issue key, e.g. ABC-123"),
    summary: z.string().optional(),
    description: z.string().optional(),
    assignee: z.string().optional().describe("Assignee username; pass an empty string to unassign"),
    labels: z.array(z.string()).optional().describe("Replaces the full label list"),
    priority: z.string().optional().describe("Priority name"),
  },
  async ({ issueKey, summary, description, assignee, labels, priority }) => {
    const fields = {};
    if (summary !== undefined) fields.summary = summary;
    if (description !== undefined) fields.description = description;
    if (assignee !== undefined) fields.assignee = assignee === "" ? null : { name: assignee };
    if (labels !== undefined) fields.labels = labels;
    if (priority !== undefined) fields.priority = { name: priority };
    if (Object.keys(fields).length === 0) return ok("Nothing to update — no fields provided.");
    await jira("PUT", `/issue/${encodeURIComponent(issueKey)}`, { body: { fields } });
    return ok({ updated: issueKey, fields: Object.keys(fields) });
  }
);

server.tool(
  "jira_add_comment",
  "Add a comment to an issue.",
  {
    issueKey: z.string().describe("Issue key, e.g. ABC-123"),
    body: z.string().describe("Comment text (Jira wiki markup or plain text)"),
  },
  async ({ issueKey, body }) => {
    const data = await jira("POST", `/issue/${encodeURIComponent(issueKey)}/comment`, { body: { body } });
    return ok({ commented: issueKey, commentId: data.id });
  }
);

server.tool(
  "jira_get_transitions",
  "List the workflow transitions currently available for an issue (use before jira_transition_issue).",
  { issueKey: z.string().describe("Issue key, e.g. ABC-123") },
  async ({ issueKey }) => {
    const data = await jira("GET", `/issue/${encodeURIComponent(issueKey)}/transitions`);
    return ok(data.transitions.map((t) => ({ id: t.id, name: t.name, toStatus: t.to?.name })));
  }
);

server.tool(
  "jira_transition_issue",
  "Move an issue through its workflow (e.g. to In Progress or Done). Accepts a transition id or name.",
  {
    issueKey: z.string().describe("Issue key, e.g. ABC-123"),
    transition: z.string().describe('Transition id or name, e.g. "31" or "Done"'),
    comment: z.string().optional().describe("Optional comment to add with the transition"),
  },
  async ({ issueKey, transition, comment }) => {
    let id = transition;
    if (!/^\d+$/.test(transition)) {
      const data = await jira("GET", `/issue/${encodeURIComponent(issueKey)}/transitions`);
      const match = data.transitions.find((t) => t.name.toLowerCase() === transition.toLowerCase());
      if (!match) {
        throw new Error(
          `No transition named "${transition}" on ${issueKey}. Available: ${data.transitions.map((t) => t.name).join(", ")}`
        );
      }
      id = match.id;
    }
    const body = { transition: { id } };
    if (comment) body.update = { comment: [{ add: { body: comment } }] };
    await jira("POST", `/issue/${encodeURIComponent(issueKey)}/transitions`, { body });
    return ok({ transitioned: issueKey, transition });
  }
);

server.tool(
  "jira_list_projects",
  "List projects visible to the authenticated user.",
  {},
  async () => {
    const data = await jira("GET", "/project");
    return ok(data.map((p) => ({ key: p.key, name: p.name, type: p.projectTypeKey })));
  }
);

/* ------------------------------------------------------------------ */
/* Schema discovery: what fields and rules exist                       */
/* ------------------------------------------------------------------ */

server.tool(
  "jira_list_fields",
  "List all Jira fields including custom fields. Org-specific data (environment, release train, " +
    "inventory qualifiers) lives in custom fields — start here to find their ids before querying them.",
  {
    filter: z
      .string()
      .optional()
      .describe('Case-insensitive substring to filter field names, e.g. "environment", "inventory", "release"'),
    customOnly: z.boolean().default(false).describe("Only return custom fields"),
  },
  async ({ filter, customOnly }) => {
    let fields = await jira("GET", "/field");
    if (customOnly) fields = fields.filter((f) => f.custom);
    if (filter) {
      const q = filter.toLowerCase();
      fields = fields.filter((f) => f.name?.toLowerCase().includes(q) || f.id?.toLowerCase().includes(q));
    }
    return ok({
      count: fields.length,
      fields: fields.map((f) => ({
        id: f.id,
        name: f.name,
        custom: f.custom,
        type: f.schema?.type,
        customType: f.schema?.custom?.split(":").pop(),
        searchableAs: f.clauseNames?.[0],
      })),
    });
  }
);

server.tool(
  "jira_get_create_meta",
  "Show which fields a project/issue-type requires and what values they allow. This is the literal " +
    "definition of the qualifiers and checks enforced at ticket creation — including allowed values " +
    "for environment, component, and other dropdowns.",
  {
    projectKey: z.string().describe("Project key, e.g. ABC"),
    issueType: z.string().optional().describe('Issue type name to narrow to, e.g. "Bug"'),
    requiredOnly: z.boolean().default(false).describe("Only show required fields"),
  },
  async ({ projectKey, issueType, requiredOnly }) => {
    const data = await jira("GET", "/issue/createmeta", {
      query: {
        projectKeys: projectKey,
        issuetypeNames: issueType,
        expand: "projects.issuetypes.fields",
      },
    });
    const project = data.projects?.[0];
    if (!project) throw new Error(`No createmeta returned for project ${projectKey} (check the key and your permissions).`);
    return ok({
      project: { key: project.key, name: project.name },
      issueTypes: (project.issuetypes ?? []).map((it) => ({
        name: it.name,
        subtask: it.subtask,
        fields: Object.entries(it.fields ?? {})
          .filter(([, f]) => !requiredOnly || f.required)
          .map(([id, f]) => ({
            id,
            name: f.name,
            required: f.required,
            type: f.schema?.type,
            allowedValues: f.allowedValues?.slice(0, 50).map((v) => v.name ?? v.value ?? v.id),
          })),
      })),
    });
  }
);

server.tool(
  "jira_get_project_workflow",
  "Show every issue type in a project and the full set of statuses its workflow can reach. " +
    "Use this to map what a workflow actually looks like before analyzing how issues move through it.",
  { projectKey: z.string().describe("Project key, e.g. ABC") },
  async ({ projectKey }) => {
    const data = await jira("GET", `/project/${encodeURIComponent(projectKey)}/statuses`);
    return ok(
      data.map((it) => ({
        issueType: it.name,
        statuses: it.statuses?.map((s) => ({ name: s.name, category: s.statusCategory?.name })),
      }))
    );
  }
);

/* ------------------------------------------------------------------ */
/* History and traversal                                               */
/* ------------------------------------------------------------------ */

server.tool(
  "jira_get_changelog",
  "Full change history of one issue: every field change, who made it, and when. The authoritative " +
    "record of how a ticket actually moved through its workflow.",
  {
    issueKey: z.string().describe("Issue key, e.g. ABC-123"),
    fieldFilter: z
      .string()
      .optional()
      .describe('Only show changes to this field, e.g. "status", "assignee", "Fix Version"'),
  },
  async ({ issueKey, fieldFilter }) => {
    const issue = await jira("GET", `/issue/${encodeURIComponent(issueKey)}`, {
      query: { expand: "changelog", fields: DEFAULT_FIELDS },
    });
    const q = fieldFilter?.toLowerCase();
    const history = (issue.changelog?.histories ?? [])
      .sort((a, b) => new Date(a.created) - new Date(b.created))
      .flatMap((h) =>
        (h.items ?? [])
          .filter((item) => !q || item.field?.toLowerCase().includes(q))
          .map((item) => ({
            at: h.created,
            by: h.author?.displayName ?? null,
            field: item.field,
            from: item.fromString,
            to: item.toString,
          }))
      );
    return ok({
      key: issue.key,
      summary: issue.fields?.summary,
      created: issue.fields?.created,
      currentStatus: issue.fields?.status?.name,
      changeCount: history.length,
      history,
      timeInStatus: statusDurations(issue).map((d) => ({ ...d, hours: round1(d.hours) })),
    });
  }
);

server.tool(
  "jira_related_issues",
  "Map everything connected to an issue in one hop: parent, subtasks, linked issues (blocks, " +
    "relates to, duplicates), and epic children. Use this to trace how a change spans an application.",
  { issueKey: z.string().describe("Issue key, e.g. ABC-123") },
  async ({ issueKey }) => {
    const issue = await jira("GET", `/issue/${encodeURIComponent(issueKey)}`, { query: { fields: `${DEFAULT_FIELDS},issuelinks,subtasks` } });
    const out = {
      key: issue.key,
      summary: issue.fields?.summary,
      parent: issue.fields?.parent
        ? { key: issue.fields.parent.key, summary: issue.fields.parent.fields?.summary }
        : null,
      subtasks: (issue.fields?.subtasks ?? []).map((s) => ({
        key: s.key,
        summary: s.fields?.summary,
        status: s.fields?.status?.name,
      })),
      links: (issue.fields?.issuelinks ?? []).map((l) => {
        const other = l.outwardIssue ?? l.inwardIssue;
        return {
          relationship: l.outwardIssue ? l.type?.outward : l.type?.inward,
          key: other?.key,
          summary: other?.fields?.summary,
          status: other?.fields?.status?.name,
        };
      }),
    };
    // Epic children live behind a custom field whose name varies by instance;
    // try the common JQL forms and report cleanly if neither is available.
    for (const jql of [`"Epic Link" = ${issueKey}`, `parent = ${issueKey}`]) {
      try {
        const kids = await jira("GET", "/search", { query: { jql, maxResults: 100, fields: DEFAULT_FIELDS } });
        if (kids.issues?.length) {
          out.epicChildren = kids.issues.map(slimIssue);
          break;
        }
      } catch {
        // JQL clause not supported on this instance — fall through.
      }
    }
    return ok(out);
  }
);

server.tool(
  "jira_get_dev_info",
  "Show development activity linked to an issue: branches, commits, and pull requests. This is the " +
    "bridge from a ticket to the code that implements it.",
  { issueKey: z.string().describe("Issue key, e.g. ABC-123") },
  async ({ issueKey }) => {
    const issue = await jira("GET", `/issue/${encodeURIComponent(issueKey)}`, { query: { fields: "summary" } });
    const results = {};
    for (const dataType of ["repository", "pullrequest", "branch"]) {
      try {
        const data = await jiraRaw("GET", "/rest/dev-status/1.0/issue/detail", {
          query: { issueId: issue.id, applicationType: "stash", dataType },
        });
        results[dataType] = data?.detail ?? [];
      } catch (e) {
        results[dataType] = { unavailable: e.message.slice(0, 200) };
      }
    }
    return ok({
      key: issue.key,
      summary: issue.fields?.summary,
      note: "Empty results usually mean no linked dev tool, or a different applicationType (github/gitlab) than 'stash'.",
      development: results,
    });
  }
);

server.tool(
  "jira_get_remote_links",
  "List external links attached to an issue (Confluence pages, runbooks, dashboards). Often where " +
    "the real design and environment documentation lives.",
  { issueKey: z.string().describe("Issue key, e.g. ABC-123") },
  async ({ issueKey }) => {
    const data = await jira("GET", `/issue/${encodeURIComponent(issueKey)}/remotelink`);
    return ok((data ?? []).map((l) => ({ title: l.object?.title, url: l.object?.url, relationship: l.relationship })));
  }
);

/* ------------------------------------------------------------------ */
/* Aggregate analysis across many issues                               */
/* ------------------------------------------------------------------ */

server.tool(
  "jira_analyze_workflow",
  "Aggregate workflow analysis across a set of issues: which status transitions actually happen and " +
    "how often, median/average time spent in each status, rework loops, and where work stalls. " +
    "Answers 'how does this workflow really behave' rather than how it's drawn.",
  {
    jql: z.string().describe('JQL selecting the issues to analyze, e.g. \'project = ABC AND created >= -90d\''),
    maxIssues: z.number().int().min(1).max(300).default(75).describe("How many issues to sample (each costs a changelog fetch)"),
  },
  async ({ jql, maxIssues }) => {
    const { issues, total } = await searchAll(jql, {
      limit: maxIssues,
      fields: `${DEFAULT_FIELDS},resolutiondate`,
      expand: "changelog",
    });
    if (!issues.length) return ok({ jql, matched: 0, note: "No issues matched this JQL." });

    const transitions = new Map();
    const statusHours = new Map();
    const cycleTimes = [];
    let reworkCount = 0;

    for (const issue of issues) {
      const events = statusTimeline(issue);
      const seen = new Set();
      for (const e of events) {
        const key = `${e.from} → ${e.to}`;
        transitions.set(key, (transitions.get(key) ?? 0) + 1);
        if (seen.has(e.to)) reworkCount++;
        seen.add(e.to);
      }
      for (const d of statusDurations(issue)) {
        if (!statusHours.has(d.status)) statusHours.set(d.status, []);
        statusHours.get(d.status).push(d.hours);
      }
      if (issue.fields.resolutiondate) {
        cycleTimes.push((new Date(issue.fields.resolutiondate) - new Date(issue.fields.created)) / 3.6e6);
      }
    }

    const statusStats = [...statusHours.entries()]
      .map(([status, hrs]) => ({
        status,
        occurrences: hrs.length,
        medianHours: round1(median(hrs)),
        avgHours: round1(hrs.reduce((a, b) => a + b, 0) / hrs.length),
        maxHours: round1(Math.max(...hrs)),
      }))
      .sort((a, b) => b.medianHours - a.medianHours);

    return ok({
      jql,
      analyzed: issues.length,
      matchedTotal: total,
      resolvedCount: cycleTimes.length,
      cycleTimeDays: {
        median: round1(median(cycleTimes) / 24),
        avg: round1(cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length / 24 : null),
      },
      reworkTransitions: reworkCount,
      reworkNote: "Count of transitions into a status an issue had already been in — a proxy for bounce-back/rework.",
      timeInStatus: statusStats,
      transitionFrequency: [...transitions.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([transition, count]) => ({ transition, count })),
    });
  }
);

server.tool(
  "jira_analyze_fields",
  "Across a set of issues, show which fields are actually populated and the distribution of their " +
    "values. Use this to discover the real qualifiers on a class of work — which environment, " +
    "component, or custom flag values co-occur with tickets that reached production.",
  {
    jql: z.string().describe("JQL selecting the issues to analyze"),
    maxIssues: z.number().int().min(1).max(300).default(100).describe("How many issues to sample"),
    minFillRate: z
      .number()
      .min(0)
      .max(1)
      .default(0.1)
      .describe("Hide fields populated on fewer than this fraction of issues (0-1)"),
  },
  async ({ jql, maxIssues, minFillRate }) => {
    const [{ issues, total }, fieldDefs] = await Promise.all([
      searchAll(jql, { limit: maxIssues, fields: "*navigable" }),
      jira("GET", "/field"),
    ]);
    if (!issues.length) return ok({ jql, matched: 0, note: "No issues matched this JQL." });

    const nameById = new Map(fieldDefs.map((f) => [f.id, f.name]));
    const stats = new Map();

    // Reduce any Jira field value to comparable scalar labels for counting.
    const labelsOf = (val) => {
      if (val === null || val === undefined) return [];
      if (Array.isArray(val)) return val.flatMap(labelsOf);
      if (typeof val === "object") {
        const l = val.name ?? val.value ?? val.displayName ?? val.key;
        return l ? [String(l)] : ["<object>"];
      }
      if (typeof val === "string" && val.length > 60) return ["<long text>"];
      return [String(val)];
    };

    for (const issue of issues) {
      for (const [id, val] of Object.entries(issue.fields ?? {})) {
        if (val === null || val === undefined || (Array.isArray(val) && val.length === 0)) continue;
        if (!stats.has(id)) stats.set(id, { populated: 0, values: new Map() });
        const s = stats.get(id);
        s.populated++;
        for (const label of labelsOf(val)) s.values.set(label, (s.values.get(label) ?? 0) + 1);
      }
    }

    const rows = [...stats.entries()]
      .filter(([, s]) => s.populated / issues.length >= minFillRate)
      .map(([id, s]) => ({
        field: nameById.get(id) ?? id,
        id,
        custom: id.startsWith("customfield_"),
        fillRate: `${Math.round((s.populated / issues.length) * 100)}%`,
        distinctValues: s.values.size,
        topValues:
          s.values.size <= 25
            ? [...s.values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([v, c]) => `${v} (${c})`)
            : ["<high cardinality — omitted>"],
      }))
      .sort((a, b) => parseInt(b.fillRate) - parseInt(a.fillRate));

    return ok({ jql, analyzed: issues.length, matchedTotal: total, fields: rows });
  }
);

server.tool(
  "jira_compare_issue_sets",
  "Compare two JQL result sets field-by-field and report where they differ. Built for " +
    "environment-to-environment questions: run it on tickets that succeeded in production versus " +
    "those that did not, and it surfaces which fields and values separate the two groups.",
  {
    jqlA: z.string().describe('First set, e.g. \'project = ABC AND fixVersion = "Prod 24.1" AND resolution = Done\''),
    jqlB: z.string().describe("Second set to compare against"),
    labelA: z.string().default("A").describe("Readable name for the first set"),
    labelB: z.string().default("B").describe("Readable name for the second set"),
    maxIssues: z.number().int().min(1).max(300).default(100).describe("Max issues sampled per set"),
  },
  async ({ jqlA, jqlB, labelA, labelB, maxIssues }) => {
    const collect = async (jql) => {
      const { issues, total } = await searchAll(jql, { limit: maxIssues, fields: "*navigable" });
      const counts = new Map();
      const distinct = new Map();
      for (const issue of issues) {
        for (const [id, val] of Object.entries(issue.fields ?? {})) {
          if (val === null || val === undefined || (Array.isArray(val) && val.length === 0)) continue;
          const arr = Array.isArray(val) ? val : [val];
          for (const v of arr) {
            const label =
              typeof v === "object" ? v.name ?? v.value ?? v.displayName ?? v.key ?? "<object>" : String(v);
            if (String(label).length > 60) continue;
            counts.set(`${id}|${label}`, (counts.get(`${id}|${label}`) ?? 0) + 1);
            if (!distinct.has(id)) distinct.set(id, new Set());
            distinct.get(id).add(label);
          }
        }
      }
      return { counts, distinct, n: issues.length, total };
    };

    const [a, b, fieldDefs] = await Promise.all([collect(jqlA), collect(jqlB), jira("GET", "/field")]);
    if (!a.n && !b.n) return ok({ note: "Neither JQL matched any issues." });
    const nameById = new Map(fieldDefs.map((f) => [f.id, f.name]));

    // Fields that are unique or near-unique per issue (summary, timestamps, free text)
    // can never be real discriminators — drop them so signal isn't buried in noise.
    const PER_ISSUE_NOISE = new Set([
      "summary", "description", "created", "updated", "resolutiondate", "lastViewed",
      "duedate", "worklog", "comment", "attachment", "timespent", "aggregatetimespent",
      "workratio", "environment", "thumbnail",
    ]);
    const distinctTotal = new Map();
    for (const src of [a.distinct, b.distinct]) {
      for (const [id, set] of src) {
        if (!distinctTotal.has(id)) distinctTotal.set(id, new Set());
        for (const v of set) distinctTotal.get(id).add(v);
      }
    }
    const cardinalityCap = Math.max(6, (a.n + b.n) * 0.5);

    const keys = new Set([...a.counts.keys(), ...b.counts.keys()]);
    const diffs = [];
    for (const k of keys) {
      const sep = k.indexOf("|");
      const id = k.slice(0, sep);
      const label = k.slice(sep + 1);
      if (PER_ISSUE_NOISE.has(id)) continue;
      if ((distinctTotal.get(id)?.size ?? 0) > cardinalityCap) continue;
      const pctA = a.n ? (a.counts.get(k) ?? 0) / a.n : 0;
      const pctB = b.n ? (b.counts.get(k) ?? 0) / b.n : 0;
      const delta = pctA - pctB;
      if (Math.abs(delta) < 0.15) continue; // ignore noise-level differences
      diffs.push({
        field: nameById.get(id) ?? id,
        value: label,
        [`${labelA}_pct`]: `${Math.round(pctA * 100)}%`,
        [`${labelB}_pct`]: `${Math.round(pctB * 100)}%`,
        delta: Math.round(delta * 100),
      });
    }
    diffs.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

    return ok({
      [labelA]: { jql: jqlA, sampled: a.n, matchedTotal: a.total },
      [labelB]: { jql: jqlB, sampled: b.n, matchedTotal: b.total },
      note:
        "delta = percentage-point difference in how often a field value appears in " +
        `${labelA} vs ${labelB}. Positive means more common in ${labelA}. ` +
        "This is descriptive co-occurrence, not causation — confirm any candidate qualifier against the tickets themselves.",
      differences: diffs.slice(0, 60),
    });
  }
);

server.tool(
  "jira_search_text",
  "Full-text mine a set of issues: scan summaries, descriptions, and comment threads for a regex or " +
    "keyword and return each match with surrounding context. Jira's own search can't look inside " +
    "comments well — use this to find where a qualifier, config flag, or process rule is actually " +
    "discussed across tickets.",
  {
    jql: z.string().describe("JQL selecting the issues to scan"),
    pattern: z.string().describe('Case-insensitive regex or plain keyword, e.g. "inventory.{0,30}qualif" or "feature flag"'),
    scope: z.enum(["all", "summary", "description", "comments"]).default("all").describe("Which text to scan"),
    maxIssues: z.number().int().min(1).max(300).default(100).describe("How many issues to scan"),
    contextChars: z.number().int().min(40).max(400).default(140).describe("Characters of context around each match"),
  },
  async ({ jql, pattern, scope, maxIssues, contextChars }) => {
    let re;
    try {
      re = new RegExp(pattern, "gi");
    } catch (e) {
      throw new Error(`Invalid regex "${pattern}": ${e.message}`);
    }
    const { issues, total } = await searchAll(jql, {
      limit: maxIssues,
      fields: "summary,status,description,comment",
    });

    const snip = (text, source) => {
      const out = [];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null && out.length < 5) {
        const start = Math.max(0, m.index - contextChars / 2);
        const end = Math.min(text.length, m.index + m[0].length + contextChars / 2);
        out.push({ source, snippet: text.slice(start, end).replace(/\s+/g, " ").trim() });
        if (m.index === re.lastIndex) re.lastIndex++; // zero-length match guard
      }
      return out;
    };

    const hits = [];
    for (const issue of issues) {
      const f = issue.fields ?? {};
      const matches = [];
      if (scope === "all" || scope === "summary") matches.push(...snip(f.summary ?? "", "summary"));
      if (scope === "all" || scope === "description") matches.push(...snip(f.description ?? "", "description"));
      if (scope === "all" || scope === "comments") {
        for (const c of f.comment?.comments ?? []) {
          matches.push(
            ...snip(c.body ?? "", `comment by ${c.author?.displayName ?? "unknown"} on ${c.created?.slice(0, 10)}`)
          );
        }
      }
      if (matches.length) {
        hits.push({
          key: issue.key,
          summary: f.summary,
          status: f.status?.name,
          url: `${BASE_URL}/browse/${issue.key}`,
          matches,
        });
      }
    }
    return ok({
      jql,
      pattern,
      scanned: issues.length,
      matchedTotal: total,
      issuesWithMatches: hits.length,
      hits,
    });
  }
);

server.tool(
  "jira_trace_graph",
  "Trace the dependency graph around an issue for multiple hops: follows issue links, subtasks, and " +
    "parents breadth-first and returns the nodes and edges. Use this to map the full blast radius of " +
    "a change across an application — what it blocks, what it depends on, and how work clusters.",
  {
    issueKey: z.string().describe("Starting issue key, e.g. ABC-123"),
    depth: z.number().int().min(1).max(4).default(2).describe("How many hops to follow"),
    maxNodes: z.number().int().min(2).max(100).default(40).describe("Stop after this many issues (each costs a fetch)"),
  },
  async ({ issueKey, depth, maxNodes }) => {
    const nodes = new Map();
    const edges = [];
    const seenEdges = new Set();
    let frontier = [issueKey.toUpperCase()];
    const visited = new Set();

    const addEdge = (from, rel, to) => {
      const k = `${from}|${rel}|${to}`;
      if (!seenEdges.has(k)) {
        seenEdges.add(k);
        edges.push({ from, relationship: rel, to });
      }
    };

    for (let hop = 0; hop < depth && frontier.length && nodes.size < maxNodes; hop++) {
      const next = [];
      for (const key of frontier) {
        if (visited.has(key) || nodes.size >= maxNodes) continue;
        visited.add(key);
        let issue;
        try {
          issue = await jira("GET", `/issue/${encodeURIComponent(key)}`, {
            query: { fields: `${DEFAULT_FIELDS},issuelinks,subtasks` },
          });
        } catch (e) {
          nodes.set(key, { key, error: e.message.slice(0, 150) });
          continue;
        }
        nodes.set(issue.key, { ...slimIssue(issue), hop });

        const f = issue.fields ?? {};
        if (f.parent) {
          addEdge(issue.key, "child of", f.parent.key);
          next.push(f.parent.key);
        }
        for (const s of f.subtasks ?? []) {
          addEdge(issue.key, "parent of", s.key);
          next.push(s.key);
        }
        for (const l of f.issuelinks ?? []) {
          const other = l.outwardIssue ?? l.inwardIssue;
          if (!other) continue;
          addEdge(issue.key, (l.outwardIssue ? l.type?.outward : l.type?.inward) ?? "linked to", other.key);
          next.push(other.key);
        }
      }
      frontier = [...new Set(next)].filter((k) => !visited.has(k));
    }

    return ok({
      root: issueKey.toUpperCase(),
      depthRequested: depth,
      nodeCount: nodes.size,
      truncated: nodes.size >= maxNodes || frontier.length > 0,
      unexpanded: frontier.slice(0, 20),
      nodes: [...nodes.values()],
      edges,
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`jira-mcp v2 connected — ${BASE_URL}`);
