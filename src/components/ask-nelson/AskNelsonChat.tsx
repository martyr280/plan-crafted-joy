import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Send, Sparkles, Trash2, Plus, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useAskNelson,
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
} from "@/hooks/useAskNelson";

interface Props {
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  compact?: boolean;
}

export function AskNelsonChat({ conversationId, setConversationId, compact }: Props) {
  const convs = useConversations();
  const conv = useConversation(conversationId);
  const create = useCreateConversation();
  const del = useDeleteConversation();
  const ask = useAskNelson(conversationId);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = conv.data?.messages ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, ask.isPending]);

  async function ensureConv() {
    if (conversationId) return conversationId;
    const r = await create.mutateAsync();
    if (!r.conversation) throw new Error("Failed to create conversation");
    setConversationId(r.conversation.id);
    return r.conversation.id;
  }

  async function send(escalate = false) {
    const text = input.trim();
    if (!text || ask.isPending) return;
    const id = await ensureConv();
    setInput("");
    ask.mutate({ message: text, escalate, conversationId: id });
  }

  async function digDeeper() {
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (!last || ask.isPending || !conversationId) return;
    ask.mutate({ message: `Please dig deeper and double-check: ${last.content}`, escalate: true });
  }

  return (
    <div className={cn("flex h-full min-h-0", compact ? "flex-col" : "gap-4")}>
      {!compact && (
        <aside className="w-64 shrink-0 border rounded-lg bg-card flex flex-col">
          <div className="p-2 border-b">
            <Button
              size="sm"
              variant="secondary"
              className="w-full justify-start"
              onClick={async () => {
                const r = await create.mutateAsync();
                if (!r.conversation) throw new Error("Failed to create conversation");
                setConversationId(r.conversation.id);
              }}
            >
              <Plus className="w-4 h-4 mr-2" /> New chat
            </Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-1 space-y-0.5">
              {(convs.data?.conversations ?? []).map((c) => (
                <button
                  key={c.id}
                  onClick={() => setConversationId(c.id)}
                  className={cn(
                    "w-full text-left text-sm px-2 py-1.5 rounded-md hover:bg-accent flex items-center justify-between group",
                    conversationId === c.id && "bg-accent",
                  )}
                >
                  <span className="truncate flex-1">{c.title}</span>
                  <Trash2
                    className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0 ml-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      del.mutate(c.id);
                      if (conversationId === c.id) setConversationId(null);
                    }}
                  />
                </button>
              ))}
              {convs.data?.conversations?.length === 0 && (
                <div className="text-xs text-muted-foreground px-2 py-4 text-center">No chats yet.</div>
              )}
            </div>
          </ScrollArea>
        </aside>
      )}

      <section className="flex-1 min-w-0 flex flex-col border rounded-lg bg-card">
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
          {messages.length === 0 && !ask.isPending && (
            <div className="text-center text-sm text-muted-foreground py-8">
              <Sparkles className="w-6 h-6 mx-auto mb-2 text-primary" />
              Ask Nelson anything about orders, inventory, AR, logistics, pricing…
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
                )}
              >
                {m.role === "assistant" ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:my-1 [&>ul]:my-1 [&_em]:text-xs [&_em]:text-muted-foreground">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap">{m.content}</div>
                )}
              </div>
            </div>
          ))}
          {ask.isPending && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2 text-sm flex items-center gap-2 text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
              </div>
            </div>
          )}
        </div>

        {messages.length > 0 && messages[messages.length - 1].role === "assistant" && !ask.isPending && (
          <div className="px-3 pb-2">
            <Button size="sm" variant="ghost" onClick={digDeeper} className="text-xs h-7">
              <Search className="w-3 h-3 mr-1" /> Dig deeper
            </Button>
          </div>
        )}

        <div className="border-t p-2 flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask Nelson…"
            disabled={ask.isPending}
          />
          <Button onClick={() => send()} disabled={ask.isPending || !input.trim()} size="icon">
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </section>
    </div>
  );
}
