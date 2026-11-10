import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** Query failure for a dispatch run. Hides pallet totals until retry succeeds. */
export function RunDetailAlert({
  message,
  stale,
  onRetry,
}: {
  message: string;
  stale: boolean;
  onRetry: () => void;
}) {
  return (
    <Card
      className="p-3 border-destructive/40 bg-destructive/5 text-sm text-destructive space-y-2"
      role="alert"
      data-testid="dispatch-run-error"
    >
      <p>Could not load this run: {message}</p>
      {stale ? <p>The previous load is hidden so a stale pallet total is not shown.</p> : null}
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </Card>
  );
}

/** Query failure for the dispatch runs list. Hides KPIs and row actions until retry succeeds. */
export function DispatchListAlert({
  message,
  stale,
  onRetry,
}: {
  message: string;
  stale: boolean;
  onRetry: () => void;
}) {
  return (
    <Card
      className="p-3 mb-4 border-destructive/40 bg-destructive/5 text-sm text-destructive space-y-2"
      role="alert"
      data-testid="dispatch-runs-error"
    >
      <p>Could not load dispatch runs: {message}</p>
      {stale ? (
        <p>The previous list is hidden so stale routes and pallet totals are not shown.</p>
      ) : (
        <p>Route counts are unavailable. Zero is not a successful empty board.</p>
      )}
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </Card>
  );
}
