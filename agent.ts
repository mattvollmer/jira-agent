import { convertToModelMessages, streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";

// Jira helpers
const env = (k: string) =>
  (process.env[k]?.trim() || undefined) as string | undefined;
const JIRA_SITE_BASE = env("JIRA_BASE_URL")?.replace(/\/+$/, "");
const JIRA_CLOUD_ID = env("JIRA_CLOUD_ID");
const JIRA_EMAIL = env("JIRA_EMAIL");
const JIRA_API_TOKEN = env("JIRA_API_TOKEN");
const JIRA_ACCEPT_LANGUAGE = env("JIRA_ACCEPT_LANGUAGE") || "en-US";
const JIRA_DEFAULT_PROJECT = env("JIRA_DEFAULT_PROJECT");

type JiraMyself = {
  accountId: string;
  displayName: string;
  emailAddress?: string;
};

type JiraCommentCreated = {
  id: string;
  created: string;
  author?: { displayName?: string };
};

type JiraComment = {
  author: string | undefined;
  body: string;
  created: string;
};

type NormalizedIssue = {
  key: string;
  url: string | null;
  summary: string | undefined;
  status: string | undefined;
  statusCategoryKey?: string | undefined;
  statusCategoryName?: string | undefined;
  type: string | undefined;
  priority?: string | undefined;
  labels: string[];
  components: string[];
  assignee?: { displayName?: string } | undefined;
  reporter?: { displayName?: string } | undefined;
  parentKey?: string | undefined;
  description?: { text: string; rendered?: string };
  subtasks: { key: string; summary?: string; status?: string }[];
  linkedIssues: {
    key: string;
    type?: string;
    direction: "inward" | "outward";
  }[];
  comments?: JiraComment[];
  attachments?: {
    filename: string;
    size: number;
    mimeType?: string;
    contentUrl: string;
  }[];
};

function requireEnv() {
  if (!JIRA_CLOUD_ID || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error(
      "Missing Jira env. Set JIRA_CLOUD_ID, JIRA_EMAIL, JIRA_API_TOKEN in .env.local/.env.production",
    );
  }
}

function authHeaders() {
  const basic = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString(
    "base64",
  );
  return {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": JIRA_ACCEPT_LANGUAGE,
  } as Record<string, string>;
}

function parseIssueKeyFromUrl(issueUrl: string): string {
  const u = new URL(issueUrl);
  const selected = u.searchParams.get("selectedIssue");
  if (selected) return selected;
  const path = u.pathname;
  const match = path.match(/[A-Z][A-Z0-9_]+-\d+/i);
  if (match) return match[0].toUpperCase();
  throw new Error("Unable to parse issue key from URL");
}

function projectKeyFromIssueUrl(issueUrl: string): string {
  const key = parseIssueKeyFromUrl(issueUrl);
  const hyphen = key.indexOf("-");
  return hyphen > 0 ? key.slice(0, hyphen) : key;
}

function apiBase(): string {
  if (!JIRA_CLOUD_ID) throw new Error("JIRA_CLOUD_ID is required");
  return `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}`;
}

function joinApi(path: string): string {
  const base = apiBase().replace(/\/+$/, "") + "/";
  const safePath = path.replace(/^\/+/, "");
  return new URL(safePath, base).toString();
}

async function getJson<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  requireEnv();
  const url = new URL(joinApi(path));
  if (params)
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Jira API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: any): Promise<T> {
  requireEnv();
  const url = joinApi(path);
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function putJson<T>(path: string, body: any): Promise<T> {
  requireEnv();
  const url = joinApi(path);
  const res = await fetch(url, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira API ${res.status}: ${await res.text()}`);
  return (await res.json().catch(() => ({}))) as T;
}

function stripHtml(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchIssueNormalized(
  key: string,
  opts?: {
    includeComments?: boolean;
    maxComments?: number;
    includeAttachments?: boolean;
  },
) {
  const fields = [
    "summary",
    "description",
    "issuetype",
    "priority",
    "labels",
    "components",
    "status",
    "assignee",
    "reporter",
    "parent",
    "attachment",
    "subtasks",
  ];
  const issue = await getJson<any>(`/rest/api/3/issue/${key}`, {
    fields: fields.join(","),
    expand: "renderedFields,issuelinks,subtasks",
  });

  const normalized: NormalizedIssue = {
    key: issue.key,
    url: JIRA_SITE_BASE ? `${JIRA_SITE_BASE}/browse/${issue.key}` : null,
    summary: issue.fields?.summary,
    status: issue.fields?.status?.name,
    statusCategoryKey: issue.fields?.status?.statusCategory?.key,
    statusCategoryName: issue.fields?.status?.statusCategory?.name,
    type: issue.fields?.issuetype?.name,
    priority: issue.fields?.priority?.name,
    labels: issue.fields?.labels ?? [],
    components: (issue.fields?.components ?? [])
      .map((c: any) => c.name)
      .filter(Boolean),
    assignee: issue.fields?.assignee
      ? { displayName: issue.fields.assignee.displayName }
      : undefined,
    reporter: issue.fields?.reporter
      ? { displayName: issue.fields.reporter.displayName }
      : undefined,
    parentKey: issue.fields?.parent?.key,
    description: {
      text: stripHtml(issue.renderedFields?.description),
      rendered: issue.renderedFields?.description,
    },
    subtasks: (issue.fields?.subtasks ?? []).map((s: any) => ({
      key: s.key,
      summary: s.fields?.summary,
      status: s.fields?.status?.name,
    })),
    linkedIssues: (issue.fields?.issuelinks ?? [])
      .map((l: any) => ({
        key: l.outwardIssue?.key ?? l.inwardIssue?.key,
        type: l.type?.name,
        direction: l.outwardIssue ? "outward" : "inward",
      }))
      .filter((x: any) => x.key),
  };

  if (opts?.includeComments) {
    const max = Math.min(Math.max(opts.maxComments ?? 50, 1), 200);
    const comments = await getJson<any>(`/rest/api/3/issue/${key}/comment`, {
      orderBy: "created",
      maxResults: String(max),
    });
    normalized.comments = (comments.comments ?? []).map((c: any) => ({
      author: c.author?.displayName,
      body: typeof c.body === "string" ? c.body : stripHtml(undefined),
      created: c.created,
    }));
  }

  if (opts?.includeAttachments) {
    const atts = (issue.fields?.attachment ?? []).map((a: any) => ({
      filename: a.filename,
      size: a.size,
      mimeType: a.mimeType,
      contentUrl: a.content,
    }));
    normalized.attachments = atts;
  }

  return normalized;
}

function buildAdfComment(
  text: string,
  mentions?: { accountId: string; text?: string }[],
) {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  if (mentions?.length) {
    if (text) content.push({ type: "text", text: " " });
    for (const m of mentions) {
      content.push({
        type: "mention",
        attrs: { id: m.accountId, text: m.text ?? "" },
      });
      content.push({ type: "text", text: " " });
    }
  }
  return {
    body: {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: content.length ? content : [{ type: "text", text: "" }],
        },
      ],
    },
  };
}

function toAdfDoc(text?: string) {
  return {
    version: 1,
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: text ?? "" }] },
    ],
  };
}

// JQL helpers for list tools
function q(s: string) {
  return `"${s.replace(/"/g, '\\"')}"`;
}
function jqlIn(field: string, values: string[]) {
  if (!values.length) return "";
  return `${field} in (${values.map(q).join(", ")})`;
}
function jqlAssignee(accountId?: string) {
  if (!accountId) return "";
  return `assignee in (accountId(${q(accountId)}))`;
}
function jqlAnd(parts: string[]) {
  return parts.filter(Boolean).join(" AND ");
}

// Fetch allowed issue types for a project
async function getProjectIssueTypes(projectKey: string): Promise<string[]> {
  try {
    const meta = await getJson<any>(`/rest/api/3/issue/createmeta`, {
      projectKeys: projectKey,
      expand: "projects.issuetypes",
    });
    const p = (meta.projects ?? []).find((p: any) => p.key === projectKey);
    const names = (p?.issuetypes ?? []).map((t: any) => t.name).filter(Boolean);
    if (names.length) return names;
  } catch (_) {
    // ignore and fallback
  }
  try {
    const statuses = await getJson<any>(
      `/rest/api/3/project/${projectKey}/statuses`,
    );
    const names = (Array.isArray(statuses) ? statuses : [])
      .map((it: any) => it.name)
      .filter(Boolean);
    if (names.length) return names;
  } catch (_) {
    // ignore
  }
  return [];
}

async function getProjectComponents(
  projectKey: string,
): Promise<{ id: string; name: string }[]> {
  const res = await getJson<any>(
    `/rest/api/3/project/${projectKey}/components`,
  );
  return (Array.isArray(res) ? res : []).map((c: any) => ({
    id: String(c.id),
    name: String(c.name),
  }));
}

function canonicalizeIssueType(input: string): string {
  const s = input.trim().toLowerCase();
  const map: Record<string, string> = {
    bug: "Bug",
    task: "Task",
    story: "Story",
    epic: "Epic",
    subtask: "Sub-task",
    "sub-task": "Sub-task",
    "sub task": "Sub-task",
    idea: "Idea",
    incident: "Incident",
    change: "Change",
    problem: "Problem",
    "service request": "Service Request",
  };
  return map[s] || input;
}

function normalizeDueDate(input?: string): string | undefined {
  if (!input) return undefined;
  // Accept YYYY-MM-DD directly
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const d = new Date(input);
  if (isNaN(d.getTime()))
    throw new Error(
      "Invalid due_date format; use YYYY-MM-DD or a parseable date string",
    );
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// New: minimal helpers for Automation webhook handling
const JIRA_AUTOMATION_SECRET = env("JIRA_AUTOMATION_SECRET");
const JIRA_SERVICE_ACCOUNT_ID = env("JIRA_SERVICE_ACCOUNT_ID");
let cachedServiceAccountId: string | undefined;

async function getServiceAccountId(): Promise<string> {
  if (JIRA_SERVICE_ACCOUNT_ID) return JIRA_SERVICE_ACCOUNT_ID;
  if (cachedServiceAccountId) return cachedServiceAccountId;
  const me = await getJson<JiraMyself>(`/rest/api/3/myself`);
  cachedServiceAccountId = me.accountId;
  return cachedServiceAccountId;
}

function adfContainsMention(node: any, accountId: string): boolean {
  if (!node) return false;
  if (Array.isArray(node))
    return node.some((n) => adfContainsMention(n, accountId));
  if (node.type === "mention" && node.attrs?.id === accountId) return true;
  if (node.content) return adfContainsMention(node.content, accountId);
  return false;
}

blink
  .agent({
    async sendMessages({ messages }) {
      return streamText({
        model: "anthropic/claude-sonnet-4",
        system: `You are a basic agent the user will customize.

Use the Jira tools provided when given a Jira link.`,
        messages: convertToModelMessages(messages),
        tools: {
          // Utility: current date/time
          get_current_date: tool({
            description:
              "Get the current UTC date/time with weekday and human-formatted output",
            inputSchema: z.object({}),
            execute: async () => {
              const now = new Date();
              const iso = now.toISOString();
              const weekdayNames = [
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
              ];
              const monthNames = [
                "January",
                "February",
                "March",
                "April",
                "May",
                "June",
                "July",
                "August",
                "September",
                "October",
                "November",
                "December",
              ];
              const weekdayIndex = now.getUTCDay();
              const weekday = weekdayNames[weekdayIndex];
              const monthIndex = now.getUTCMonth();
              const month = monthNames[monthIndex];
              const day = now.getUTCDate();
              const year = now.getUTCFullYear();
              const human = `${weekday}, ${month} ${day}, ${year} (UTC)`;
              return {
                iso,
                date: iso.slice(0, 10),
                time: iso.slice(11, 19) + "Z",
                epochMillis: now.getTime(),
                timezone: "UTC",
                weekday,
                weekdayIndex,
                month,
                monthIndex,
                day,
                year,
                human,
                rfc1123: now.toUTCString(),
                offsetMinutes: 0,
              };
            },
          }),
          // Quick env visibility
          jira_env_check: tool({
            description:
              "Report which Jira env vars are visible and the computed API base",
            inputSchema: z.object({}),
            execute: async () => {
              return {
                cloudIdPresent: !!JIRA_CLOUD_ID,
                emailPresent: !!JIRA_EMAIL,
                tokenPresent: !!JIRA_API_TOKEN,
                apiBase: apiBase(),
                siteBase: JIRA_SITE_BASE ?? null,
                email: JIRA_EMAIL ?? null,
                exampleMyself: joinApi("/rest/api/3/myself"),
                acceptLanguage: JIRA_ACCEPT_LANGUAGE,
              };
            },
          }),
          // Add a comment to a Jira issue (mentions enabled by default if provided)
          jira_add_comment: tool({
            description:
              "Add a comment to a Jira issue. Supports ADF mentions (provide accountIds).",
            inputSchema: z.object({
              issue_url: z.string().url(),
              text: z.string().min(1),
              mentions: z
                .array(
                  z.object({
                    accountId: z.string(),
                    text: z.string().optional(),
                  }),
                )
                .optional(),
            }),
            execute: async ({ issue_url, text, mentions }) => {
              const key = parseIssueKeyFromUrl(issue_url);
              const body = buildAdfComment(text, mentions);
              const result = await postJson<JiraCommentCreated>(
                `/rest/api/3/issue/${key}/comment`,
                body,
              );
              return {
                id: result.id,
                created: result.created,
                author: result.author?.displayName,
              };
            },
          }),
          // Fetch a single issue and return normalized fields
          jira_get_issue_by_url: tool({
            description:
              "Fetch a Jira issue by URL and return normalized fields",
            inputSchema: z.object({
              issue_url: z.string().url(),
              include_comments: z.boolean().default(false),
              max_comments: z.number().int().positive().max(200).default(50),
              include_attachments: z.boolean().default(false),
            }),
            execute: async ({
              issue_url,
              include_comments,
              max_comments,
              include_attachments,
            }) => {
              const key = parseIssueKeyFromUrl(issue_url);
              const normalized = await fetchIssueNormalized(key, {
                includeComments: include_comments,
                maxComments: max_comments,
                includeAttachments: include_attachments,
              });
              return normalized;
            },
          }),
          // Aggregate context for an issue: parent, links, subtasks, comments, attachments
          jira_get_issue_context: tool({
            description:
              "Aggregate full context for a Jira issue (parent, subtasks, links, comments, attachments)",
            inputSchema: z.object({
              issue_url: z.string().url(),
              include_comments: z.boolean().default(true),
              include_attachments: z.boolean().default(false),
              include_linked: z.boolean().default(true),
              include_subtasks: z.boolean().default(true),
              max_comments: z.number().int().positive().max(200).default(50),
            }),
            execute: async (input) => {
              const key = parseIssueKeyFromUrl(input.issue_url);
              const base = await fetchIssueNormalized(key, {
                includeComments: input.include_comments,
                maxComments: input.max_comments,
                includeAttachments: input.include_attachments,
              });

              let parent: any = undefined;
              if (base.parentKey) {
                parent = await getJson<any>(
                  `/rest/api/3/issue/${base.parentKey}`,
                  { fields: "summary,status,issuetype" },
                );
              }

              const acceptance: string[] = [];
              const harvest = (text?: string) => {
                if (!text) return;
                const lines = text.split("\n");
                for (const line of lines) {
                  if (
                    /^\s*[-*]\s+/.test(line) ||
                    /(AC:|Acceptance Criteria|Given\/?When\/?Then)/i.test(line)
                  ) {
                    acceptance.push(line.trim());
                  }
                }
              };
              harvest(base.description?.text);
              if (base.comments) base.comments.forEach((c) => harvest(c.body));

              return {
                ...base,
                parent: parent
                  ? {
                      key: parent.key,
                      summary: parent.fields?.summary,
                      status: parent.fields?.status?.name,
                      type: parent.fields?.issuetype?.name,
                    }
                  : undefined,
                acceptanceCriteria: acceptance.slice(0, 50),
              };
            },
          }),
          // Resolve users for mentions
          jira_find_user: tool({
            description:
              "Find users by name or email and return accountId + displayName",
            inputSchema: z.object({
              query: z.string().min(1),
              limit: z.number().int().positive().max(50).default(10),
            }),
            execute: async ({ query, limit }) => {
              const users = await getJson<any>(`/rest/api/3/user/search`, {
                query,
                maxResults: String(limit),
              });
              return (Array.isArray(users) ? users : []).map((u: any) => ({
                accountId: u.accountId,
                displayName: u.displayName,
                emailAddress: u.emailAddress,
              }));
            },
          }),
          // List projects
          jira_list_projects: tool({
            description:
              "List Jira projects with key, id, name, and browse URL",
            inputSchema: z.object({
              query: z.string().optional(),
              start_at: z.number().int().min(0).default(0),
              limit: z.number().int().positive().max(100).default(50),
            }),
            execute: async ({ query, start_at, limit }) => {
              const res = await getJson<any>(`/rest/api/3/project/search`, {
                startAt: String(start_at),
                maxResults: String(limit),
                query: query ?? "",
              });
              const values = res.values ?? [];
              return values.map((p: any) => ({
                id: p.id,
                key: p.key,
                name: p.name,
                type: p.projectTypeKey,
                url: JIRA_SITE_BASE
                  ? `${JIRA_SITE_BASE}/browse/${p.key}`
                  : null,
              }));
            },
          }),
          // List tasks (issues) in a project with optional filters
          jira_list_tasks: tool({
            description:
              "List Task issues for a project, with optional status and assignee filters",
            inputSchema: z.object({
              project_key: z.string().min(1),
              types: z.array(z.string()).default(["Task"]),
              statuses: z.array(z.string()).default([]),
              assignee_accountId: z.string().optional(),
              limit: z.number().int().positive().max(100).default(50),
              start_at: z.number().int().min(0).default(0),
            }),
            execute: async ({
              project_key,
              types,
              statuses,
              assignee_accountId,
              limit,
              start_at,
            }) => {
              const allowed = (await getProjectIssueTypes(project_key)).map(
                String,
              );
              const requestedCanon = types.map(canonicalizeIssueType);
              const matched: string[] = [];
              for (const t of requestedCanon) {
                const exact = allowed.find(
                  (n) => n.toLowerCase() === t.toLowerCase(),
                );
                if (exact && !matched.includes(exact)) matched.push(exact);
              }
              const typesFilter = matched.length
                ? matched
                : allowed.length
                  ? allowed
                  : [];

              const parts: string[] = [
                `project = ${project_key}`,
                typesFilter.length ? jqlIn("issuetype", typesFilter) : "",
                statuses.length ? jqlIn("status", statuses) : "",
                jqlAssignee(assignee_accountId),
              ];
              const jql = jqlAnd(parts);

              const search = await getJson<any>(`/rest/api/3/search`, {
                jql,
                startAt: String(start_at),
                maxResults: String(limit),
                fields: [
                  "summary",
                  "status",
                  "issuetype",
                  "priority",
                  "assignee",
                  "updated",
                ].join(","),
                orderBy: "-updated",
              });
              const issues = search.issues ?? [];
              return issues.map((it: any) => ({
                key: it.key,
                url: JIRA_SITE_BASE
                  ? `${JIRA_SITE_BASE}/browse/${it.key}`
                  : null,
                summary: it.fields?.summary,
                status: it.fields?.status?.name,
                statusCategoryKey: it.fields?.status?.statusCategory?.key,
                statusCategoryName: it.fields?.status?.statusCategory?.name,
                type: it.fields?.issuetype?.name,
                priority: it.fields?.priority?.name,
                assignee: it.fields?.assignee?.displayName,
                updated: it.fields?.updated,
              }));
            },
          }),
          // Create an issue with project/type inference
          jira_create_issue: tool({
            description:
              "Create a Jira issue. Infers project/type if omitted (uses parent issue URL or default project).",
            inputSchema: z.object({
              summary: z.string().min(3),
              description: z.string().optional(),
              project_key: z.string().optional(),
              issue_type: z.string().optional(),
              parent_issue_url: z.string().url().optional(),
              assignee_accountId: z.string().optional(),
              labels: z.array(z.string()).optional(),
            }),
            execute: async ({
              summary,
              description,
              project_key,
              issue_type,
              parent_issue_url,
              assignee_accountId,
              labels,
            }) => {
              // Resolve project
              let projectKey =
                project_key ||
                (parent_issue_url
                  ? projectKeyFromIssueUrl(parent_issue_url)
                  : JIRA_DEFAULT_PROJECT);
              if (!projectKey)
                throw new Error(
                  "project_key is required (or provide parent_issue_url or set JIRA_DEFAULT_PROJECT)",
                );

              // Allowed types and resolution
              const allowed = (await getProjectIssueTypes(projectKey)).map(
                String,
              );
              const preferredOrder = [
                "Story",
                "Task",
                "Bug",
                "Idea",
                "Epic",
                "Sub-task",
              ];

              // Start with a concrete string to satisfy TS
              let resolvedType: string = issue_type
                ? canonicalizeIssueType(issue_type)
                : "";

              if (
                !resolvedType &&
                parent_issue_url &&
                allowed.find((n) => n.toLowerCase() === "sub-task")
              ) {
                resolvedType = "Sub-task";
              }
              if (!resolvedType) {
                const found = preferredOrder.find((t) =>
                  allowed.some((n) => n.toLowerCase() === t.toLowerCase()),
                );
                resolvedType = found || allowed[0] || "Task";
              }

              // Validate type
              const allowedLower = new Set(allowed.map((n) => n.toLowerCase()));
              if (
                allowed.length &&
                !allowedLower.has(resolvedType.toLowerCase())
              ) {
                resolvedType = allowed[0] || "Task";
              }

              // Build fields
              const fields: any = {
                project: { key: projectKey },
                summary,
                issuetype: { name: resolvedType },
                description: toAdfDoc(description),
              };
              if (assignee_accountId)
                fields.assignee = { accountId: assignee_accountId };
              if (labels?.length) fields.labels = labels;

              // Parent only for Sub-task
              if (resolvedType.toLowerCase() === "sub-task") {
                if (!parent_issue_url)
                  throw new Error(
                    "parent_issue_url is required for Sub-task creation",
                  );
                const parentKey = parseIssueKeyFromUrl(parent_issue_url);
                fields.parent = { key: parentKey };
              }

              const created = await postJson<any>(`/rest/api/3/issue`, {
                fields,
              });
              const key = created.key;
              return {
                key,
                url: JIRA_SITE_BASE ? `${JIRA_SITE_BASE}/browse/${key}` : null,
                projectKey,
                issueType: resolvedType,
              };
            },
          }),
          // Update issue fields (no deletes; only add labels/components)
          jira_update_issue_fields: tool({
            description:
              "Edit an issue: summary, description, priority, assignee, labels add, components add, due date, and optional issue type change. Supports dry_run preview and change summary comment.",
            inputSchema: z.object({
              issue_url: z.string().url(),
              summary: z.string().optional(),
              description: z.string().optional(),
              priority: z.string().optional(),
              assignee_accountId: z.string().optional(),
              labels_add: z.array(z.string()).default([]),
              components_add: z.array(z.string()).default([]),
              due_date: z.string().optional(),
              issue_type: z.string().optional(),
              parent_issue_url: z.string().url().optional(),
              dry_run: z.boolean().default(true),
              add_comment: z.boolean().default(true),
            }),
            execute: async (input) => {
              const key = parseIssueKeyFromUrl(input.issue_url);
              const fieldsNeeded = [
                "summary",
                "description",
                "labels",
                "components",
                "duedate",
                "priority",
                "assignee",
                "issuetype",
                "project",
              ];
              const issue = await getJson<any>(`/rest/api/3/issue/${key}`, {
                fields: fieldsNeeded.join(","),
              });
              const before = {
                summary: issue.fields?.summary,
                description: stripHtml(
                  issue.fields?.description?.content
                    ? undefined
                    : issue.fields?.description,
                ),
                labels: issue.fields?.labels ?? [],
                components: (issue.fields?.components ?? []).map(
                  (c: any) => c.name,
                ),
                duedate: issue.fields?.duedate,
                priority: issue.fields?.priority?.name,
                assignee: issue.fields?.assignee?.displayName,
                issuetype: issue.fields?.issuetype?.name,
                projectKey: issue.fields?.project?.key,
              } as any;

              const projectKey = before.projectKey as string;

              // Compute after values
              const after = { ...before } as any;
              if (input.summary) after.summary = input.summary;
              if (input.description !== undefined)
                after.description = input.description;
              if (input.priority) after.priority = input.priority;
              if (input.assignee_accountId)
                after.assignee = input.assignee_accountId;
              if (input.due_date)
                after.duedate = normalizeDueDate(input.due_date);

              // Labels add only
              const addLabels = Array.from(
                new Set(input.labels_add.map((s) => s.trim()).filter(Boolean)),
              );
              after.labels = Array.from(
                new Set([...(before.labels as string[]), ...addLabels]),
              );

              // Components add only: map names to ids
              const addComponents = Array.from(
                new Set(
                  input.components_add.map((s) => s.trim()).filter(Boolean),
                ),
              );
              const existingCompNames = before.components as string[];
              const finalCompNames = Array.from(
                new Set([...(existingCompNames || []), ...addComponents]),
              );
              const compCatalog = await getProjectComponents(projectKey);
              const compByLower = new Map(
                compCatalog.map((c) => [c.name.toLowerCase(), c]),
              );
              const finalCompIds = finalCompNames
                .map((n) => compByLower.get(n.toLowerCase()))
                .filter(Boolean)
                .map((c: any) => ({ id: c.id }));

              // Issue type change if requested
              let resolvedType: string | undefined = undefined;
              if (input.issue_type) {
                const allowed = (await getProjectIssueTypes(projectKey)).map(
                  String,
                );
                const canon = canonicalizeIssueType(input.issue_type);
                const exact = allowed.find(
                  (n) => n.toLowerCase() === canon.toLowerCase(),
                );
                if (!exact)
                  throw new Error(
                    `issue_type '${input.issue_type}' not allowed in project ${projectKey}`,
                  );
                resolvedType = exact;
              }

              // Build update body
              const updateFields: any = {};
              if (after.summary !== before.summary)
                updateFields.summary = after.summary;
              if (input.description !== undefined)
                updateFields.description = toAdfDoc(after.description);
              if (after.priority !== before.priority)
                updateFields.priority = { name: after.priority };
              if (input.assignee_accountId)
                updateFields.assignee = { accountId: input.assignee_accountId };
              if (after.duedate !== before.duedate)
                updateFields.duedate = after.duedate;
              if (addLabels.length) updateFields.labels = after.labels; // union only
              if (finalCompIds.length) updateFields.components = finalCompIds; // union only
              if (resolvedType) updateFields.issuetype = { name: resolvedType };

              if (resolvedType && resolvedType.toLowerCase() === "sub-task") {
                if (!input.parent_issue_url)
                  throw new Error(
                    "parent_issue_url is required when changing type to Sub-task",
                  );
                updateFields.parent = {
                  key: parseIssueKeyFromUrl(input.parent_issue_url),
                };
              }

              const preview = {
                key,
                changes: updateFields,
              };

              if (input.dry_run) {
                return { dry_run: true, ...preview };
              }

              // Apply update
              await putJson(`/rest/api/3/issue/${key}`, {
                fields: updateFields,
              });

              // Optional comment summarizing changes
              if (input.add_comment) {
                const summaryText = Object.keys(updateFields)
                  .map((k) => `- ${k}`)
                  .join("\n");
                const comment = {
                  body: toAdfDoc(`Updated fields:\n${summaryText}`),
                };
                await postJson(`/rest/api/3/issue/${key}/comment`, comment);
              }

              return {
                key,
                url: JIRA_SITE_BASE ? `${JIRA_SITE_BASE}/browse/${key}` : null,
                applied: Object.keys(updateFields),
              };
            },
          }),
          // List transitions for an issue
          jira_list_transitions: tool({
            description: "List available transitions for an issue",
            inputSchema: z.object({ issue_url: z.string().url() }),
            execute: async ({ issue_url }) => {
              const key = parseIssueKeyFromUrl(issue_url);
              const res = await getJson<any>(
                `/rest/api/3/issue/${key}/transitions`,
                {},
              );
              return (res.transitions ?? []).map((t: any) => ({
                id: t.id,
                name: t.name,
                to: t.to?.name,
              }));
            },
          }),
          // Apply a transition by name
          jira_transition_issue: tool({
            description: "Transition an issue by transition name",
            inputSchema: z.object({
              issue_url: z.string().url(),
              transition_name: z.string().min(1),
            }),
            execute: async ({ issue_url, transition_name }) => {
              const key = parseIssueKeyFromUrl(issue_url);
              const res = await getJson<any>(
                `/rest/api/3/issue/${key}/transitions`,
                {},
              );
              const found = (res.transitions ?? []).find(
                (t: any) =>
                  String(t.name).toLowerCase() ===
                  transition_name.toLowerCase(),
              );
              if (!found)
                throw new Error(
                  `Transition '${transition_name}' not available on ${key}`,
                );
              await postJson(`/rest/api/3/issue/${key}/transitions`, {
                transition: { id: found.id },
              });
              return { key, applied: found.name, to: found.to?.name };
            },
          }),
          // Link two issues by type and direction
          jira_link_issue: tool({
            description:
              "Create an issue link between two issues (e.g., Blocks, Relates). Direction defaults to outward.",
            inputSchema: z.object({
              from_issue_url: z.string().url(),
              to_issue_url: z.string().url(),
              link_type: z.string().min(1),
              direction: z.enum(["outward", "inward"]).default("outward"),
            }),
            execute: async ({
              from_issue_url,
              to_issue_url,
              link_type,
              direction,
            }) => {
              const fromKey = parseIssueKeyFromUrl(from_issue_url);
              const toKey = parseIssueKeyFromUrl(to_issue_url);
              const body: any = { type: { name: link_type } };
              if (direction === "outward") {
                body.outwardIssue = { key: toKey };
                body.inwardIssue = { key: fromKey };
              } else {
                body.outwardIssue = { key: fromKey };
                body.inwardIssue = { key: toKey };
              }
              await postJson(`/rest/api/3/issueLink`, body);
              return { from: fromKey, to: toKey, type: link_type, direction };
            },
          }),
        },
      });
    },
    // New: webhook ingress for Jira Automation (Issue commented)
    async onRequest(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/jira")) {
        return new Response("OK", { status: 200 });
      }

      // Verify shared secret if configured
      const authHeader =
        request.headers.get("authorization") ||
        request.headers.get("Authorization");
      if (
        JIRA_AUTOMATION_SECRET &&
        authHeader !== `Bearer ${JIRA_AUTOMATION_SECRET}`
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload: any;
      try {
        payload = await request.json();
      } catch (_) {
        return new Response("Bad Request", { status: 400 });
      }

      // Expect custom data from Automation like:
      // {
      //   "issue": { "key": "ABC-123" },
      //   "comment": {
      //     "author": { "accountId": "..." },
      //     "body": <ADF object or JSON string of ADF>
      //   }
      // }
      const issueKey: string | undefined = payload?.issue?.key ?? payload?.key;
      const comment = payload?.comment;
      if (!issueKey || !comment) {
        // Nothing to do
        return new Response("OK", { status: 200 });
      }

      requireEnv();
      const serviceAccountId = await getServiceAccountId();

      const authorId: string | undefined =
        comment?.author?.accountId ?? comment?.authorId;
      if (authorId && authorId === serviceAccountId) {
        // Avoid loops
        return new Response("OK", { status: 200 });
      }

      // Parse ADF body
      let adfBody: any = comment.body;
      if (typeof adfBody === "string") {
        try {
          adfBody = JSON.parse(adfBody);
        } catch (_) {
          // Not ADF JSON; ignore
          adfBody = undefined;
        }
      }

      if (!adfBody || !adfContainsMention(adfBody, serviceAccountId)) {
        return new Response("OK", { status: 200 });
      }

      // Compose a minimal acknowledgement reply mentioning the commenter
      const reply = buildAdfComment(
        "Thanks for the mention.",
        authorId ? [{ accountId: authorId }] : undefined,
      );

      try {
        await postJson(`/rest/api/3/issue/${issueKey}/comment`, reply);
      } catch (err) {
        return new Response("Upstream Jira error", { status: 502 });
      }

      return new Response("OK", { status: 200 });
    },
  })
  .serve();
