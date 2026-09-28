import { Card } from "@/components/ui/card";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

export function KpiCard({
  label, value, sub, icon, trend, onClick,
}: { label: string; value: ReactNode; sub?: string; icon: ReactNode; trend?: number; onClick?: () => void }) {
  const clickable = !!onClick;
  return (
    <Card
      className={`p-5 ${clickable ? "cursor-pointer transition-colors hover:bg-accent/50 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : ""}`}
      {...(clickable
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `Show details for ${label}`,
            onClick,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick!(); }
            },
          }
        : {})}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-3xl font-bold mt-1">{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          {typeof trend === "number" && (
            <div className={`text-xs mt-2 inline-flex items-center gap-1 ${trend >= 0 ? "text-success" : "text-destructive"}`}>
              {trend >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              {Math.abs(trend).toFixed(1)}% vs last week
            </div>
          )}
        </div>
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">{icon}</div>
      </div>
    </Card>
  );
}
