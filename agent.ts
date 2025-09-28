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
      JSON.stringify({ level: "info", source: "jira-webhook", event, ...data })
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

      return streamText({
        model: "anthropic/claude-sonnet-4",
        system: [
          "You are a Jira assistant responding in issue comments.",
          "- Be concise, direct, and helpful.",
          "- No emojis or headers.",
          "- If unclear, ask one brief clarifying question.",
          meta?.issueUrl ? `- Issue URL: ${meta.issueUrl}` : undefined,
          "- Always deliver your final answer by calling the jira_reply tool exactly once with your final text.",
        ]
          .filter(Boolean)
          .join("\n"),
        messages: convertToModelMessages(messages),
        tools: {
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
        },
      });
    },

    async onRequest(request) {
      const url = new URL(request.url);
      const reqId = rid();
      log("request_received", {
        reqId,
        path: url.pathname,
        method: request.method,
      });
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
            `/rest/api/3/issue/${issueKey}/comment/${commentId}`
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
        ""
      );
      const issueUrl = `${base}/browse/${issueKey}`;

      const chat = await blink.chat.upsert(`jira-${issueKey}`);
      await blink.storage.kv.set(
        `jira-meta-${chat.id}`,
        JSON.stringify({ issueKey, issueUrl, authorId: authorId ?? null })
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
        { behavior: "interrupt" }
      );

      log("chat_enqueued", { reqId, chatId: chat.id, issueKey });
      return new Response("OK", { status: 200 });
    },
  })
  .serve();
