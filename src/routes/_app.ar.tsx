import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Mail, AlertOctagon, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { syncArAging } from "@/server/p21.functions";

export const Route = createFileRoute("/_app/ar")({ component: ArPage });

const BUCKETS = [
  { key: "current", label: "Current" },
  { key: "1_30", label: "1–30 days" },
  { key: "31_60", label: "31–60 days" },
  { key: "61_90", label: "61–90 days" },
  { key: "90_plus", label: "90+ days" },
];

function ArPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<any[]>([]);
  const [bucket, setBucket] = useState<string>("all");
  const [automation, setAutomation] = useState(true);
  const [template, setTemplate] = useState("");

  async function load() {
    const { data } = await supabase.from("ar_aging").select("*").order("days_past_due", { ascending: false });
    setRows(data ?? []);
    const { data: settings } = await supabase.from("app_settings").select("*").in("key", ["ar_automation_enabled", "ar_reminder_template"]);
    settings?.forEach((s: any) => {
      if (s.key === "ar_automation_enabled") setAutomation(!!s.value);
      if (s.key === "ar_reminder_template") setTemplate(typeof s.value === "string" ? s.value : JSON.stringify(s.value));
    });
  }
  useEffect(() => { load(); }, []);

  const filtered = bucket === "all" ? rows : rows.filter((r) => r.bucket === bucket);
  const totals = BUCKETS.map((b) => ({ ...b, total: rows.filter((r) => r.bucket === b.key).reduce((a, r) => a + Number(r.amount_due), 0), count: rows.filter((r) => r.bucket === b.key).length }));

  async function sendReminder(r: any) {
    try {
      const { data, error } = await supabase.functions.invoke("generate-collection-email", {
        body: { template, customer_name: r.customer_name, invoice: r.invoice_number, amount: r.amount_due, days: r.days_past_due },
      });
      if (error) throw error;
      await supabase.from("collection_emails").insert({ ar_aging_id: r.id, content: data.content, sent_by: user?.id, automated: false });
      await supabase.from("ar_aging").update({ collection_status: "auto_reminder_sent", last_contacted_at: new Date().toISOString() }).eq("id", r.id);
      await supabase.from("activity_events").insert({ event_type: "ar.reminder_sent", actor_id: user?.id, actor_name: user?.email ?? "system", message: `Reminder sent to ${r.customer_name} (${r.invoice_number})` });
      toast.success(`Reminder sent to ${r.customer_name}`);
      load();
    } catch (e: any) { toast.error(e.message ?? "Failed"); }
  }

  async function toggleAutomation(v: boolean) {
    setAutomation(v);
    await supabase.from("app_settings").update({ value: v as any, updated_at: new Date().toISOString() }).eq("key", "ar_automation_enabled");
  }

  async function saveTemplate() {
    await supabase.from("app_settings").update({ value: template as any, updated_at: new Date().toISOString() }).eq("key", "ar_reminder_template");
    toast.success("Template saved");
  }

  return (
    <div>
      <ModuleHeader title="AR & Collections" description="Aging buckets, automated reminders for 31–60 day accounts, manual escalation for 60+."
        actions={
          <Button variant="outline" onClick={syncFromP21} disabled={syncing}>
            {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Sync from P21
          </Button>
        } />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {totals.map((b) => (
          <Card key={b.key} className="p-4">
            <p className="text-xs text-muted-foreground uppercase">{b.label}</p>
            <p className="text-xl font-bold mt-1">${b.total.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">{b.count} accounts</p>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="accounts">
        <TabsList>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="template">Reminder Template</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          <Card className="p-4 mb-4 flex items-center justify-between">
            <div>
              <p className="font-semibold text-sm">Automation: 31–60 day reminders</p>
              <p className="text-xs text-muted-foreground">When on, the system sends one AI-personalized reminder per account in this bucket.</p>
            </div>
            <Switch checked={automation} onCheckedChange={toggleAutomation} />
          </Card>

          <Card>
            <div className="p-3 flex flex-wrap gap-2 border-b">
              <Button size="sm" variant={bucket === "all" ? "default" : "outline"} onClick={() => setBucket("all")}>All</Button>
              {BUCKETS.map((b) => (
                <Button key={b.key} size="sm" variant={bucket === b.key ? "default" : "outline"} onClick={() => setBucket(b.key)}>{b.label}</Button>
              ))}
            </div>
            <Table>
              <TableHeader>
                <TableRow><TableHead>Customer</TableHead><TableHead>Invoice</TableHead><TableHead>Amount</TableHead><TableHead>Days</TableHead><TableHead>Status</TableHead><TableHead></TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.customer_name}</TableCell>
                    <TableCell>{r.invoice_number}</TableCell>
                    <TableCell>${Number(r.amount_due).toLocaleString()}</TableCell>
                    <TableCell>{r.days_past_due > 0 ? <Badge variant={r.days_past_due > 60 ? "destructive" : "secondary"}>{r.days_past_due}d</Badge> : "—"}</TableCell>
                    <TableCell><Badge variant="outline">{r.collection_status ?? "none"}</Badge></TableCell>
                    <TableCell className="text-right">
                      {r.days_past_due >= 30 && (
                        <Button size="sm" variant={r.days_past_due >= 60 ? "destructive" : "default"} onClick={() => sendReminder(r)}>
                          {r.days_past_due >= 60 ? <><AlertOctagon className="w-3 h-3 mr-1" /> Escalate</> : <><Mail className="w-3 h-3 mr-1" /> Send Reminder</>}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="template">
          <Card className="p-4 space-y-3">
            <p className="text-sm text-muted-foreground">Tokens: <code>{`{{customer_name}}`}</code> <code>{`{{invoice}}`}</code> <code>{`{{amount}}`}</code> <code>{`{{days}}`}</code></p>
            <Textarea rows={10} value={template} onChange={(e) => setTemplate(e.target.value)} />
            <Button onClick={saveTemplate}>Save template</Button>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
