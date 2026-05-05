import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Play, Plus } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_app/reports")({ component: ReportsPage });

function ReportsPage() {
  const { user } = useAuth();
  const [schedules, setSchedules] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);

  async function load() {
    const { data: s } = await supabase.from("report_schedules").select("*").order("name");
    const { data: r } = await supabase.from("report_runs").select("*").order("started_at", { ascending: false }).limit(30);
    setSchedules(s ?? []); setRuns(r ?? []);
  }
  useEffect(() => { load(); }, []);

  async function runNow(s: any) {
    const startedAt = new Date().toISOString();
    const { data: run } = await supabase.from("report_runs").insert({ schedule_id: s.id, started_at: startedAt, status: "running" }).select().single();
    setTimeout(async () => {
      await supabase.from("report_runs").update({ completed_at: new Date().toISOString(), status: "success", recipients_count: (s.recipients as any[]).length, notes: "Generated (stub)" }).eq("id", run!.id);
      await supabase.from("report_schedules").update({ last_run_at: new Date().toISOString(), last_status: "success" }).eq("id", s.id);
      await supabase.from("activity_events").insert({ event_type: "report.generated", actor_id: user?.id, actor_name: user?.email, message: `${s.name} generated` });
      toast.success(`${s.name} generated`); load();
    }, 800);
  }

  return (
    <div>
      <ModuleHeader title="Reports" description="Scheduled report generation and delivery."
        actions={<Button><Plus className="w-4 h-4 mr-2" /> New Report</Button>} />

      <Card className="mb-6"><Table>
        <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Schedule</TableHead><TableHead>Recipients</TableHead><TableHead>Last Run</TableHead><TableHead>Status</TableHead><TableHead></TableHead></TableRow></TableHeader>
        <TableBody>{schedules.map((s) => (
          <TableRow key={s.id}>
            <TableCell className="font-medium">{s.name}</TableCell>
            <TableCell><Badge variant="secondary">{s.type}</Badge></TableCell>
            <TableCell><code className="text-xs">{s.schedule_cron}</code></TableCell>
            <TableCell>{(s.recipients as any[]).length}</TableCell>
            <TableCell>{s.last_run_at ? formatDistanceToNow(new Date(s.last_run_at), { addSuffix: true }) : "Never"}</TableCell>
            <TableCell>{s.last_status ? <Badge variant={s.last_status === "success" ? "default" : "destructive"}>{s.last_status}</Badge> : "—"}</TableCell>
            <TableCell><Button size="sm" variant="outline" onClick={() => runNow(s)}><Play className="w-3 h-3 mr-1" /> Run Now</Button></TableCell>
          </TableRow>))}</TableBody>
      </Table></Card>

      <Card>
        <div className="p-4 font-semibold border-b">Recent runs</div>
        <Table><TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Status</TableHead><TableHead>Recipients</TableHead><TableHead>Notes</TableHead></TableRow></TableHeader>
          <TableBody>{runs.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{formatDistanceToNow(new Date(r.started_at), { addSuffix: true })}</TableCell>
              <TableCell><Badge variant={r.status === "success" ? "default" : r.status === "running" ? "secondary" : "destructive"}>{r.status}</Badge></TableCell>
              <TableCell>{r.recipients_count}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{r.notes ?? "—"}</TableCell>
            </TableRow>))}</TableBody>
        </Table>
      </Card>
    </div>
  );
}
