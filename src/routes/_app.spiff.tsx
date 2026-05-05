import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Play, Download } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_app/spiff")({ component: SpiffPage });

function SpiffPage() {
  const { user } = useAuth();
  const [calcs, setCalcs] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [quarter, setQuarter] = useState("Q2-2026");

  async function load() {
    const { data: c } = await supabase.from("spiff_calculations").select("*").eq("quarter", quarter);
    const { data: r } = await supabase.from("spiff_rules").select("*").order("customer_name");
    setCalcs(c ?? []); setRules(r ?? []);
  }
  useEffect(() => { load(); }, [quarter]);

  async function runCalc() {
    const newRows = rules.filter((r) => r.active).map((r) => ({
      quarter, customer_id: r.customer_id, customer_name: r.customer_name,
      sales_rep: r.sales_rep_split ? `REP-10${(r.customer_id.charCodeAt(2) % 3) + 1}` : null,
      gross_sales: Math.round(20000 + Math.random() * 100000),
      spiff_amount: 0, status: "draft",
    })).map((row) => {
      const rule = rules.find((rr) => rr.customer_id === row.customer_id);
      const amt = rule.rate_type === "percent" ? row.gross_sales * (Number(rule.rate_value) / 100) : Number(rule.rate_value);
      return { ...row, spiff_amount: Math.round(amt) };
    });
    await supabase.from("spiff_calculations").delete().eq("quarter", quarter).eq("status", "draft");
    if (newRows.length) await supabase.from("spiff_calculations").insert(newRows);
    await supabase.from("activity_events").insert({ event_type: "spiff.calculated", actor_id: user?.id, actor_name: user?.email, message: `${quarter} SPIFF calculation run` });
    toast.success("Calculation complete"); load();
  }

  async function approve(id: string) {
    await supabase.from("spiff_calculations").update({ status: "approved", approved_by: user?.id, approved_at: new Date().toISOString() }).eq("id", id);
    load();
  }

  function exportCsv() {
    const csv = ["Quarter,Customer,Rep,Gross,SPIFF,Status", ...calcs.map((c) => `${c.quarter},${c.customer_name},${c.sales_rep ?? ""},${c.gross_sales},${c.spiff_amount},${c.status}`)].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `spiff-${quarter}.csv`; a.click();
  }

  return (
    <div>
      <ModuleHeader title="SPIFF Management" description="Codified rules, automated calculations, approval workflow."
        actions={<>
          <select className="border rounded-md px-3 py-1.5 text-sm bg-card" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
            <option>Q1-2026</option><option>Q2-2026</option><option>Q3-2026</option><option>Q4-2026</option>
          </select>
          <Button onClick={runCalc}><Play className="w-4 h-4 mr-2" /> Run Calculation</Button>
          <Button variant="outline" onClick={exportCsv}><Download className="w-4 h-4 mr-2" /> Export</Button>
        </>}
      />

      <Tabs defaultValue="calc">
        <TabsList><TabsTrigger value="calc">Calculations</TabsTrigger><TabsTrigger value="rules">Rules</TabsTrigger></TabsList>
        <TabsContent value="calc">
          <Card><Table>
            <TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Rep</TableHead><TableHead>Gross</TableHead><TableHead>SPIFF</TableHead><TableHead>Status</TableHead><TableHead></TableHead></TableRow></TableHeader>
            <TableBody>{calcs.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.customer_name}</TableCell><TableCell>{c.sales_rep ?? "—"}</TableCell>
                <TableCell>${Number(c.gross_sales).toLocaleString()}</TableCell>
                <TableCell className="font-bold">${Number(c.spiff_amount).toLocaleString()}</TableCell>
                <TableCell><Badge variant={c.status === "approved" ? "default" : "secondary"}>{c.status}</Badge></TableCell>
                <TableCell>{c.status !== "approved" && <Button size="sm" onClick={() => approve(c.id)}>Approve</Button>}</TableCell>
              </TableRow>))}</TableBody>
          </Table></Card>
        </TabsContent>
        <TabsContent value="rules">
          <Card><Table>
            <TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>SKU filter</TableHead><TableHead>Rate</TableHead><TableHead>Split</TableHead><TableHead>Active</TableHead></TableRow></TableHeader>
            <TableBody>{rules.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.customer_name}</TableCell><TableCell>{r.sku_filter ?? "All"}</TableCell>
                <TableCell>{r.rate_type === "percent" ? `${r.rate_value}%` : `$${r.rate_value}`}</TableCell>
                <TableCell>{r.sales_rep_split ? "Yes" : "No"}</TableCell>
                <TableCell>{r.active ? <Badge>Active</Badge> : <Badge variant="outline">Off</Badge>}</TableCell>
              </TableRow>))}</TableBody>
          </Table></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
