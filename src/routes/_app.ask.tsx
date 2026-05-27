import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AskNelsonChat } from "@/components/ask-nelson/AskNelsonChat";

export const Route = createFileRoute("/_app/ask")({
  component: AskPage,
});

function AskPage() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  return (
    <div className="h-[calc(100vh-7rem)] flex flex-col">
      <div className="mb-3">
        <h1 className="text-2xl font-bold tracking-tight">Ask Nelson</h1>
        <p className="text-sm text-muted-foreground">
          Chat with your operations database. Grounded answers, with a "Dig deeper" mode when you challenge the result.
        </p>
      </div>
      <div className="flex-1 min-h-0">
        <AskNelsonChat conversationId={conversationId} setConversationId={setConversationId} />
      </div>
    </div>
  );
}
