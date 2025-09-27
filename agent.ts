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
  return key.split("-")[0];
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

export default blink.agent({
  async sendMessages({ messages }) {
    return streamText({
      model: "anthropic/claude-sonnet-4",
      system: `You are a basic agent the user will customize.

Use the Jira tools provided when given a Jira link.`,
      messages: convertToModelMessages(messages),
      tools: {
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
          description: "Fetch a Jira issue by URL and return normalized fields",
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
          description: "List Jira projects with key, id, name, and browse URL",
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
              url: JIRA_SITE_BASE ? `${JIRA_SITE_BASE}/browse/${p.key}` : null,
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
              url: JIRA_SITE_BASE ? `${JIRA_SITE_BASE}/browse/${it.key}` : null,
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

            // If parent provided and Sub-task allowed, prefer Sub-task
            let resolvedType = issue_type
              ? canonicalizeIssueType(issue_type)
              : undefined;
            if (
              !resolvedType &&
              parent_issue_url &&
              allowed.find((n) => n.toLowerCase() === "sub-task")
            ) {
              resolvedType = "Sub-task";
            }
            if (!resolvedType) {
              // pick from preferred order if allowed; else first allowed; else fallback Task
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
              // fallback to first allowed
              resolvedType = allowed[0];
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
      },
    });
  },
});
