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
            };
          },
        }),
        // Jira connectivity test
        jira_ping: tool({
          description: "Verify Jira credentials and site access via /myself",
          inputSchema: z.object({}),
          execute: async () => {
            const me = await getJson<JiraMyself>("/rest/api/3/myself");
            return {
              accountId: me.accountId,
              displayName: me.displayName,
              email: JIRA_EMAIL,
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
      },
    });
  },
});
