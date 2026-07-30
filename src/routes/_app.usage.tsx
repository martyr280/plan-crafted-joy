import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/shared/KpiCard";
import { Users, LogIn, Activity, Layers, AlertTriangle, ArrowUp, ArrowDown } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { useModuleView, formatCentral } from "@/lib/usage-log";
import { useUsageEvents, useUsageOverview } from "@/hooks/useUsageLog";

export const Route = createFileRoute("/_app/usage")({
  component: UsagePage,
  head: () => ({
    meta: [
      { title: "Usage Log · Nelson AI" },
      { name: "description", content: "Admin view of Nelson AI logins, module usage and feature activity per user." },
      { property: "og:title", content: "Usage Log · Nelson AI" },
      { property: "og:description", content: "Admin view of Nelson AI logins, module usage and feature activity per user." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type SortKey = "name" | "last_login" | "logins_30d" | "modules" | "last_activity";

function UsagePage() {
  const { hasRole } = useAuth();
  useModuleView("usage_log");
  const isAdmin = hasRole("admin");

  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const range = useMemo(() => ({ from, to: `${to}T23:59:59.999Z` }), [from, to]);

  const overview = useUsageOverview(range);
  const [sortKey, setSortKey] = useState<SortKey>("last_activity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState<string>("all");
  const [eventType, setEventType] = useState<string>("all");
  const [module, setModule] = useState<string>("all");

  const events = useUsageEvents({
    page,
    pageSize: 50,
    userId: userId === "all" ? undefined : userId,
    eventType: eventType === "all" ? undefined : (eventType as any),
    module: module === "all" ? undefined : module,
    from: range.from,
    to: range.to,
  });

  if (!isAdmin) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        The Usage Log is available to administrators only.
      </Card>
    );
  }

  const users = overview.data?.byUser ?? [];
  const sorted = [...users].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    switch (sortKey) {
      case "name":
        return dir * (a.display_name ?? a.email ?? "").localeCompare(b.display_name ?? b.email ?? "");
      case "logins_30d":
        return dir * (a.logins_30d - b.logins_30d);
      case "modules":
        return dir * (a.modules_30d.length - b.modules_30d.length);
      case "last_login":
        return dir * ((a.last_login ?? "").localeCompare(b.last_login ?? ""));
      default:
        return dir * ((a.last_activity ?? "").localeCompare(b.last_activity ?? ""));
    }
  });

  function sortBtn(key: SortKey, label: string) {
    const active = sortKey === key;
    return (
      <button
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => {
          if (active) setSortDir(sortDir === "asc" ? "desc" : "asc");
          else {
            setSortKey(key);
            setSortDir("desc");
          }
        }}
      >
        {label}
        {active && (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    );
  }

  const totalPages = Math.max(1, Math.ceil((events.data?.total ?? 0) / 50));
  const s = overview.data?.summary;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usage Log</h1>
        <p className="text-sm text-muted-foreground">
          Logins, module views and key feature actions per user. All times shown in US Central.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard label="Active today" value={s?.active_today ?? "—"} icon={<Users className="w-5 h-5" />} />
        <KpiCard label="Active last 7 days" value={s?.active_7d ?? "—"} icon={<Activity className="w-5 h-5" />} />
        <KpiCard label="Active last 30 days" value={s?.active_30d ?? "—"} icon={<Activity className="w-5 h-5" />} />
        <KpiCard label="Logins last 7 days" value={s?.logins_7d ?? "—"} icon={<LogIn className="w-5 h-5" />} />
        <KpiCard
          label="Top module (7d)"
          value={s?.top_module_7d?.module ?? "—"}
          sub={s?.top_module_7d ? `${s.top_module_7d.count} views` : undefined}
          icon={<Layers className="w-5 h-5" />}
        />
      </div>

      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">From</label>
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-40" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">To</label>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-40" />
        </div>
        {!!s?.inactive_users && (
          <Badge variant="outline" className="ml-auto gap-1 text-destructive border-destructive/40">
            <AlertTriangle className="w-3 h-3" /> {s.inactive_users} inactive / never logged in
          </Badge>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="font-semibold mb-3">Usage by user</h2>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="text-muted-foreground">
                <TableHead>{sortBtn("name", "User")}</TableHead>
                <TableHead>{sortBtn("last_login", "Last login")}</TableHead>
                <TableHead className="text-right">{sortBtn("logins_30d", "Logins 30d")}</TableHead>
                <TableHead>{sortBtn("modules", "Modules used 30d")}</TableHead>
                <TableHead>{sortBtn("last_activity", "Last activity")}</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.isLoading && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Loading…</TableCell></TableRow>
              )}
              {sorted.map((u) => (
                <TableRow key={u.user_id}>
                  <TableCell>
                    <div className="font-medium">{u.display_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{u.email ?? "—"}</div>
                  </TableCell>
                  <TableCell className="text-sm">{formatCentral(u.last_login)}</TableCell>
                  <TableCell className="text-right text-sm">{u.logins_30d}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-md">
                      {u.modules_30d.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                      {u.modules_30d.map((m) => (
                        <Badge key={m} variant="secondary" className="text-[11px]">{m}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{formatCentral(u.last_activity)}</TableCell>
                  <TableCell>
                    {u.never_logged_in ? (
                      <Badge variant="destructive">Never logged in</Badge>
                    ) : u.inactive ? (
                      <Badge variant="outline" className="text-destructive border-destructive/40">Inactive 14d+</Badge>
                    ) : (
                      <Badge variant="secondary">Active</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!overview.isLoading && sorted.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No users found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h2 className="font-semibold">Event log</h2>
          <div className="ml-auto flex flex-wrap gap-2">
            <Select value={userId} onValueChange={(v) => { setUserId(v); setPage(1); }}>
              <SelectTrigger className="w-52"><SelectValue placeholder="User" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All users</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.user_id} value={u.user_id}>{u.display_name ?? u.email ?? u.user_id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={eventType} onValueChange={(v) => { setEventType(v); setPage(1); }}>
              <SelectTrigger className="w-40"><SelectValue placeholder="Event type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All events</SelectItem>
                <SelectItem value="login">login</SelectItem>
                <SelectItem value="module_view">module_view</SelectItem>
                <SelectItem value="feature_action">feature_action</SelectItem>
              </SelectContent>
            </Select>
            <Select value={module} onValueChange={(v) => { setModule(v); setPage(1); }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Module" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {(overview.data?.modules ?? []).map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="text-muted-foreground">
                <TableHead>Timestamp (CT)</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.isLoading && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">Loading…</TableCell></TableRow>
              )}
              {(events.data?.rows ?? []).map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm whitespace-nowrap">{formatCentral(r.created_at)}</TableCell>
                  <TableCell className="text-sm">{r.display_name ?? r.email ?? r.user_id}</TableCell>
                  <TableCell><Badge variant="secondary" className="text-[11px]">{r.event_type}</Badge></TableCell>
                  <TableCell className="text-sm">{r.module}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.action ?? "—"}</TableCell>
                </TableRow>
              ))}
              {!events.isLoading && (events.data?.rows ?? []).length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No events match these filters.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between pt-3 text-sm text-muted-foreground">
          <span>{events.data?.total ?? 0} events · page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
