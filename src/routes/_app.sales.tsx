import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Download } from "lucide-react";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_app/sales")({ component: SalesPage });

function seedRandom(seed: number) { return () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }; }

function SalesPage() {
  const { user, hasRole } = useAuth();
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("daily");
  const [rep, setRep] = useState<string>("ALL");
  const [profile, setProfile] = useState<any>(null);

  useEffect(() => {
    if (user) supabase.from("profiles").select("*").eq("id", user.id).single().then(({ data }) => setProfile(data));
  }, [user]);

  const isSalesRepOnly = hasRole("sales_rep") && !hasRole("admin");
  const effectiveRep = isSalesRepOnly ? (profile?.sales_rep_code ?? "REP-101") : rep;

  const { trend, kpi, top, products } = useMemo(() => {
    const days = period === "daily" ? 14 : period === "weekly" ? 12 : 12;
    const rng = seedRandom(effectiveRep === "ALL" ? 42 : effectiveRep.charCodeAt(4));
    const trend = Array.from({ length: days }).map((_, i) => ({ label: `${period === "monthly" ? "M" : period === "weekly" ? "W" : "D"}-${i + 1}`, net: Math.round(8000 + rng() * 12000) }));
    const total = trend.reduce((a, t) => a + t.net, 0);
    const kpi = { net: total, orders: Math.round(20 + rng() * 80), newCust: Math.round(2 + rng() * 8), returns: Math.round(rng() * 5000) };
    const top = ["Apex Architects", "Blueprint Interiors", "Delta Office Supply", "Echo Workspace", "Granite Group"].map((n) => ({ name: n, orders: Math.round(2 + rng() * 12), net: Math.round(5000 + rng() * 30000), pct: Math.round((rng() - 0.5) * 30) }));
    const products = ["NDI-CHR-AER-B", "NDI-DSK-PIR", "NDI-CHR-LEAP", "NDI-FILE-ABDA", "NDI-BLK-4421"].map((s) => ({ sku: s, units: Math.round(rng() * 80), revenue: Math.round(2000 + rng() * 15000) }));
    return { trend, kpi, top, products };
  }, [period, effectiveRep]);

  function exportCsv() {
    const csv = ["Customer,Orders,Net,Pct vs prior", ...top.map((t) => `${t.name},${t.orders},${t.net},${t.pct}`)].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "sales.csv"; a.click();
  }

  return (
    <div>
      <ModuleHeader title="Sales Dashboard" description={`Source-of-truth view from P21 — net sales include returns. ${isSalesRepOnly ? "Showing your data only." : ""}`}
        actions={<Button variant="outline" onClick={exportCsv}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>} />

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Tabs value={period} onValueChange={(v) => setPeriod(v as any)}>
          <TabsList><TabsTrigger value="daily">Daily</TabsTrigger><TabsTrigger value="weekly">Weekly</TabsTrigger><TabsTrigger value="monthly">Monthly</TabsTrigger></TabsList>
        </Tabs>
        {!isSalesRepOnly && (
          <select className="border rounded-md px-3 py-1 text-sm bg-card" value={rep} onChange={(e) => setRep(e.target.value)}>
            <option value="ALL">All reps</option><option value="REP-101">REP-101</option><option value="REP-102">REP-102</option><option value="REP-103">REP-103</option>
          </select>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Net Sales</p><p className="text-2xl font-bold">${kpi.net.toLocaleString()}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Orders</p><p className="text-2xl font-bold">{kpi.orders}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">New Customers</p><p className="text-2xl font-bold">{kpi.newCust}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Return Credits</p><p className="text-2xl font-bold">${kpi.returns.toLocaleString()}</p></Card>
      </div>

      <Card className="p-4 mb-6">
        <p className="font-semibold text-sm mb-4">Net sales trend</p>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={trend}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="label" /><YAxis /><Tooltip />
            <Line type="monotone" dataKey="net" stroke="oklch(0.7 0.18 47)" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <div className="p-4 font-semibold border-b">Top customers</div>
          <Table><TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Orders</TableHead><TableHead>Net</TableHead><TableHead>vs prior</TableHead></TableRow></TableHeader>
            <TableBody>{top.map((t) => <TableRow key={t.name}><TableCell>{t.name}</TableCell><TableCell>{t.orders}</TableCell><TableCell>${t.net.toLocaleString()}</TableCell><TableCell className={t.pct >= 0 ? "text-success" : "text-destructive"}>{t.pct}%</TableCell></TableRow>)}</TableBody>
          </Table>
        </Card>
        <Card>
          <div className="p-4 font-semibold border-b">Top products</div>
          <Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Units</TableHead><TableHead>Revenue</TableHead></TableRow></TableHeader>
            <TableBody>{products.map((p) => <TableRow key={p.sku}><TableCell>{p.sku}</TableCell><TableCell>{p.units}</TableCell><TableCell>${p.revenue.toLocaleString()}</TableCell></TableRow>)}</TableBody>
          </Table>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground mt-4">Note: P21 SQL connection is stubbed — values are deterministic seed data. Wire up <code>fetchSalesData</code> server function once VPN access is configured.</p>
    </div>
  );
}
