import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from "recharts";
import { RefreshCw, AlertTriangle, Mail, CheckCircle2, Info } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { getEmailMonitorStats } from "@/lib/email-monitor.functions";

export const Route = createFileRoute("/_app/email-monitor")({
  component: EmailMonitorPage,
  errorComponent: ErrEC,
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

function ErrEC({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="p-6">
      <Card className="p-6 border-destructive/40 bg-destructive/5">
        <h2 className="font-semibold mb-2">Could not load Email Monitor</h2>
        <pre className="text-xs whitespace-pre-wrap text-destructive mb-4">{error?.message ?? "Unknown"}</pre>
        <Button variant="outline" onClick={() => { router.invalidate(); reset(); }}>Retry</Button>
      </Card>
    </div>
  );
}

function fmtBytes(n: number) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function safeRelative(d: any): string {
  if (!d) return "—";
  const t = new Date(d);
  if (isNaN(t.getTime())) return "—";
  try { return formatDistanceToNow(t, { addSuffix: true }); } catch { return "—"; }
}

function EmailMonitorPage() {
  const fn = useServerFn(getEmailMonitorStats);
  const [days, setDays] = useState(30);
  const [ordersOnly, setOrdersOnly] = useState(true);

  const q = useQuery({
    queryKey: ["email-monitor", days, ordersOnly],
    queryFn: () => fn({ data: { days, ordersOnly } }),
  });

  useEffect(() => { q.refetch(); }, [days, ordersOnly]);

  const stats = q.data;
  const series = stats?.series ?? [];
  const totals = stats?.totals ?? { delivered: 0, errors: 0, dismissed: 0, total: 0, attachments: 0, attachmentBytes: 0 };
  const issues = stats?.issues ?? [];
  const reasons = stats?.reasons ?? [];

  return (
    <div>
      <ModuleHeader
        title="Email Delivery Monitor"
        description="Inbound email delivery and processing failures for orders. Track bounce reasons including oversized-mail rejections over time."
        actions={<Button variant="outline" onClick={() => q.refetch()}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>}
      />

      <Card className="p-4 mb-4 bg-muted/30 border-muted flex gap-3">
        <Info className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
        <p className="text-sm text-muted-foreground">
          This view reflects emails that reached the app. Oversized messages rejected by Resend's inbound SMTP edge
          (<code>552 5.3.4 Message is too long</code>) are bounced to the <em>sender</em> before reaching us, so they
          do not appear as rows here. They show up only when the sender forwards a bounce notice into the inbox —
          those land under <strong>Errors / Dismissed</strong> with reason <strong>Oversized message</strong>.
        </p>
      </Card>

      <div className="flex flex-wrap gap-4 items-end mb-4">
        <div>
          <Label className="text-xs text-muted-foreground">Range</Label>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="60">Last 60 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="oo" checked={ordersOnly} onCheckedChange={setOrdersOnly} />
          <Label htmlFor="oo" className="text-sm">Orders only</Label>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs"><Mail className="w-3 h-3" /> Total received</div>
          <div className="text-2xl font-semibold mt-1">{totals.total}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-success text-xs"><CheckCircle2 className="w-3 h-3" /> Delivered</div>
          <div className="text-2xl font-semibold mt-1">{totals.delivered}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-destructive text-xs"><AlertTriangle className="w-3 h-3" /> Errors / bounces</div>
          <div className="text-2xl font-semibold mt-1">{totals.errors + totals.dismissed}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{totals.errors} error · {totals.dismissed} dismissed</div>
        </Card>
        <Card className="p-4">
          <div className="text-muted-foreground text-xs">Attachments</div>
          <div className="text-2xl font-semibold mt-1">{totals.attachments}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{fmtBytes(totals.attachmentBytes)} total</div>
        </Card>
      </div>

      <Card className="p-4 mb-4">
        <div className="text-sm font-semibold mb-3">Delivery over time</div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" tickFormatter={(d) => { try { return format(new Date(d), "MMM d"); } catch { return d; } }} fontSize={11} />
              <YAxis fontSize={11} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="delivered" stackId="a" fill="hsl(var(--success))" name="Delivered" />
              <Bar dataKey="errors" stackId="a" fill="hsl(var(--destructive))" name="Errors" />
              <Bar dataKey="dismissed" stackId="a" fill="hsl(var(--muted-foreground))" name="Dismissed" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid md:grid-cols-3 gap-4 mb-4">
        <Card className="p-4 md:col-span-1">
          <div className="text-sm font-semibold mb-3">Bounce / error reasons</div>
          {reasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bounces or errors in this range. 🎉</p>
          ) : (
            <ul className="space-y-2">
              {reasons.map((r) => (
                <li key={r.reason} className="flex items-center justify-between text-sm">
                  <span>{r.reason}</span>
                  <Badge variant="secondary">{r.count}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="md:col-span-2">
          <div className="p-4 text-sm font-semibold border-b">Recent bounce / error events</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">
                    No bounce or error events in range.
                  </TableCell>
                </TableRow>
              )}
              {issues.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{safeRelative(i.received_at)}</TableCell>
                  <TableCell className="text-xs max-w-[160px] truncate">{i.from_addr}</TableCell>
                  <TableCell className="text-xs max-w-[160px] truncate">{i.to_addr ?? "—"}</TableCell>
                  <TableCell><Badge variant={i.reason === "Oversized message" ? "destructive" : "outline"}>{i.reason}</Badge></TableCell>
                  <TableCell className="text-xs max-w-md truncate" title={i.error ?? i.subject ?? ""}>{i.error ?? i.subject ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
