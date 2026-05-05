import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Download, RefreshCw, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { fetchSalesData } from "@/server/p21.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/sales")({ component: SalesPage });

function seedRandom(seed: number) { return () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }; }

function dateRangeFor(period: "daily" | "weekly" | "monthly") {
  const to = new Date();
  const from = new Date();
  if (period === "daily") from.setDate(to.getDate() - 14);
  else if (period === "weekly") from.setDate(to.getDate() - 7 * 12);
  else from.setMonth(to.getMonth() - 12);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

function SalesPage() {
  const { user, hasRole } = useAuth();
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("daily");
  const [rep, setRep] = useState<string>("ALL");
  const [profile, setProfile] = useState<any>(null);
  const [live, setLive] = useState<{ rows: any[]; totals: { net: number; orders: number } } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) supabase.from("profiles").select("*").eq("id", user.id).single().then(({ data }) => setProfile(data));
  }, [user]);

  const isSalesRepOnly = hasRole("sales_rep") && !hasRole("admin");
  const effectiveRep = isSalesRepOnly ? (profile?.sales_rep_code ?? "REP-101") : rep;

  async function loadLive() {
    if (!hasRole("admin")) {
      toast.error("Live P21 data requires admin role");
      return;
    }
    setLoading(true);
    try {
      const { dateFrom, dateTo } = dateRangeFor(period);
      const res = await fetchSalesData({
        data: { repCode: effectiveRep === "ALL" ? null : effectiveRep, dateFrom, dateTo },
      });
      setLive({ rows: (res as any).rows, totals: (res as any).totals });
      toast.success(`Loaded ${(res as any).rows.length} rows from P21`);
    } catch (e: any) {
      toast.error(e.message ?? "P21 query failed");
    } finally {
      setLoading(false);
    }
  }

  const stub = useMemo(() => {
    const days = period === "daily" ? 14 : period === "weekly" ? 12 : 12;
    const rng = seedRandom(effectiveRep === "ALL" ? 42 : effectiveRep.charCodeAt(4));
    const trend = Array.from({ length: days }).map((_, i) => ({ label: `${period === "monthly" ? "M" : period === "weekly" ? "W" : "D"}-${i + 1}`, net: Math.round(8000 + rng() * 12000) }));
    const total = trend.reduce((a, t) => a + t.net, 0);
    const kpi = { net: total, orders: Math.round(20 + rng() * 80), newCust: Math.round(2 + rng() * 8), returns: Math.round(rng() * 5000) };
    const top = ["Apex Architects", "Blueprint Interiors", "Delta Office Supply", "Echo Workspace", "Granite Group"].map((n) => ({ name: n, orders: Math.round(2 + rng() * 12), net: Math.round(5000 + rng() * 30000), pct: Math.round((rng() - 0.5) * 30) }));
    const products = ["NDI-CHR-AER-B", "NDI-DSK-PIR", "NDI-CHR-LEAP", "NDI-FILE-ABDA", "NDI-BLK-4421"].map((s) => ({ sku: s, units: Math.round(rng() * 80), revenue: Math.round(2000 + rng() * 15000) }));
    return { trend, kpi, top, products };
  }, [period, effectiveRep]);

  const top = live
    ? live.rows.slice(0, 10).map((r: any) => ({ name: r.customer_name, orders: Number(r.order_count), net: Number(r.net_sales), pct: 0 }))
    : stub.top;
  const kpi = live ? { net: live.totals.net, orders: live.totals.orders, newCust: 0, returns: 0 } : stub.kpi;
  const trend = stub.trend;
  const products = stub.products;

  function exportCsv() {
    const csv = ["Customer,Orders,Net,Pct vs prior", ...top.map((t) => `${t.name},${t.orders},${t.net},${t.pct}`)].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "sales.csv"; a.click();
  }

  return (
    <div>
      <ModuleHeader title="Sales Dashboard" description={`${live ? "Live from P21 via bridge." : "Showing seed data — click \"Sync from P21\" to fetch live."} ${isSalesRepOnly ? "Showing your data only." : ""}`}
        actions={
          <>
            <Button variant="outline" onClick={loadLive} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Sync from P21
            </Button>
            <Button variant="outline" onClick={exportCsv}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
          </>
        } />

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
          <div className="p-4 font-semibold border-b">Top customers {live && <span className="text-xs text-success ml-2">live</span>}</div>
          <Table><TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Orders</TableHead><TableHead>Net</TableHead><TableHead>vs prior</TableHead></TableRow></TableHeader>
            <TableBody>{top.map((t) => <TableRow key={t.name}><TableCell>{t.name}</TableCell><TableCell>{t.orders}</TableCell><TableCell>${Number(t.net).toLocaleString()}</TableCell><TableCell className={t.pct >= 0 ? "text-success" : "text-destructive"}>{t.pct}%</TableCell></TableRow>)}</TableBody>
          </Table>
        </Card>
        <Card>
          <div className="p-4 font-semibold border-b">Top products</div>
          <Table><TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Units</TableHead><TableHead>Revenue</TableHead></TableRow></TableHeader>
            <TableBody>{products.map((p) => <TableRow key={p.sku}><TableCell>{p.sku}</TableCell><TableCell>{p.units}</TableCell><TableCell>${p.revenue.toLocaleString()}</TableCell></TableRow>)}</TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
