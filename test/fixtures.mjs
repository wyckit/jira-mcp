// Canned Jira payloads shared by every test harness: the in-process fetch stub
// (mock-jira.mjs) and the HTTP mock used to exercise the compiled executable.

export const FIELDS = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
  { id: "status", name: "Status", custom: false, schema: { type: "status" } },
  { id: "customfield_10100", name: "Environment", custom: true, schema: { type: "option" } },
  { id: "customfield_10200", name: "Inventory Validated", custom: true, schema: { type: "option" } },
];

function issue(key, id, created, transitions, resolutiondate, extra = {}) {
  return {
    key,
    id,
    fields: {
      summary: `Summary for ${key}`,
      created,
      resolutiondate: resolutiondate ?? null,
      status: { name: transitions.length ? transitions[transitions.length - 1].to : "Open" },
      issuetype: { name: "Task" },
      ...extra,
    },
    changelog: {
      histories: transitions.map((t) => ({
        created: t.at,
        author: { displayName: "Test User" },
        items: [{ field: "status", fromString: t.from, toString: t.to }],
      })),
    },
  };
}

// ABC-1: rework loop (In Review bounces back), a qualifier mentioned in a
// comment, a blocks-link to ABC-2 and a subtask ABC-3.
export const ABC1 = issue(
  "ABC-1",
  "10001",
  "2026-01-01T00:00:00.000+0000",
  [
    { at: "2026-01-02T00:00:00.000+0000", from: "Open", to: "In Progress" },
    { at: "2026-01-05T00:00:00.000+0000", from: "In Progress", to: "In Review" },
    { at: "2026-01-06T00:00:00.000+0000", from: "In Review", to: "In Progress" },
    { at: "2026-01-08T00:00:00.000+0000", from: "In Progress", to: "Done" },
  ],
  "2026-01-08T00:00:00.000+0000",
  {
    customfield_10100: { value: "PROD" },
    customfield_10200: { value: "Yes" },
    description: "Enable feed. The inventory qualifier check must pass before production load runs.",
    comment: {
      comments: [
        {
          author: { displayName: "Jane Dev" },
          created: "2026-01-05T12:00:00.000+0000",
          body: "Blocked until the inventory qualifier flag INV_VALID=Y is set in the staging config.",
        },
      ],
    },
    issuelinks: [
      {
        type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
        outwardIssue: { key: "ABC-2", fields: { summary: "Summary for ABC-2" } },
      },
    ],
    subtasks: [{ key: "ABC-3", fields: { summary: "Summary for ABC-3", status: { name: "In Progress" } } }],
  }
);

export const ABC2 = issue(
  "ABC-2",
  "10002",
  "2026-01-01T00:00:00.000+0000",
  [
    { at: "2026-01-03T00:00:00.000+0000", from: "Open", to: "In Progress" },
    { at: "2026-01-04T00:00:00.000+0000", from: "In Progress", to: "Done" },
  ],
  "2026-01-04T00:00:00.000+0000",
  { customfield_10100: { value: "PROD" }, customfield_10200: { value: "Yes" } }
);

// Never validated, stuck in UAT — the "stalled" comparison set.
export const ABC3 = issue(
  "ABC-3",
  "10003",
  "2026-01-01T00:00:00.000+0000",
  [{ at: "2026-01-02T00:00:00.000+0000", from: "Open", to: "In Progress" }],
  null,
  {
    customfield_10100: { value: "UAT" },
    customfield_10200: { value: "No" },
    parent: { key: "ABC-1", fields: { summary: "Summary for ABC-1" } },
  }
);

const BY_KEY = { "ABC-1": ABC1, "ABC-2": ABC2, "ABC-3": ABC3 };

// Maps a Jira REST path + jql to the canned response body.
export function respond(pathname, jql = "") {
  const issueMatch = pathname.match(/\/rest\/api\/2\/issue\/(ABC-\d+)/);
  if (pathname.endsWith("/rest/api/2/field")) return FIELDS;
  if (pathname.endsWith("/rest/api/2/search")) {
    const set = jql.includes("FAILED") ? [ABC3] : jql.includes("PRODSET") ? [ABC1, ABC2] : [ABC1, ABC2, ABC3];
    return { total: set.length, startAt: 0, maxResults: 100, issues: set };
  }
  if (issueMatch && BY_KEY[issueMatch[1]]) return BY_KEY[issueMatch[1]];
  return {};
}
