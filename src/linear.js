// Linear GraphQL client and query/mutation helpers used by the cron, the
// real-time webhook handler, and the manual toolkit endpoints.

const LINEAR_API = "https://api.linear.app/graphql";

async function linearQuery(env, query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("Linear API errors:", JSON.stringify(json.errors));
    throw new Error("Linear API error");
  }
  return json.data;
}

// Issues with a due date on or before `today + DUE_LOOKAHEAD_DAYS`,
// excluding completed/canceled work.
export async function fetchDueIssues(env) {
  const lookahead = parseInt(env.DUE_LOOKAHEAD_DAYS || "3", 10);
  const until = new Date(Date.now() + lookahead * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // The date is interpolated (it's our own value, fixed YYYY-MM-DD format) to
  // avoid declaring Linear's scalar type name in the query.
  const query = `
    query DueIssues {
      issues(
        first: 100
        filter: {
          dueDate: { lte: "${until}" }
          state: { type: { nin: ["completed", "canceled"] } }
        }
      ) {
        nodes {
          identifier
          title
          dueDate
          url
          assignee { name }
          team { key }
          labels { nodes { name } }
        }
      }
    }`;

  const data = await linearQuery(env, query);
  return (data.issues?.nodes || [])
    .filter((i) => i.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// Counts active (non-archived) issues — the figure that matters for the free
// plan's 250 cap. Linear's `issues` query excludes archived issues by default.
// Pages until exhausted or `hardCap` is reached so we never loop unbounded.
export async function fetchActiveIssueCount(env, hardCap = 500) {
  let count = 0;
  let after = null;
  let hasNext = true;
  while (hasNext && count < hardCap) {
    const query = `
      query Count($after: String) {
        issues(first: 100, after: $after) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`;
    const data = await linearQuery(env, query, { after });
    const conn = data.issues;
    count += conn.nodes.length;
    hasNext = conn.pageInfo.hasNextPage;
    after = conn.pageInfo.endCursor;
  }
  return { count, capped: hasNext };
}

export async function getTeamId(env, teamKey) {
  const query = `
    query TeamByKey($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 1) {
        nodes { id }
      }
    }`;
  const data = await linearQuery(env, query, { key: teamKey });
  return data.teams?.nodes?.[0]?.id || null;
}

export async function getProjectId(env, name) {
  const query = `
    query ProjectByName($name: String!) {
      projects(first: 1, filter: { name: { eq: $name } }) {
        nodes { id }
      }
    }`;
  const data = await linearQuery(env, query, { name });
  return data.projects?.nodes?.[0]?.id || null;
}

export async function createIssue(env, { teamId, title, description, dueDate, labelIds, assigneeId, stateId, projectId }) {
  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { identifier url }
      }
    }`;
  const input = { teamId, title };
  if (description) input.description = description;
  if (dueDate) input.dueDate = dueDate;
  if (labelIds?.length) input.labelIds = labelIds;
  if (assigneeId) input.assigneeId = assigneeId;
  if (stateId) input.stateId = stateId;
  if (projectId) input.projectId = projectId;
  const data = await linearQuery(env, mutation, { input });
  return data.issueCreate;
}

// A team's "Done" workflow state id (by name, falling back to the "completed"
// type) — used to mark a chore done.
export async function getDoneStateId(env, teamId) {
  const query = `
    query States($teamId: ID!) {
      workflowStates(first: 50, filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }`;
  const data = await linearQuery(env, query, { teamId });
  const nodes = data.workflowStates?.nodes || [];
  const byName = nodes.find((s) => s.name.toLowerCase() === "done");
  const byType = nodes.find((s) => s.type === "completed");
  return (byName || byType)?.id || null;
}

// Active (non-done) chores in the chores project whose title contains `text`
// (case-insensitive). Used to mark a chore done by spoken/typed name.
export async function findActiveByTitle(env, text, projectName) {
  const query = `
    query Match($text: String!, $project: String!) {
      issues(
        first: 25
        filter: {
          project: { name: { eq: $project } }
          state: { type: { nin: ["completed", "canceled"] } }
          title: { containsIgnoreCase: $text }
        }
      ) {
        nodes { id title dueDate assignee { name } team { id } }
      }
    }`;
  const data = await linearQuery(env, query, { text, project: projectName });
  return data.issues?.nodes || [];
}

export async function setIssueState(env, id, stateId) {
  const mutation = `
    mutation SetState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { identifier title }
      }
    }`;
  const data = await linearQuery(env, mutation, { id, stateId });
  return data.issueUpdate;
}

// Mark the best-matching active chore done by (fuzzy) title — soonest-due wins.
// Shared by the /done endpoint and the Alexa skill.
export async function markChoreDone(env, match) {
  const matches = await findActiveByTitle(env, match, env.CHORES_PROJECT || "House Chores");
  if (!matches.length) return { ok: false, message: `No active task matching "${match}"` };
  matches.sort((a, b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
  const issue = matches[0];
  const stateId = await getDoneStateId(env, issue.team.id);
  if (!stateId) return { ok: false, message: "No Done state found" };
  const res = await setIssueState(env, issue.id, stateId);
  return res?.success
    ? { ok: true, title: issue.title, message: `Marked "${issue.title}" done` }
    : { ok: false, message: "Update failed" };
}

// Resolve a team's "Todo" workflow state id (by name, falling back to the
// "unstarted" type) so spawned chores land in Todo, not Backlog.
export async function getTodoStateId(env, teamId) {
  const query = `
    query States($teamId: ID!) {
      workflowStates(first: 50, filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }`;
  const data = await linearQuery(env, query, { teamId });
  const nodes = data.workflowStates?.nodes || [];
  const byName = nodes.find((s) => s.name.toLowerCase() === "todo");
  const byType = nodes.find((s) => s.type === "unstarted");
  return (byName || byType)?.id || null;
}

// Look up a single issue by its human identifier (e.g. "CHO-12").
export async function getIssueByIdentifier(env, identifier) {
  const m = identifier.match(/^([A-Za-z]+)-(\d+)$/);
  if (!m) return null;
  const key = m[1].toUpperCase();
  const num = parseInt(m[2], 10);
  const query = `
    query ByNum {
      issues(first: 1, filter: { team: { key: { eq: "${key}" } }, number: { eq: ${num} } }) {
        nodes {
          id
          title
          description
          dueDate
          team { id }
          assignee { id }
          labels { nodes { id } }
        }
      }
    }`;
  const data = await linearQuery(env, query);
  return data.issues?.nodes?.[0] || null;
}

// Chores (archived included) due on/after `since`, for the weekly scoreboard.
export async function fetchChoreHistory(env, teamId, since) {
  const query = `
    query History($teamId: ID!) {
      issues(
        first: 250
        includeArchived: true
        filter: {
          team: { id: { eq: $teamId } }
          dueDate: { gte: "${since}" }
        }
      ) {
        nodes { dueDate completedAt assignee { name } }
      }
    }`;
  const data = await linearQuery(env, query, { teamId });
  return data.issues?.nodes || [];
}

// True if the team still has any active issue due on or before `onOrBefore`.
// Used to detect when completing a chore clears the day's plate.
export async function anyOpenDueByTeam(env, teamId, onOrBefore) {
  const query = `
    query OpenDue($teamId: ID!) {
      issues(
        first: 1
        filter: {
          team: { id: { eq: $teamId } }
          dueDate: { lte: "${onOrBefore}" }
          state: { type: { nin: ["completed", "canceled"] } }
        }
      ) {
        nodes { id }
      }
    }`;
  const data = await linearQuery(env, query, { teamId });
  return (data.issues?.nodes || []).length > 0;
}

// All workspace users — used to resolve rotation member names/emails to IDs.
export async function getUsers(env) {
  const query = `query { users(first: 250) { nodes { id name displayName email } } }`;
  const data = await linearQuery(env, query);
  return data.users?.nodes || [];
}

// Assignee of the most recently created spawned copy of a chore (archived
// included), so the next spawn can be handed to the other person.
export async function getLastAssignee(env, teamId, title) {
  const query = `
    query Last($teamId: ID!, $title: String!) {
      issues(
        first: 50
        includeArchived: true
        filter: {
          team: { id: { eq: $teamId } }
          title: { eq: $title }
          project: { null: true }
        }
      ) {
        nodes { assignee { id } createdAt }
      }
    }`;
  const data = await linearQuery(env, query, { teamId, title });
  const nodes = (data.issues?.nodes || []).filter((n) => n.createdAt);
  nodes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return nodes[0]?.assignee?.id || null;
}

// Open (non-completed, non-canceled) spawned chores in a team with an exact
// title. `project: { null: true }` excludes the template tickets that live in
// the Recurring project — otherwise "replace" would archive the template.
export async function findOpenIssuesByTitle(env, teamId, title) {
  const query = `
    query OpenByTitle($teamId: ID!, $title: String!) {
      issues(
        first: 50
        filter: {
          team: { id: { eq: $teamId } }
          title: { eq: $title }
          project: { null: true }
          state: { type: { nin: ["completed", "canceled"] } }
        }
      ) {
        nodes { id identifier dueDate }
      }
    }`;
  const data = await linearQuery(env, query, { teamId, title });
  return data.issues?.nodes || [];
}

// Active (non-completed/canceled) issues assigned to a user, for the /tasks
// Discord command.
export async function fetchAssignedActiveIssues(env, assigneeId) {
  const query = `
    query Assigned($id: ID!) {
      issues(
        first: 100
        filter: {
          assignee: { id: { eq: $id } }
          state: { type: { nin: ["completed", "canceled"] } }
        }
      ) {
        nodes { identifier title dueDate url state { name } team { key } project { name } }
      }
    }`;
  const data = await linearQuery(env, query, { id: assigneeId });
  return data.issues?.nodes || [];
}

// All non-archived spawned chores in the chores project — one query that feeds
// week-generation dedup (per title+dueDate), overdue cleanup, and load seeding.
// Returns { id, title, dueDate, assignee{id}, state{type} }.
export async function fetchSpawned(env, teamId, projectName) {
  const query = `
    query Spawned($teamId: ID!, $project: String!) {
      issues(
        first: 250
        filter: { team: { id: { eq: $teamId } }, project: { name: { eq: $project } } }
      ) {
        nodes { id title dueDate assignee { id } state { type } }
      }
    }`;
  const data = await linearQuery(env, query, { teamId, project: projectName });
  return data.issues?.nodes || [];
}

// Recent spawned chores in the chores project (archived included) for
// last-assignee lookup — one query feeds the rotation for the whole week.
export async function fetchRecentSpawned(env, teamId, projectName) {
  const query = `
    query RecentSpawned($teamId: ID!, $project: String!) {
      issues(
        first: 250
        includeArchived: true
        filter: { team: { id: { eq: $teamId } }, project: { name: { eq: $project } } }
      ) {
        nodes { title createdAt assignee { id } }
      }
    }`;
  const data = await linearQuery(env, query, { teamId, project: projectName });
  return data.issues?.nodes || [];
}

// Reads recurring-chore template tickets from a Linear project (default
// "Recurring"). Each template's cadence lives in its description; its labels
// (e.g. a room) are carried onto every spawned copy.
export async function fetchRecurringTemplates(env, projectName) {
  const query = `
    query Templates($name: String!) {
      issues(first: 100, filter: { project: { name: { eq: $name } } }) {
        nodes {
          title
          description
          team { id key }
          labels { nodes { id name } }
          assignee { id }
        }
      }
    }`;
  const data = await linearQuery(env, query, { name: projectName });
  return data.issues?.nodes || [];
}

export async function archiveIssue(env, id) {
  const mutation = `
    mutation Archive($id: String!) {
      issueArchive(id: $id) { success }
    }`;
  const data = await linearQuery(env, mutation, { id });
  return data.issueArchive;
}

// Resolves label names (case-insensitive) to their IDs across the workspace.
export async function getLabelIds(env, names) {
  if (!names?.length) return [];
  const query = `
    query Labels {
      issueLabels(first: 250) { nodes { id name } }
    }`;
  const data = await linearQuery(env, query);
  const map = new Map(
    (data.issueLabels?.nodes || []).map((l) => [l.name.toLowerCase(), l.id]),
  );
  return names.map((n) => map.get(n.toLowerCase())).filter(Boolean);
}
