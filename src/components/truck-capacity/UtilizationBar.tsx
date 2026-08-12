// Horizontal utilization bar, 0–125%, with 30% / 90% reference marks.
// Colors follow the existing flag thresholds: >=90% at capacity (red),
// <=30% consolidation candidate (amber), otherwise healthy (emerald).

const MAX = 1.25;

export function utilizationTone(value: number | null | undefined): "red" | "amber" | "green" | "muted" {
  if (value == null) return "muted";
  if (value >= 0.9) return "red";
  if (value <= 0.3) return "amber";
  return "green";
}

const FILL: Record<string, string> = {
  red: "bg-destructive",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  muted: "bg-muted-foreground/30",
};

export function UtilizationBar({
  value,
  secondary,
  className = "",
}: {
  /** Served / final utilization (0..1.25). */
  value: number | null | undefined;
  /** Optional overlay marker, e.g. P21 demand already booked. */
  secondary?: number | null;
  className?: string;
}) {
  const tone = utilizationTone(value);
  const width = value == null ? 0 : Math.min(100, Math.max(0, (value / MAX) * 100));
  const secWidth = secondary == null ? null : Math.min(100, Math.max(0, (secondary / MAX) * 100));

  return (
    <div className={`relative h-4 w-full min-w-[120px] rounded-sm bg-muted ${className}`} title={
      value == null ? "No forecast" : `Final ${(value * 100).toFixed(0)}%${secondary != null ? ` · P21 ${(secondary * 100).toFixed(0)}%` : ""}`
    }>
      <div className={`absolute inset-y-0 left-0 rounded-sm ${FILL[tone]}`} style={{ width: `${width}%` }} />
      {secWidth != null && (
        <div
          className="absolute inset-y-0 w-[2px] bg-foreground/70"
          style={{ left: `${secWidth}%` }}
          aria-label="P21 demand on the books"
        />
      )}
      {/* reference marks */}
      <div className="absolute inset-y-0 w-px bg-amber-600/60" style={{ left: `${(0.3 / MAX) * 100}%` }} />
      <div className="absolute inset-y-0 w-px bg-destructive/70" style={{ left: `${(0.9 / MAX) * 100}%` }} />
      {value != null && (
        <span className="absolute inset-0 flex items-center justify-end pr-1 text-[10px] font-medium text-foreground/80">
          {(value * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}
