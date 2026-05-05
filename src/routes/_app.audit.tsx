import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import { CalendarIcon, Download, RefreshCw, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/audit")({ component: AuditPage });

type Event = {
  id: string;
  created_at: string;
  event_type: string;
  message: string;
  actor_id: string | null;
  actor_name: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: any;
};

const MODULES: { value: string; label: string; matches: (e: Event) => boolean }[] = [
  { value: "all", label: "All modules", matches: () => true },
  { value: "orders", label: "Orders", matches: (e) => /^order/.test(e.event_type) || e.entity_type === "order" || e.entity_type === "orders" },
  { value: "ar", label: "AR & Collections", matches: (e) => /collection|ar_/.test(e.event_type) || e.entity_type === "ar_aging" },
  { value: "logistics", label: "Logistics", matches: (e) => /load|fleet|damage/.test(e.event_type) || e.entity_type === "fleet_loads" || e.entity_type === "damage_reports" },
  { value: "spiff", label: "SPIFF", matches: (e) => /spiff/.test(e.event_type) },
  { value: "reports", label: "Reports", matches: (e) => /report/.test(e.event_type) },
  { value: "auth", label: "Auth & Roles", matches: (e) => /role|user|auth/.test(e.event_type) },
];

const RANGES = [
  { value: "1", label: "Last 24 hours", days: 1 },
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "custom", label: "Custom range", days: 0 },
];

function AuditPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [actors, setActors] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [module, setModule] = useState("all");
  const [actor, setActor] = useState("all");
  const [range, setRange] = useState("7");
  const [from, setFrom] = useState<Date | undefined>(subDays(new Date(), 7));
  const [to, setTo] = useState<Date | undefined>(new Date());

  function applyRange(v: string) {
    setRange(v);
    if (v === "custom") return;
    const days = RANGES.find((r) => r.value === v)?.days ?? 7;
    setFrom(subDays(new Date(), days));
    setTo(new Date());
  }

  async function load() {
    setLoading(true);
    let query = supabase.from("activity_events").select("*").order("created_at", { ascending: false }).limit(500);
    if (from) query = query.gte("created_at", startOfDay(from).toISOString());
    if (to) query = query.lte("created_at", endOfDay(to).toISOString());
    if (actor !== "all") query = query.eq("actor_id", actor);
    const { data } = await query;
    setEvents((data ?? []) as Event[]);
    setLoading(false);
  }

  useEffect(() => {
    supabase.from("profiles").select("id,email,display_name").then(({ data }) => {
      setActors((data ?? []).map((p: any) => ({ id: p.id, label: p.display_name || p.email || p.id })));
    });
  }, []);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [from, to, actor]);

  const filtered = useMemo(() => {
    const mod = MODULES.find((m) => m.value === module)!;
    const needle = q.trim().toLowerCase();
    return events.filter((e) => {
      if (!mod.matches(e)) return false;
      if (!needle) return true;
      return (
        e.message?.toLowerCase().includes(needle) ||
        e.event_type?.toLowerCase().includes(needle) ||
        e.actor_name?.toLowerCase().includes(needle) ||
        e.entity_id?.toLowerCase().includes(needle)
      );
    });
  }, [events, module, q]);

  function exportCsv() {
    const header = ["timestamp", "actor", "module", "event_type", "entity_type", "entity_id", "message"];
    const moduleOf = (e: Event) => MODULES.find((m) => m.value !== "all" && m.matches(e))?.label ?? "Other";
    const rows = filtered.map((e) => [
      e.created_at, e.actor_name ?? "", moduleOf(e), e.event_type, e.entity_type ?? "", e.entity_id ?? "", e.message,
    ].map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `audit-${format(new Date(), "yyyyMMdd-HHmm")}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <ModuleHeader
        title="Audit Log"
        description="Every recorded system action with who, what, and when."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length}>
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
          </>
        }
      />

      <Card className="p-4 mb-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2 relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search message, event, entity…" className="pl-8" />
          </div>
          <Select value={module} onValueChange={setModule}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{MODULES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={actor} onValueChange={setActor}>
            <SelectTrigger><SelectValue placeholder="Actor" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              {actors.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={range} onValueChange={applyRange}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {range === "custom" && (
          <div className="flex flex-wrap gap-2 mt-3">
            <DateBtn label="From" value={from} onChange={setFrom} />
            <DateBtn label="To" value={to} onChange={setTo} />
          </div>
        )}
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[170px]">Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Module</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Entity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((e) => {
              const mod = MODULES.find((m) => m.value !== "all" && m.matches(e));
              return (
                <TableRow key={e.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{format(new Date(e.created_at), "MMM d, HH:mm:ss")}</TableCell>
                  <TableCell className="text-sm">{e.actor_name ?? <span className="text-muted-foreground">system</span>}</TableCell>
                  <TableCell><Badge variant="outline">{mod?.label ?? "Other"}</Badge></TableCell>
                  <TableCell><code className="text-xs">{e.event_type}</code></TableCell>
                  <TableCell className="text-sm">{e.message}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{e.entity_type ? `${e.entity_type}${e.entity_id ? ` · ${e.entity_id}` : ""}` : "—"}</TableCell>
                </TableRow>
              );
            })}
            {!filtered.length && (
              <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-10">
                {loading ? "Loading…" : "No events match these filters."}
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        <div className="p-3 text-xs text-muted-foreground border-t">Showing {filtered.length} of {events.length} loaded events (max 500 per query).</div>
      </Card>
    </div>
  );
}

function DateBtn({ label, value, onChange }: { label: string; value?: Date; onChange: (d?: Date) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("justify-start", !value && "text-muted-foreground")}>
          <CalendarIcon className="w-4 h-4 mr-2" />{label}: {value ? format(value, "PPP") : "pick"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={value} onSelect={onChange} initialFocus className="p-3 pointer-events-auto" />
      </PopoverContent>
    </Popover>
  );
}
