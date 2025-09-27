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

async function getJson<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  requireEnv();
  const url = new URL(path, apiBase());
  if (params)
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Jira API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: any): Promise<T> {
  requireEnv();
  const url = new URL(path, apiBase());
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
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
      },
    });
  },
});
