import { convertToModelMessages, streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import {
  createJiraTools,
  adfContainsMention,
  adfText,
  getJiraSiteBase,
  requireEnv,
  getJson,
  parseIssueKeyFromUrl,
} from "./jira";
import type { JiraMyself } from "./jira";
import * as github from "@blink-sdk/github";
import { Webhooks } from "@octokit/webhooks";
import { Octokit } from "@octokit/core";
import { createAppAuth } from "@octokit/auth-app";
import * as compute from "@blink-sdk/compute";
import { Daytona } from "@daytonaio/sdk";

const GITHUB_APP_ID = process.env.GITHUB_APP_ID?.trim();
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
const GITHUB_APP_INSTALLATION_ID =
  process.env.GITHUB_APP_INSTALLATION_ID?.trim();
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET?.trim();
const GITHUB_BOT_LOGIN = process.env.GITHUB_BOT_LOGIN?.trim();
const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY?.trim();
const DAYTONA_SNAPSHOT =
  process.env.DAYTONA_SNAPSHOT?.trim() || "blink-workspace-august-17-2025";
const DAYTONA_TTL_MINUTES = Number(process.env.DAYTONA_TTL_MINUTES ?? "60");

function getGithubAppContext() {
  if (
    !GITHUB_APP_ID ||
    !GITHUB_APP_PRIVATE_KEY ||
    !GITHUB_APP_INSTALLATION_ID
  ) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID must be set",
    );
  }
  return {
    appId: GITHUB_APP_ID,
    privateKey: Buffer.from(GITHUB_APP_PRIVATE_KEY, "base64").toString("utf-8"),
    installationId: Number(GITHUB_APP_INSTALLATION_ID),
  } as const;
}

async function getOctokit(): Promise<Octokit> {
  if (
    !GITHUB_APP_ID ||
    !GITHUB_APP_PRIVATE_KEY ||
    !GITHUB_APP_INSTALLATION_ID
  ) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID must be set",
    );
  }
  const auth = createAppAuth({
    appId: Number(GITHUB_APP_ID),
    privateKey: Buffer.from(GITHUB_APP_PRIVATE_KEY, "base64").toString("utf-8"),
    installationId: Number(GITHUB_APP_INSTALLATION_ID),
  });
  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

async function postPRComment(
  octokit: Octokit,
  repo: { owner: string; repo: string; number: number },
  body: string,
) {
  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: repo.number,
      body,
    },
  );
}

function getAppOctokit(): Octokit {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
  }
  const appId = Number(GITHUB_APP_ID);
  const privateKey = Buffer.from(GITHUB_APP_PRIVATE_KEY!, "base64").toString(
    "utf-8",
  );
  return new Octokit({
    authStrategy: createAppAuth as any,
    auth: {
      appId,
      privateKey,
    } as any,
  });
}

async function getInstallationOctokit(
  owner: string,
  repo: string,
): Promise<Octokit> {
  const appOctokit = getAppOctokit();

  const installationId = (
    await appOctokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    })
  ).data.id;

  const appId = Number(GITHUB_APP_ID!);
  const privateKey = Buffer.from(GITHUB_APP_PRIVATE_KEY!, "base64").toString(
    "utf-8",
  );
  const installationOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId,
    },
  });

  return installationOctokit;
}

async function createInstallationToken(
  owner: string,
  repo: string,
  repositories: string[],
): Promise<string> {
  const appOctokit = getAppOctokit();
  const installationId = (
    await appOctokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    })
  ).data.id;
  const tokenResp = await appOctokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installationId,
      repositories,
    } as any,
  );
  return tokenResp.data.token as string;
}

const JIRA_AUTOMATION_SECRET = process.env.JIRA_AUTOMATION_SECRET?.trim();
const JIRA_SERVICE_ACCOUNT_ID = process.env.JIRA_SERVICE_ACCOUNT_ID?.trim();
let cachedServiceAccountId: string | undefined;

function rid() {
  try {
    // @ts-ignore
    return crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function log(event: string, data?: Record<string, unknown>) {
  try {
    console.log(
      JSON.stringify({ level: "info", source: "jira-webhook", event, ...data }),
    );
  } catch {}
}

function chatLog(event: string, data?: Record<string, unknown>) {
  try {
    console.log(
      JSON.stringify({ level: "info", source: "jira-chat", event, ...data }),
    );
  } catch {}
}

async function getServiceAccountId(): Promise<string> {
  if (JIRA_SERVICE_ACCOUNT_ID) return JIRA_SERVICE_ACCOUNT_ID;
  if (cachedServiceAccountId) return cachedServiceAccountId;
  const me = await getJson<JiraMyself>(`/rest/api/3/myself`);
  cachedServiceAccountId = me.accountId;
  return cachedServiceAccountId;
}

function parseGhPrChatId(
  id?: string | null,
): { owner: string; repo: string; prNumber: number } | null {
  if (!id) return null;
  if (!id.startsWith("gh-pr~")) return null;
  const parts = id.split("~");
  if (parts.length !== 4) return null;
  const owner = parts[1] ?? "";
  const repo = parts[2] ?? "";
  const prNumber = Number(parts[3]);
  if (!owner || !repo || !Number.isFinite(prNumber) || prNumber <= 0)
    return null;
  return { owner, repo, prNumber };
}

function parseGhIssueChatId(
  id?: string | null,
): { owner: string; repo: string; issueNumber: number } | null {
  if (!id) return null;
  if (!id.startsWith("gh-issue~")) return null;
  const parts = id.split("~");
  if (parts.length !== 4) return null;
  const owner = parts[1] ?? "";
  const repo = parts[2] ?? "";
  const issueNumber = Number(parts[3]);
  if (!owner || !repo || !Number.isFinite(issueNumber) || issueNumber <= 0)
    return null;
  return { owner, repo, issueNumber };
}

export interface DaytonaWorkspace {
  readonly id: string;
  readonly connectID: string;
}

async function getDaytonaWorkspace(context: blink.Context, key: string) {
  try {
    const raw = await context.store.get(`daytona-workspace-${key}`);
    return raw ? (JSON.parse(raw) as DaytonaWorkspace) : undefined;
  } catch {
    return undefined;
  }
}
async function setDaytonaWorkspace(
  context: blink.Context,
  key: string,
  ws: DaytonaWorkspace,
) {
  await context.store.set(`daytona-workspace-${key}`, JSON.stringify(ws));
}

const agent = blink.agent();

agent.on("chat", async ({ messages, key, context }) => {
  let meta: {
    issueKey?: string;
    issueUrl?: string;
    authorId?: string;
  } | null = null;
  try {
    const raw = await context.store.get(`jira-meta-${key}`);
    if (raw) meta = JSON.parse(raw);
  } catch {}

  // Jira meta fallback: if KV by chat.id missing, try KV alias by issue key from message, else synthesize
  if (!meta) {
    try {
      const msgs = (messages as any[]).slice().reverse();
      const lastUser = msgs.find((m) => m?.role === "user") || {};
      let text = "";
      if (Array.isArray(lastUser.parts)) {
        const t = lastUser.parts.find((p: any) => p?.type === "text");
        text = t?.text ?? "";
      }
      if (!text && typeof lastUser.content === "string")
        text = lastUser.content;
      if (!text && Array.isArray(lastUser.content)) {
        const t = lastUser.content.find(
          (p: any) => typeof p?.text === "string",
        );
        text = t?.text ?? "";
      }
      const urlMatch = text.match(/ISSUE_URL:\s*(\S+)/i);
      const issueUrl = urlMatch?.[1];
      if (issueUrl) {
        let issueKey: string | undefined;
        try {
          issueKey = parseIssueKeyFromUrl(issueUrl);
        } catch {}
        if (issueKey) {
          const alias = await context.store.get(`jira-meta-jira-${issueKey}`);
          if (alias) {
            meta = JSON.parse(alias);
            chatLog("jira.meta_fallback", {
              chatId: key,
              from: "kv",
              issueKey,
              issueUrl,
              hasAuthorId: !!(meta as any)?.authorId,
            });
          } else {
            const mentionMatch = text.match(/MENTION_ACCOUNT_ID:\s*([^\s]+)/i);
            meta = {
              issueKey,
              issueUrl,
              authorId: mentionMatch ? mentionMatch[1] : undefined,
            } as any;
            chatLog("jira.meta_fallback", {
              chatId: key,
              from: "message",
              issueKey,
              issueUrl,
              hasAuthorId: !!(meta as any)?.authorId,
            });
          }
        }
      }
    } catch {}
  }

  // Load GitHub metadata for this chat (if any)
  let ghMeta: null | {
    kind: "pr" | "issue";
    owner: string;
    repo: string;
    number: number;
  } = null;
  try {
    const raw = await context.store.get(`gh-meta-${key}`);
    if (raw) ghMeta = JSON.parse(raw);
  } catch {}
  // Fallback: parse TARGET line from most recent user message
  if (!ghMeta) {
    try {
      const msgs = (messages as any[]).slice().reverse();
      const lastUser = msgs.find((m) => m?.role === "user") || {};
      let text = "";
      // ai SDK UIMessage shape uses parts
      if (Array.isArray(lastUser.parts)) {
        const t = lastUser.parts.find((p: any) => p?.type === "text");
        text = t?.text ?? "";
      }
      // Some runtimes provide content as string/array
      if (!text && typeof lastUser.content === "string")
        text = lastUser.content;
      if (!text && Array.isArray(lastUser.content)) {
        const t = lastUser.content.find(
          (p: any) => typeof p?.text === "string",
        );
        text = t?.text ?? "";
      }
      const m = text.match(
        /TARGET:\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*#(\d+)/i,
      );
      if (m && m[1] && m[2] && m[3]) {
        const owner = m[1] as string;
        const repo = m[2] as string;
        const number = Number(m[3] as string);
        // Infer kind from the event line if present
        const evLine = (
          text.match(/GitHub event:\s*([^\n]+)/i)?.[1] ?? ""
        ).toLowerCase();
        const kind: "pr" | "issue" = /pull_request|check_run/.test(evLine)
          ? "pr"
          : "issue";
        ghMeta = { kind, owner, repo, number };
      }
    } catch {}
  }

  // Determine if the user explicitly mentioned the bot name ('blink') in the latest message
  let ghMentioned = false;
  try {
    const msgs = (messages as any[]).slice().reverse();
    const lastUser = msgs.find((m) => m?.role === "user") || {};
    let text = "";
    if (Array.isArray(lastUser.parts)) {
      const t = lastUser.parts.find((p: any) => p?.type === "text");
      text = t?.text ?? "";
    }
    if (!text && typeof lastUser.content === "string") text = lastUser.content;
    if (!text && Array.isArray(lastUser.content)) {
      const t = lastUser.content.find((p: any) => typeof p?.text === "string");
      text = t?.text ?? "";
    }
    ghMentioned = /\bblink\b/i.test(text);
  } catch {}

  try {
    chatLog("sendMessages", { chatId: key, kind: ghMeta?.kind });
    if (!ghMeta && meta?.issueUrl) {
      chatLog("jira.meta_loaded", {
        chatId: key,
        issueUrl: meta.issueUrl,
        hasAuthorId: !!meta.authorId,
      });
    }
  } catch {}

  try {
    return streamText({
      model: "anthropic/claude-sonnet-4",
      system: [
        ghMeta?.kind === "pr"
          ? "You are a GitHub assistant responding in pull request discussions."
          : ghMeta?.kind === "issue"
            ? "You are a GitHub assistant responding in issue discussions."
            : "You are a Jira assistant responding in issue comments.",
        "- Be concise, direct, and helpful.",
        "- No emojis or headers.",
        "- IMPORTANT: Always prefix new branches with 'blink/' (e.g., 'blink/fix-bug', 'blink/add-feature'). Only modify or work with branches that begin with 'blink/'.",
        ghMeta?.kind
          ? "- If unclear, ask one brief clarifying question."
          : "- If unclear, ask one brief clarifying question via jira_reply.",
        meta?.issueUrl ? `- Issue URL: ${meta.issueUrl}` : undefined,
        meta?.issueUrl
          ? "- Always post your response in Jira by calling the jira_reply tool exactly once. If you need a clarifying question, ask it via jira_reply. Do not reply only in this chat."
          : undefined,
        // Jira-specific guidance: never @mention the service account. Mention only the requester (jira_reply handles this)
        !ghMeta?.kind
          ? "- Never @mention the service account. Mention only the requester (jira_reply already handles this)."
          : undefined,
        ghMeta?.kind === "pr"
          ? `- GitHub PR: ${ghMeta.owner}/${ghMeta.repo} #${ghMeta.number}`
          : ghMeta?.kind === "issue"
            ? `- GitHub Issue: ${ghMeta.owner}/${ghMeta.repo} #${ghMeta.number}`
            : undefined,
        ghMeta?.kind && ghMentioned
          ? "- Always post a brief summary as a comment using github_create_issue_comment (set issue_number accordingly). Keep it concise."
          : ghMeta?.kind
            ? "- When useful, post a brief summary using github_create_issue_comment (set issue_number accordingly). Avoid trivial or duplicate comments."
            : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      messages: convertToModelMessages(messages),
      tools: (() => {
        const tools: Record<string, any> = {
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
              return {
                iso,
                date: iso.slice(0, 10),
                time: iso.slice(11, 19) + "Z",
                epochMillis: now.getTime(),
                timezone: "UTC",
                weekday: weekdayNames[weekdayIndex],
                weekdayIndex,
                month: monthNames[now.getUTCMonth()],
                monthIndex: now.getUTCMonth(),
                day: now.getUTCDate(),
                year: now.getUTCFullYear(),
                human: now.toUTCString(),
                rfc1123: now.toUTCString(),
                offsetMinutes: 0,
              };
            },
          }),
          ...createJiraTools({
            issueUrl: meta?.issueUrl ?? null,
            authorId: meta?.authorId ?? null,
          }),
          // --- GitHub tools (all, prefixed) ---
          ...blink.tools.prefix(
            blink.tools.withContext(github.tools, {
              appAuth: async () => getGithubAppContext(),
            }),
            "github_",
          ),
          // Enforce draft PRs and branch prefix on PR creation/update
          github_create_pull_request: tool({
            description: (github as any).tools.create_pull_request.description,
            inputSchema: (github as any).tools.create_pull_request.inputSchema,
            execute: async (args: any, { abortSignal }: any) => {
              const octokit = await getOctokit();
              const response = await octokit.request(
                "POST /repos/{owner}/{repo}/pulls",
                {
                  owner: args.owner,
                  repo: args.repo,
                  base: args.base,
                  head: args.head,
                  title: args.title,
                  body: args.body ?? "",
                  draft: true,
                  request: { signal: abortSignal },
                },
              );
              return {
                pull_request: {
                  number: response.data.number,
                  comments: response.data.comments,
                  title: response.data.title ?? "",
                  body: response.data.body ?? "",
                  state: response.data.state as "open" | "closed",
                  created_at: response.data.created_at,
                  updated_at: response.data.updated_at,
                  user: { login: response.data.user?.login ?? "" },
                  head: {
                    ref: response.data.head.ref,
                    sha: response.data.head.sha,
                  },
                  base: {
                    ref: response.data.base.ref,
                    sha: response.data.base.sha,
                  },
                  merged_at: response.data.merged_at ?? undefined,
                  merge_commit_sha: response.data.merge_commit_sha ?? undefined,
                  merged_by: response.data.merged_by
                    ? {
                        login: response.data.merged_by.login,
                        avatar_url: response.data.merged_by.avatar_url ?? "",
                        html_url: response.data.merged_by.html_url ?? "",
                      }
                    : undefined,
                  review_comments: response.data.review_comments,
                  additions: response.data.additions,
                  deletions: response.data.deletions,
                  changed_files: response.data.changed_files,
                },
              };
            },
          }),
          initialize_workspace: tool({
            description: "Initialize a Daytona workspace for this chat.",
            inputSchema: z.object({}),
            execute: async () => {
              const existing = await getDaytonaWorkspace(context, key);
              if (existing) return "Workspace already initialized.";
              if (!DAYTONA_API_KEY)
                throw new Error("DAYTONA_API_KEY must be set");
              const daytona = new Daytona({ apiKey: DAYTONA_API_KEY });
              const token = await compute.experimental_remote.token();
              const created = await daytona.create({
                snapshot: DAYTONA_SNAPSHOT,
                autoDeleteInterval: DAYTONA_TTL_MINUTES,
                envVars: { BLINK_TOKEN: token.token },
              });
              await setDaytonaWorkspace(context, key, {
                id: created.id,
                connectID: token.id,
              });
              return "Workspace initialized.";
            },
          }),
          workspace_authenticate_git: tool({
            description:
              "Authenticate with Git repositories for push/pull operations from the Daytona workspace.",
            inputSchema: z.object({
              owner: z.string(),
              repos: z.array(z.string()).min(1),
            }),
            execute: async (args: any) => {
              const ws = await getDaytonaWorkspace(context, key);
              if (!ws) throw new Error("Workspace not initialized.");
              let client;
              try {
                client = await compute.experimental_remote.connect(
                  ws.connectID,
                );
              } catch {
                if (!DAYTONA_API_KEY)
                  throw new Error(
                    "Workspace unavailable and DAYTONA_API_KEY not set to recreate.",
                  );
                const daytona = new Daytona({ apiKey: DAYTONA_API_KEY });
                const token = await compute.experimental_remote.token();
                const created = await daytona.create({
                  snapshot: DAYTONA_SNAPSHOT,
                  autoDeleteInterval: DAYTONA_TTL_MINUTES,
                  envVars: { BLINK_TOKEN: token.token },
                });
                await setDaytonaWorkspace(context, key, {
                  id: created.id,
                  connectID: token.id,
                });
                client = await compute.experimental_remote.connect(token.id);
              }
              const ghToken = await createInstallationToken(
                args.owner,
                args.repos[0],
                args.repos,
              );
              await client.request("set_env", {
                env: { GITHUB_TOKEN: ghToken },
              });
              return { ok: true };
            },
          }),
          github_update_pull_request: tool({
            description: (github as any).tools.update_pull_request.description,
            inputSchema: (github as any).tools.update_pull_request.inputSchema,
            execute: async (args: any, { abortSignal }: any) => {
              const octokit = await getOctokit();
              const response = await octokit.request(
                "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
                {
                  owner: args.owner,
                  repo: args.repo,
                  pull_number: args.pull_number,
                  title: args.title,
                  body: args.body,
                  state: args.state,
                  base: args.base_branch,
                  request: { signal: abortSignal },
                },
              );
              return {
                pull_request: {
                  number: response.data.number,
                  comments: response.data.comments,
                  title: response.data.title ?? "",
                  body: response.data.body ?? "",
                  state: response.data.state as "open" | "closed",
                  created_at: response.data.created_at,
                  updated_at: response.data.updated_at,
                  user: { login: response.data.user?.login ?? "" },
                  head: {
                    ref: response.data.head.ref,
                    sha: response.data.head.sha,
                  },
                  base: {
                    ref: response.data.base.ref,
                    sha: response.data.base.sha,
                  },
                  additions: response.data.additions,
                  deletions: response.data.deletions,
                  changed_files: response.data.changed_files,
                  review_comments: response.data.review_comments,
                  closed_at: response.data.closed_at ?? undefined,
                  merged_at: response.data.merged_at ?? undefined,
                  merge_commit_sha: response.data.merge_commit_sha ?? undefined,
                  merged_by: response.data.merged_by
                    ? {
                        login: response.data.merged_by.login,
                        avatar_url: response.data.merged_by.avatar_url ?? "",
                        html_url: response.data.merged_by.html_url ?? "",
                      }
                    : undefined,
                },
              };
            },
          }),
        };
        // Create validated compute tools with branch name validation
        const validatedComputeTools = {
          ...(compute.tools as any),
          execute_bash: {
            ...(compute.tools as any).execute_bash,
            execute: async (args: any, context: any) => {
              return (compute.tools as any).execute_bash.execute(args, context);
            },
          },
          execute_bash_sync: {
            ...(compute.tools as any).execute_bash_sync,
            execute: async (args: any, context: any) => {
              return (compute.tools as any).execute_bash_sync.execute(
                args,
                context,
              );
            },
          },
        };

        Object.assign(
          tools,
          blink.tools.withContext(validatedComputeTools, {
            client: async () => {
              const ws = await getDaytonaWorkspace(context, key);
              if (!ws)
                throw new Error("You must call 'initialize_workspace' first.");
              try {
                return await compute.experimental_remote.connect(ws.connectID);
              } catch (e) {
                if (!DAYTONA_API_KEY)
                  throw new Error(
                    "Workspace unavailable and DAYTONA_API_KEY not set to recreate.",
                  );
                const daytona = new Daytona({ apiKey: DAYTONA_API_KEY });
                const token = await compute.experimental_remote.token();
                const created = await daytona.create({
                  snapshot: DAYTONA_SNAPSHOT,
                  autoDeleteInterval: DAYTONA_TTL_MINUTES,
                  envVars: { BLINK_TOKEN: token.token },
                });
                await setDaytonaWorkspace(context, key, {
                  id: created.id,
                  connectID: token.id,
                });
                return await compute.experimental_remote.connect(token.id);
              }
            },
          }),
        );
        if (!meta?.issueUrl && tools["jira_reply"]) {
          delete tools["jira_reply"];
        }
        try {
          if (!ghMeta && meta?.issueUrl) {
            // Force deterministic posting: remove generic comment tool in Jira-context
            if ((tools as any)["jira_add_comment"])
              delete (tools as any)["jira_add_comment"];
            chatLog("jira.tools", {
              has_jira_reply: !!(tools as any)["jira_reply"],
              has_jira_add_comment: !!(tools as any)["jira_add_comment"],
              jira_tool_keys: Object.keys(tools).filter((k) =>
                k.startsWith("jira_"),
              ),
            });
          }
        } catch {}
        return tools as any;
      })(),
    });
  } catch (err) {
    console.error("streamText error", err);
    throw err;
  }
});

agent.on("request", async (request, context) => {
  const url = new URL(request.url);
  const reqId = rid();
  log("request_received", {
    reqId,
    path: url.pathname,
    method: request.method,
  });

  // Handle GitHub webhooks at /github
  if (url.pathname.startsWith("/github")) {
    if (!GITHUB_WEBHOOK_SECRET)
      return new Response("Unauthorized", { status: 401 });
    const webhooks = new Webhooks({ secret: GITHUB_WEBHOOK_SECRET });
    const [id, event, signature] = [
      request.headers.get("x-github-delivery"),
      request.headers.get("x-github-event"),
      request.headers.get("x-hub-signature-256"),
    ];
    if (!signature || !id || !event) {
      return new Response("Unauthorized", { status: 401 });
    }

    webhooks.on("issue_comment", async (e) => {
      try {
        if (GITHUB_BOT_LOGIN && e.payload.sender?.login === GITHUB_BOT_LOGIN)
          return;
        const owner = e.payload.repository.owner.login;
        const repo = e.payload.repository.name;
        const number = e.payload.issue.number;
        const isPr = !!e.payload.issue?.pull_request;
        const body = e.payload.comment?.body || "";
        if (!/\bblink\b/i.test(body)) return; // only respond when mentioned
        const chatID = isPr
          ? `gh-pr~${owner}~${repo}~${number}`
          : `gh-issue~${owner}~${repo}~${number}`;
        try {
          await context.store.set(
            `gh-meta-${chatID}`,
            JSON.stringify({
              kind: isPr ? "pr" : "issue",
              owner,
              repo,
              number,
            }),
          );
        } catch {}
        const text = body;
        const msg = [
          `GitHub event: issue_comment by ${e.payload.sender?.login}`,
          "",
          "Comment:",
          text,
          "",
          `TARGET: ${owner}/${repo} #${number}`,
        ]
          .filter(Boolean)
          .join("\n");
        console.log("gh.enqueue", {
          evt: "issue_comment",
          owner,
          repo,
          pr: number,
          by: e.payload.sender?.login,
        });
        await context.chat.message(
          chatID,
          { role: "user", parts: [{ type: "text", text: msg }] },
          { behavior: "interrupt" },
        );
        console.log("gh.enqueued", { chatId: chatID });
      } catch (err) {
        console.error("issue_comment handler error", err);
      }
    });

    webhooks.on("pull_request_review_comment", async (e) => {
      try {
        if (GITHUB_BOT_LOGIN && e.payload.sender?.login === GITHUB_BOT_LOGIN)
          return;
        const owner = e.payload.repository.owner.login;
        const repo = e.payload.repository.name;
        const number = e.payload.pull_request.number;
        const chatID = `gh-pr~${owner}~${repo}~${number}`;
        try {
          await context.store.set(
            `gh-meta-${chatID}`,
            JSON.stringify({ kind: "pr", owner, repo, number }),
          );
        } catch {}
        const text = e.payload.comment?.body || "";
        const msg = [
          `GitHub event: pull_request_review_comment by ${e.payload.sender?.login}`,
          "",
          "Comment:",
          text,
          "",
          `TARGET: ${owner}/${repo} #${number}`,
        ]
          .filter(Boolean)
          .join("\n");
        console.log("gh.enqueue", {
          evt: "pull_request_review_comment",
          owner,
          repo,
          pr: number,
          by: e.payload.sender?.login,
        });
        await context.chat.message(
          chatID,
          { role: "user", parts: [{ type: "text", text: msg }] },
          { behavior: "interrupt" },
        );
        console.log("gh.enqueued", { chatId: chatID });
      } catch (err) {
        console.error("pull_request_review_comment handler error", err);
      }
    });

    webhooks.on("pull_request_review", async (e) => {
      try {
        if (GITHUB_BOT_LOGIN && e.payload.sender?.login === GITHUB_BOT_LOGIN)
          return;
        const owner = e.payload.repository.owner.login;
        const repo = e.payload.repository.name;
        const number = e.payload.pull_request.number;
        const chatID = `gh-pr~${owner}~${repo}~${number}`;
        try {
          await context.store.set(
            `gh-meta-${chatID}`,
            JSON.stringify({ kind: "pr", owner, repo, number }),
          );
        } catch {}
        const state = e.payload.review?.state || "";
        const body = e.payload.review?.body || "";
        const msg = [
          `GitHub event: pull_request_review (${state}) by ${e.payload.sender?.login}`,
          "",
          body ? "Review body:" : "",
          body,
          "",
          `TARGET: ${owner}/${repo} #${number}`,
        ]
          .filter(Boolean)
          .join("\n");
        console.log("gh.enqueue", {
          evt: "pull_request_review",
          owner,
          repo,
          pr: number,
          state,
          by: e.payload.sender?.login,
        });
        await context.chat.message(
          chatID,
          { role: "user", parts: [{ type: "text", text: msg }] },
          { behavior: "interrupt" },
        );
        console.log("gh.enqueued", { chatId: chatID });
      } catch (err) {
        console.error("pull_request_review handler error", err);
      }
    });

    webhooks.on("check_run.completed", async (e) => {
      try {
        const concl = e.payload.check_run?.conclusion;
        if (concl === "success" || concl === "skipped") return;
        const prs = e.payload.check_run?.pull_requests || [];
        for (const pr of prs) {
          if (e.payload.check_run.head_sha !== pr.head?.sha) continue; // stale check run
          const owner = e.payload.repository.owner.login;
          const repo = e.payload.repository.name;
          const number = pr.number;
          // Only act on agent-owned branches
          const octokit = await getOctokit();
          let headRef: string | undefined;
          try {
            const get = await octokit.request(
              "GET /repos/{owner}/{repo}/pulls/{pull_number}",
              { owner, repo, pull_number: number },
            );
            headRef = get.data.head.ref;
          } catch {}
          const chatID = `gh-pr~${owner}~${repo}~${number}`;
          try {
            await context.store.set(
              `gh-meta-${chatID}`,
              JSON.stringify({ kind: "pr", owner, repo, number }),
            );
          } catch {}
          const details = [
            `Check: ${e.payload.check_run.name}`,
            `Conclusion: ${concl}`,
            e.payload.check_run.details_url
              ? `Details: ${e.payload.check_run.details_url}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
          const msg = [
            "GitHub event: check_run.completed (non-success)",
            "",
            details,
            "",
            `TARGET: ${owner}/${repo} #${number}`,
          ]
            .filter(Boolean)
            .join("\n");
          console.log("gh.enqueue", {
            evt: "check_run.completed",
            owner,
            repo,
            pr: number,
            conclusion: concl,
          });
          await context.chat.message(
            chatID,
            { role: "user", parts: [{ type: "text", text: msg }] },
            { behavior: "interrupt" },
          );
          console.log("gh.enqueued", { chatId: chatID });
        }
      } catch (err) {
        console.error("check_run.completed handler error", err);
      }
    });

    return webhooks
      .verifyAndReceive({
        id,
        name: event as any,
        payload: await request.text(),
        signature,
      })
      .then(() => new Response("OK", { status: 200 }))
      .catch(() => new Response("Error", { status: 500 }));
  }

  // Handle Jira automation webhooks at /jira (existing behavior)
  if (!url.pathname.startsWith("/jira")) {
    log("request_ignored", { reqId, reason: "path_mismatch" });
    return new Response("OK", { status: 200 });
  }

  const authHeader =
    request.headers.get("authorization") ||
    request.headers.get("Authorization");
  if (
    JIRA_AUTOMATION_SECRET &&
    authHeader !== `Bearer ${JIRA_AUTOMATION_SECRET}`
  ) {
    log("auth_failed", { reqId });
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch (e) {
    log("json_parse_error", { reqId, error: (e as Error)?.message });
    return new Response("Bad Request", { status: 400 });
  }

  const issueKey: string | undefined = payload?.issue?.key ?? payload?.key;
  const comment = payload?.comment;
  if (!issueKey || !comment) {
    log("payload_missing_fields", {
      reqId,
      issueKeyPresent: !!issueKey,
      commentPresent: !!comment,
    });
    return new Response("OK", { status: 200 });
  }

  requireEnv();
  const serviceAccountId = await getServiceAccountId();
  let authorId: string | undefined =
    comment?.author?.accountId ?? comment?.authorId;
  const commentId: string | undefined = comment?.id ?? comment?.commentId;

  // Prevent loops: ignore comments authored by the service account itself
  if (authorId && authorId === serviceAccountId) {
    log("no_action", { reqId, reason: "self_author" });
    return new Response("OK", { status: 200 });
  }

  let adfBody: any = comment.body;
  if (typeof adfBody === "string") {
    try {
      adfBody = JSON.parse(adfBody);
    } catch {
      adfBody = undefined;
    }
  }
  if (!adfBody && commentId) {
    try {
      const fetched = await getJson<any>(
        `/rest/api/3/issue/${issueKey}/comment/${commentId}`,
      );
      adfBody = fetched?.body;
      if (!authorId) {
        const backfill =
          fetched?.author?.accountId ?? fetched?.authorId ?? null;
        if (backfill) {
          authorId = backfill;
          log("jira.author_backfill", { reqId, issueKey, commentId });
        }
      }
    } catch (e) {
      log("fetch_comment_failed", {
        reqId,
        issueKey,
        commentId,
        error: (e as Error)?.message,
      });
    }
  }

  const hasMention = !!adfBody && adfContainsMention(adfBody, serviceAccountId);
  log("jira.context", {
    reqId,
    issueKey,
    commentId,
    authorId,
    self_author: !!authorId && authorId === serviceAccountId,
    hasMention,
  });
  if (!adfBody || !hasMention) {
    log("no_action", {
      reqId,
      reason: !adfBody ? "no_body" : "no_mention",
    });
    return new Response("OK", { status: 200 });
  }

  const userText = adfText(adfBody).trim();
  const base = (getJiraSiteBase() || "https://example.invalid").replace(
    /\/$/,
    "",
  );
  const issueUrl = `${base}/browse/${issueKey}`;

  const chatID = `jira-${issueKey}`;
  await context.store.set(
    `jira-meta-${chatID}`,
    JSON.stringify({ issueKey, issueUrl, authorId: authorId ?? null }),
  );
  log("jira.meta_set", {
    reqId,
    chatId: chatID,
    issueKey,
    hasAuthorId: !!authorId,
  });
  try {
    await context.store.set(
      `jira-meta-jira-${issueKey}`,
      JSON.stringify({ issueKey, issueUrl, authorId: authorId ?? null }),
    );
  } catch {}

  const composed = [
    userText,
    `\n\nISSUE_URL: ${issueUrl}`,
    authorId ? `MENTION_ACCOUNT_ID: ${authorId}` : "",
  ]
    .filter(Boolean)
    .join("");
  await context.chat.message(
    chatID,
    { role: "user", parts: [{ type: "text", text: composed }] },
    { behavior: "interrupt" },
  );

  log("chat_enqueued", { reqId, chatId: chatID, issueKey });
  return new Response("OK", { status: 200 });
});

agent.serve();
