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
} from "./jira";
import type { JiraMyself } from "./jira";
import * as github from "@blink-sdk/github";
import { Webhooks } from "@octokit/webhooks";
import { Octokit } from "@octokit/core";
import { createAppAuth } from "@octokit/auth-app";

const GITHUB_APP_ID = process.env.GITHUB_APP_ID?.trim();
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
const GITHUB_APP_INSTALLATION_ID =
  process.env.GITHUB_APP_INSTALLATION_ID?.trim();
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET?.trim();
const GITHUB_BOT_LOGIN = process.env.GITHUB_BOT_LOGIN?.trim();

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

blink
  .agent({
    async sendMessages({ messages, chat }) {
      let meta: {
        issueKey?: string;
        issueUrl?: string;
        authorId?: string;
      } | null = null;
      try {
        const raw = chat
          ? await blink.storage.kv.get(`jira-meta-${chat.id}`)
          : null;
        if (raw) meta = JSON.parse(raw);
      } catch {}

      const gh = parseGhPrChatId(chat?.id);
      try {
        console.log("sendMessages", {
          chatId: chat?.id,
          isGh: !!gh,
          msgCount: messages.length,
        });
      } catch {}

      try {
        return streamText({
          model: "anthropic/claude-sonnet-4",
          system: [
            gh
              ? "You are a GitHub assistant responding in pull request discussions."
              : "You are a Jira assistant responding in issue comments.",
            "- Be concise, direct, and helpful.",
            "- No emojis or headers.",
            "- If unclear, ask one brief clarifying question.",
            meta?.issueUrl ? `- Issue URL: ${meta.issueUrl}` : undefined,
            meta?.issueUrl
              ? "- Always deliver your final answer by calling the jira_reply tool exactly once with your final text."
              : undefined,
            gh
              ? `- GitHub PR: ${gh.owner}/${gh.repo} #${gh.prNumber}`
              : undefined,
            gh
              ? "- Always post a brief summary using github_create_issue_comment (set issue_number to the PR number)."
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
                blink.tools.with(github.tools, {
                  appAuth: async () => getGithubAppContext(),
                }),
                "github_",
              ),
            };
            if (!meta?.issueUrl && tools["jira_reply"]) {
              delete tools["jira_reply"];
            }
            return tools as any;
          })(),
        });
      } catch (err) {
        console.error("streamText error", err);
        throw err;
      }
    },

    async onRequest(request) {
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

        try {
          console.log("github.headers", { id, event, hasSig: !!signature });
        } catch {}
        // Catch-all name logging
        // @ts-ignore onAny exists in @octokit/webhooks
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        webhooks.onAny((ev: any) => {
          try {
            console.log("github.onAny", { name: ev.name });
          } catch {}
        });

        webhooks.on("issue_comment", async (e) => {
          try {
            if (
              GITHUB_BOT_LOGIN &&
              e.payload.sender?.login === GITHUB_BOT_LOGIN
            )
              return;
            if (!e.payload.issue?.pull_request) return; // only PR issues
            const owner = e.payload.repository.owner.login;
            const repo = e.payload.repository.name;
            const number = e.payload.issue.number;
            const chat = await blink.chat.upsert(
              `gh-pr~${owner}~${repo}~${number}`,
            );
            const text = e.payload.comment?.body || "";
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
            await blink.chat.message(
              chat.id,
              { role: "user", parts: [{ type: "text", text: msg }] },
              { behavior: "interrupt" },
            );
            console.log("gh.enqueued", { chatId: chat.id });
          } catch (err) {
            console.error("issue_comment handler error", err);
          }
        });

        webhooks.on("pull_request_review_comment", async (e) => {
          try {
            if (
              GITHUB_BOT_LOGIN &&
              e.payload.sender?.login === GITHUB_BOT_LOGIN
            )
              return;
            const owner = e.payload.repository.owner.login;
            const repo = e.payload.repository.name;
            const number = e.payload.pull_request.number;
            const chat = await blink.chat.upsert(
              `gh-pr~${owner}~${repo}~${number}`,
            );
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
            await blink.chat.message(
              chat.id,
              { role: "user", parts: [{ type: "text", text: msg }] },
              { behavior: "interrupt" },
            );
            console.log("gh.enqueued", { chatId: chat.id });
          } catch (err) {
            console.error("pull_request_review_comment handler error", err);
          }
        });

        webhooks.on("pull_request_review", async (e) => {
          try {
            if (
              GITHUB_BOT_LOGIN &&
              e.payload.sender?.login === GITHUB_BOT_LOGIN
            )
              return;
            const owner = e.payload.repository.owner.login;
            const repo = e.payload.repository.name;
            const number = e.payload.pull_request.number;
            const chat = await blink.chat.upsert(
              `gh-pr~${owner}~${repo}~${number}`,
            );
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
            await blink.chat.message(
              chat.id,
              { role: "user", parts: [{ type: "text", text: msg }] },
              { behavior: "interrupt" },
            );
            console.log("gh.enqueued", { chatId: chat.id });
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
              const chat = await blink.chat.upsert(
                `gh-pr~${owner}~${repo}~${number}`,
              );
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
              await blink.chat.message(
                chat.id,
                { role: "user", parts: [{ type: "text", text: msg }] },
                { behavior: "interrupt" },
              );
              console.log("gh.enqueued", { chatId: chat.id });
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
      const authorId: string | undefined =
        comment?.author?.accountId ?? comment?.authorId;
      const commentId: string | undefined = comment?.id ?? comment?.commentId;

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
        } catch (e) {
          log("fetch_comment_failed", {
            reqId,
            issueKey,
            commentId,
            error: (e as Error)?.message,
          });
        }
      }

      const hasMention =
        !!adfBody && adfContainsMention(adfBody, serviceAccountId);
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

      const chat = await blink.chat.upsert(`jira-${issueKey}`);
      await blink.storage.kv.set(
        `jira-meta-${chat.id}`,
        JSON.stringify({ issueKey, issueUrl, authorId: authorId ?? null }),
      );

      const composed = [
        userText,
        `\n\nISSUE_URL: ${issueUrl}`,
        authorId ? `MENTION_ACCOUNT_ID: ${authorId}` : "",
      ]
        .filter(Boolean)
        .join("");
      await blink.chat.message(
        chat.id,
        { role: "user", parts: [{ type: "text", text: composed }] },
        { behavior: "interrupt" },
      );

      log("chat_enqueued", { reqId, chatId: chat.id, issueKey });
      return new Response("OK", { status: 200 });
    },
  })
  .serve();
