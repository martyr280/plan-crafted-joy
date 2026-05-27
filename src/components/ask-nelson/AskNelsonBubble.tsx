import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Sparkles, X, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AskNelsonChat } from "./AskNelsonChat";
import { cn } from "@/lib/utils";

export function AskNelsonBubble() {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);

  return (
    <>
      {!open && (
        <Button
          onClick={() => setOpen(true)}
          size="icon"
          className="fixed bottom-5 right-5 z-50 rounded-full w-12 h-12 shadow-lg"
          aria-label="Ask Nelson"
        >
          <Sparkles className="w-5 h-5" />
        </Button>
      )}
      <div
        className={cn(
          "fixed bottom-5 right-5 z-50 w-[380px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100vh-6rem)] rounded-xl border bg-background shadow-2xl flex flex-col transition-all",
          open ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none",
        )}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="w-4 h-4 text-primary" /> Ask Nelson
          </div>
          <div className="flex items-center gap-1">
            <Button asChild size="icon" variant="ghost" className="h-7 w-7">
              <Link to="/ask" onClick={() => setOpen(false)} aria-label="Open full chat">
                <Maximize2 className="w-3.5 h-3.5" />
              </Link>
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setOpen(false)} aria-label="Close">
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex-1 min-h-0 p-2">
          <AskNelsonChat conversationId={conversationId} setConversationId={setConversationId} compact />
        </div>
      </div>
    </>
  );
}
