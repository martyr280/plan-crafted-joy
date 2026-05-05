import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { CheckCircle2, AlertCircle } from "lucide-react";

export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

function SettingsPage() {
  const [skus, setSkus] = useState<any[]>([]);
  useEffect(() => { supabase.from("sku_crossref").select("*").order("competitor_sku").then(({ data }) => setSkus(data ?? [])); }, []);

  const integrations = [
    { name: "P21 (Epicor)", status: "stub", note: "VPN connection pending. Stub returning seed data." },
    { name: "Samsara", status: "stub", note: "API token not configured. Stub returning placeholder photos." },
    { name: "Lovable AI Gateway", status: "live", note: "PO parser and reminder generator active." },
  ];

  return (
    <div>
      <ModuleHeader title="Settings" description="Integrations, templates, rules, users." />
      <Tabs defaultValue="integrations">
        <TabsList>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="sku">SKU Cross-Reference</TabsTrigger>
          <TabsTrigger value="users">Users & Roles</TabsTrigger>
        </TabsList>
        <TabsContent value="integrations">
          <div className="grid md:grid-cols-3 gap-4">
            {integrations.map((i) => (
              <Card key={i.name} className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold">{i.name}</span>
                  {i.status === "live" ? <Badge className="bg-success text-success-foreground"><CheckCircle2 className="w-3 h-3 mr-1" /> Live</Badge> : <Badge variant="secondary"><AlertCircle className="w-3 h-3 mr-1" /> Stub</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">{i.note}</p>
              </Card>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="sku">
          <Card><Table>
            <TableHeader><TableRow><TableHead>Competitor SKU</TableHead><TableHead>NDI SKU</TableHead><TableHead>Confidence</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
            <TableBody>{skus.map((s) => <TableRow key={s.id}><TableCell><code>{s.competitor_sku}</code></TableCell><TableCell><code>{s.ndi_sku}</code></TableCell><TableCell>{Math.round(Number(s.confidence) * 100)}%</TableCell><TableCell><Badge variant="outline">{s.source}</Badge></TableCell></TableRow>)}</TableBody>
          </Table></Card>
        </TabsContent>
        <TabsContent value="users">
          <Card className="p-6 text-sm text-muted-foreground">User management is admin-only. Use the Lovable Cloud Users dashboard to invite users and assign roles via the <code>user_roles</code> table.</Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
