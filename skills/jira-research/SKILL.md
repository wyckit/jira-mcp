---
name: jira-research
description: Research and analyze Jira to understand how work actually flows — what a workflow really does versus how it is drawn, which fields and qualifiers gate work reaching production, why tickets stall, what separates one environment from another, and how a ticket connects to the code that implements it. Use when investigating Jira rather than filing tickets, for questions like why do these tickets keep stalling, what determines whether inventory gets populated in production, how does this team workflow actually work, what is different about the tickets that shipped, or trace this ticket to the code that implements it.
---

# Researching Jira

Jira analysis fails in a predictable way: someone guesses a JQL query, gets a plausible-looking list, and draws a conclusion from it. The tools below are ordered to prevent that. Work down the ladder — each rung tells you what to ask at the next one.

## The one rule that matters most

**Learn the vocabulary before writing any JQL.** Every organization stores its real decision data in custom fields with opaque ids like `customfield_10200`. You cannot query, filter, or reason about a qualifier you cannot name.

Always start with `jira_list_fields`, filtered by a term from the question — `environment`, `inventory`, `release`, `validated`, `approval`. This is the single highest-value call in the whole set, and skipping it is the most common way an analysis goes wrong.

Then confirm which of those fields are actually *used* with `jira_analyze_fields` before building anything on them. A field can exist and be empty on 95% of tickets.

## The ladder

1. **Scope** — `jira_list_projects` to find the project keys in play.
2. **Vocabulary** — `jira_list_fields` (see above). Note the ids you'll need.
3. **The rules on paper** — `jira_get_project_workflow` for statuses per issue type, `jira_get_create_meta` for required fields and their allowed values. `create_meta` is the literal encoded definition of what a ticket must satisfy: required fields, permitted dropdown values, the checks enforced at creation.
4. **The rules in practice** — `jira_analyze_workflow` over a meaningful window (90 days is a good default). Compare what comes back against step 3. The gap between them is usually where the insight lives.
5. **What separates outcomes** — `jira_compare_issue_sets` with two JQL queries: work that reached the outcome you want versus work that didn't. It reports which field values are disproportionately present in each.
6. **Why** — `jira_search_text` to mine descriptions and comment threads for the qualifier, flag, or rule the aggregates pointed at. Comments are where engineers write down the actual constraints; nothing else in Jira captures that.
7. **Confirm** — `jira_get_issue`, `jira_get_changelog`, `jira_trace_graph`, `jira_get_dev_info` on the handful of tickets that the aggregates flagged. **Understanding comes from this step.** Everything above it only narrows where to look.

Don't skip to step 7 on a hunch, and don't stop at step 5 with a correlation.

## Reading the output honestly

**Aggregates produce candidates, not conclusions.** `jira_compare_issue_sets` reports co-occurrence. A field value that appears in 90% of shipped tickets and 10% of stalled ones is a *lead* — it may be the cause, a downstream effect of the cause, or an artifact of how the two JQL sets were drawn. Confirm it by reading tickets before reporting it as a finding.

**Prefer median over average for time-in-status.** A single ticket left open for months drags the mean badly. `jira_analyze_workflow` returns both, plus `maxHours` — a median far below the average means a long tail, and the tail is often the interesting part.

**`reworkTransitions` counts backward movement** — an issue re-entering a status it already occupied. High rework against a specific status usually means an unstated quality gate: work reaches that step, gets rejected for a reason nobody wrote down, and returns.

**Check `matchedTotal` against `analyzed`.** The analysis tools sample. If they analyzed 100 of 4,000 matching issues, say so when reporting, and consider narrowing the JQL instead of trusting a sample of a heterogeneous population.

**Watch for high-cardinality noise.** Fields unique per issue (summary, timestamps) can never discriminate between groups; `jira_compare_issue_sets` filters them, but the same caution applies when reading `jira_analyze_fields` output yourself.

## Tracing a ticket to code

`jira_get_dev_info` returns linked branches, commits, and pull requests. Two caveats: it assumes Bitbucket (`applicationType: "stash"`), so empty results may mean GitHub or GitLab rather than no activity; and it points *at* the code without containing it. Reading the implementation is a separate step against the repository itself.

For blast radius rather than implementation, `jira_trace_graph` walks links, subtasks, and parents breadth-first for a few hops — use it to see what a change touches before assuming it's isolated.

## Reporting findings

State what was measured, over what sample, and what remains unconfirmed. "Across 87 of 340 tickets from the last 90 days, `Inventory Validated = Yes` appears on 94% that reached production versus 11% that stalled; three tickets I read confirm this is a manual gate, and JIRA-4412's comments describe the flag that drives it" is useful. "Inventory validation causes production success" is not — it overstates what a co-occurrence measurement can support.
