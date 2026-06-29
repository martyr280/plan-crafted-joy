import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";
import {
  ASK_NELSON_TOOLS,
  callGateway,
  getSchemaDigest,
  runTool,
  type ChatMsg,
} from "./ask-nelson.server";

const FLASH = "google/gemini-3-flash-preview";
const STRONG = "openai/gpt-5.4";

const TRANSIENT_BACKEND_PATTERNS = [
  /schema cache/i,
  /retrying/i,
  /timeout/i,
  /timed out/i,
  /temporarily unavailable/i,
  /backend unreachable/i,
  /fetch failed/i,
  /network/i,
  /520|521|522|523|524/,
];

const CHALLENGE_PATTERNS = [
  /are you sure/i,
  /double[- ]?check/i,
  /dig deeper/i,
  /that'?s wrong/i,
  /that is wrong/i,
  /look again/i,
  /you'?re wrong/i,
  /incorrect/i,
  /really\?/i,
  /verify/i,
];

function shouldEscalate(message: string, explicit?: boolean) {
  if (explicit) return true;
  return CHALLENGE_PATTERNS.some((r) => r.test(message));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backendErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isTransientBackendError(message: string) {
  return TRANSIENT_BACKEND_PATTERNS.some((pattern) => pattern.test(message));
}

async function retryTransient<T>(label: string, operation: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = backendErrorMessage(error);
      if (!isTransientBackendError(message) || attempt === attempts - 1) break;
      console.warn(`${label} transient backend error; retrying`, {
        attempt: attempt + 1,
        message: message.slice(0, 300),
      });
      await sleep(Math.min(4000, 350 * 2 ** attempt));
    }
  }
  throw lastError;
}

function throwIfDbError(error: unknown) {
  if (error) throw new Error(backendErrorMessage(error));
}

async function retrySupabase<T>(label: string, operation: () => Promise<{ data: T; error: unknown }>) {
  const { data } = await retryTransient(label, async () => {
    const res = await operation();
    throwIfDbError(res.error);
    return res;
  });
  return data;
}

function systemPrompt(escalate: boolean) {
  return [
    `You are Nelson, a database-grounded assistant for NDI Office Furniture's operations platform.`,
    ``,
    `Hard rules:`,
    `1. Only answer using rows actually returned by your tools in THIS turn. Never invent SKUs, customers, totals, or dates.`,
    `2. If the tools return zero matching rows, or you cannot ground an answer, reply EXACTLY: "I don't know based on the data I can see." (You may then suggest one clarifying question.)`,
    `3. Keep answers to 1-3 short sentences unless the user asks for detail. No preamble, no apologies.`,
    `4. Use Markdown for short lists/tables only when it actually helps readability.`,
    `5. End every grounded answer with a tiny italic line listing the tables you read, like: _sources: orders, ar_aging_`,
    `6. Never expose raw IDs unless the user asked for them.`,
    ``,
    escalate
      ? `The user is challenging a prior answer or asked for a deep dive. Be thorough: call tools multiple times, cross-check counts, widen filters, and explain any reconciliation you did. Still obey the rules above.`
      : `Default mode: be concise. Use the smallest number of tool calls that gets a grounded answer.`,
    ``,
    `Available tables and columns:`,
    getSchemaDigest(),
  ].join("\n");
}

async function improvePrompt(userMessage: string, history: ChatMsg[]) {
  try {
    const recent = history.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
    const res = await callGateway({
      model: FLASH,
      messages: [
        {
          role: "system",
          content:
            "You rewrite a user question into a precise, self-contained question for a database assistant. Resolve pronouns from recent history. Mention likely table(s) and filters. Reply with one sentence only.",
        },
        { role: "user", content: `Recent:\n${recent}\n\nQuestion: ${userMessage}` },
      ],
    });
    const text = res?.choices?.[0]?.message?.content?.trim();
    return text || userMessage;
  } catch {
    return userMessage;
  }
}

async function generateTitle(message: string) {
  try {
    const res = await callGateway({
      model: FLASH,
      messages: [
        { role: "system", content: "Give a 2-5 word title for this question. Plain text, no quotes." },
        { role: "user", content: message },
      ],
    });
    const t = res?.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, "");
    return (t || "New chat").slice(0, 60);
  } catch {
    return "New chat";
  }
}

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      const data = await retrySupabase("listConversations", () =>
        context.supabase
          .from("chat_conversations")
          .select("id, title, created_at, updated_at")
          .order("updated_at", { ascending: false })
          .limit(100),
      );
      return { conversations: data ?? [] };
    } catch (error) {
      const message = backendErrorMessage(error);
      if (!isTransientBackendError(message)) throw error;
      console.warn("listConversations transient backend error; returning safe fallback", {
        message: message.slice(0, 300),
      });
      return { conversations: [], transientError: message.slice(0, 300) };
    }
  });

export const getConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    try {
      return await retryTransient("getConversation", async () => {
        const conv = await retrySupabase("getConversation.conversation", () =>
          context.supabase
            .from("chat_conversations")
            .select("id, title, created_at, updated_at")
            .eq("id", data.id)
            .maybeSingle(),
        );
        if (!conv) return { conversation: null, messages: [] };
        const msgs = await retrySupabase("getConversation.messages", () =>
          context.supabase
            .from("chat_messages")
            .select("id, role, content, model, created_at")
            .eq("conversation_id", data.id)
            .order("created_at", { ascending: true }),
        );
        return { conversation: conv, messages: (msgs ?? []).filter((m) => m.role !== "tool") };
      });
    } catch (error) {
      const message = backendErrorMessage(error);
      if (!isTransientBackendError(message)) throw error;
      console.warn("getConversation transient backend error; returning safe fallback", {
        message: message.slice(0, 300),
      });
      return { conversation: null, messages: [], transientError: message.slice(0, 300) };
    }
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const conversation = await retryTransient("createConversation", async () => {
      const data = await retrySupabase("createConversation.insert", () =>
        context.supabase
        .from("chat_conversations")
        .insert({ user_id: context.userId, title: "New chat" })
        .select("id, title, created_at, updated_at")
        .single(),
      );
      if (!data) throw new Error("Failed to create conversation");
      return data;
    });
    return { conversation };
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    await retryTransient("deleteConversation", async () => {
      await retrySupabase("deleteConversation.delete", () =>
        context.supabase.from("chat_conversations").delete().eq("id", data.id),
      );
      return true;
    });
    return { ok: true };
  });

export const askNelson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      conversationId: z.string().uuid(),
      message: z.string().min(1).max(4000),
      escalate: z.boolean().optional(),
    }).parse,
  )
  .handler(async ({ data, context }) => {
    // Verify ownership via user-scoped client
    const conv = await retrySupabase("askNelson.verifyConversation", () =>
      context.supabase
        .from("chat_conversations")
        .select("id, title")
        .eq("id", data.conversationId)
        .maybeSingle(),
    );
    if (!conv) throw new Error("Conversation not found");

    const escalate = shouldEscalate(data.message, data.escalate);
    const model = escalate ? STRONG : FLASH;
    const maxToolCalls = escalate ? 8 : 4;

    // Load recent history
    const history = await retrySupabase("askNelson.history", () =>
      supabaseAdmin
        .from("chat_messages")
        .select("role, content")
        .eq("conversation_id", data.conversationId)
        .order("created_at", { ascending: true })
        .limit(40),
    );

    const historyMsgs: ChatMsg[] = (history ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Persist user message immediately
    await retrySupabase("askNelson.insertUserMessage", () =>
      supabaseAdmin.from("chat_messages").insert({
        conversation_id: data.conversationId,
        role: "user",
        content: data.message,
      }),
    );

    // Prompt-improvement pre-pass (not shown to user)
    const refined = await improvePrompt(data.message, historyMsgs);

    const messages: ChatMsg[] = [
      { role: "system", content: systemPrompt(escalate) },
      ...historyMsgs,
      { role: "user", content: `${data.message}\n\n[internal rewrite: ${refined}]` },
    ];

    let finalText = "";
    let usedModel = model;
    try {
      for (let i = 0; i < maxToolCalls + 1; i++) {
        const res = await callGateway({
          model,
          messages,
          tools: ASK_NELSON_TOOLS,
          reasoning: escalate ? { effort: "high" } : undefined,
        });
        const choice = res?.choices?.[0]?.message;
        if (!choice) throw new Error("Empty response from AI");
        usedModel = res.model || model;

        const toolCalls = choice.tool_calls;
        if (toolCalls && toolCalls.length) {
          messages.push({ role: "assistant", content: choice.content ?? "", tool_calls: toolCalls });
          for (const call of toolCalls) {
            let result: unknown;
            try {
              const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
              result = await runTool(call.function.name, args);
            } catch (e) {
              result = { error: e instanceof Error ? e.message : String(e) };
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function?.name,
              content: JSON.stringify(result).slice(0, 12000),
            });
          }
          continue;
        }

        finalText = (choice.content ?? "").trim() || "I don't know based on the data I can see.";
        break;
      }
      if (!finalText) finalText = "I don't know based on the data I can see.";
    } catch (e) {
      finalText = `Error: ${e instanceof Error ? e.message : String(e)}`;
    }

    await retrySupabase("askNelson.insertAssistantMessage", () =>
      supabaseAdmin.from("chat_messages").insert({
        conversation_id: data.conversationId,
        role: "assistant",
        content: finalText,
        model: usedModel,
      }),
    );

    // Auto-title on first turn
    if (conv.title === "New chat") {
      const title = await generateTitle(data.message);
      await retrySupabase("askNelson.updateTitle", () =>
        supabaseAdmin.from("chat_conversations").update({ title }).eq("id", data.conversationId),
      );
    } else {
      await retrySupabase("askNelson.touchConversation", () =>
        supabaseAdmin
          .from("chat_conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", data.conversationId),
      );
    }

    return { reply: finalText, model: usedModel, escalated: escalate };
  });
