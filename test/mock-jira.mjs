// Preloaded before server.js to replace global fetch with canned Jira payloads.
// Lets the analysis tools be exercised with no network and no real credentials.
import { respond } from "./fixtures.mjs";

globalThis.fetch = async (url) => {
  const u = new URL(url);
  const body = respond(u.pathname, u.searchParams.get("jql") || "");
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Map(),
    text: async () => JSON.stringify(body),
  };
};
