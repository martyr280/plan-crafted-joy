import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { CheckCircle2, AlertCircle, Shield, ShieldCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { P21BridgePanel } from "@/components/shared/P21BridgePanel";

export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

const ALL_ROLES: AppRole[] = ["admin", "ops_orders", "ops_ar", "ops_logistics", "ops_reports", "sales_rep"];
const ROLE_LABELS: Record<AppRole, string> = {
  admin: "Admin",
  ops_orders: "Orders",
  ops_ar: "AR/Collections",
  ops_logistics: "Logistics",
  ops_reports: "Reports",
  sales_rep: "Sales Rep",
};

type ProfileRow = { id: string; email: string | null; display_name: string | null };
type RoleRow = { user_id: string; role: AppRole };

function SettingsPage() {
  const { user, roles, hasRole } = useAuth();
  const [skus, setSkus] = useState<any[]>([]);
  useEffect(() => {
    supabase.from("sku_crossref").select("*").order("competitor_sku").then(({ data }) => setSkus(data ?? []));
  }, []);

  const integrations = [
    { name: "P21 (Epicor)", status: "bridge", note: "Connect via the local bridge agent below." },
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
        <TabsContent value="integrations" className="space-y-6">
          <div className="grid md:grid-cols-3 gap-4">
            {integrations.map((i) => (
              <Card key={i.name} className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold">{i.name}</span>
                  {i.status === "live" ? (
                    <Badge className="bg-success text-success-foreground"><CheckCircle2 className="w-3 h-3 mr-1" /> Live</Badge>
                  ) : i.status === "bridge" ? (
                    <Badge className="bg-primary text-primary-foreground">Bridge</Badge>
                  ) : (
                    <Badge variant="secondary"><AlertCircle className="w-3 h-3 mr-1" /> Stub</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{i.note}</p>
              </Card>
            ))}
          </div>
          <P21BridgePanel />
        </TabsContent>
        <TabsContent value="sku">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Competitor SKU</TableHead>
                  <TableHead>NDI SKU</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skus.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell><code>{s.competitor_sku}</code></TableCell>
                    <TableCell><code>{s.ndi_sku}</code></TableCell>
                    <TableCell>{Math.round(Number(s.confidence) * 100)}%</TableCell>
                    <TableCell><Badge variant="outline">{s.source}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="users">
          <UsersAndRoles isAdmin={hasRole("admin")} currentUserId={user?.id ?? null} currentRoles={roles} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function UsersAndRoles({ isAdmin, currentUserId, currentRoles }: { isAdmin: boolean; currentUserId: string | null; currentRoles: AppRole[] }) {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [rolesByUser, setRolesByUser] = useState<Record<string, AppRole[]>>({});
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [claiming, setClaiming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: profs }, { data: rs }] = await Promise.all([
      supabase.from("profiles").select("id,email,display_name").order("email"),
      supabase.from("user_roles").select("user_id,role"),
    ]);
    setProfiles((profs ?? []) as ProfileRow[]);
    const map: Record<string, AppRole[]> = {};
    ((rs ?? []) as RoleRow[]).forEach((r) => {
      map[r.user_id] = [...(map[r.user_id] ?? []), r.role];
    });
    setRolesByUser(map);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleRole(userId: string, role: AppRole, enable: boolean) {
    const key = `${userId}:${role}`;
    setSavingKey(key);
    try {
      if (enable) {
        const { error } = await supabase.from("user_roles").insert({ user_id: userId, role });
        if (error) throw error;
        setRolesByUser((m) => ({ ...m, [userId]: [...(m[userId] ?? []), role] }));
        toast.success(`Granted ${ROLE_LABELS[role]}`);
      } else {
        const { error } = await supabase.from("user_roles").delete().eq("user_id", userId).eq("role", role);
        if (error) throw error;
        setRolesByUser((m) => ({ ...m, [userId]: (m[userId] ?? []).filter((r) => r !== role) }));
        toast.success(`Revoked ${ROLE_LABELS[role]}`);
      }
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update role");
    } finally {
      setSavingKey(null);
    }
  }

  async function claimAdmin() {
    setClaiming(true);
    try {
      const { data, error } = await supabase.rpc("claim_admin_if_none");
      if (error) throw error;
      if (data === true) {
        toast.success("You are now Admin. Refreshing…");
        setTimeout(() => window.location.reload(), 600);
      } else {
        toast.error("An admin already exists. Ask them to grant you the role.");
      }
    } catch (e: any) {
      toast.error(e.message ?? "Failed to claim admin");
    } finally {
      setClaiming(false);
    }
  }

  if (!isAdmin) {
    const noAdminAnywhere = Object.values(rolesByUser).every((rs) => !rs.includes("admin"));
    return (
      <Card className="p-6 space-y-4">
        <div className="flex items-start gap-3">
          <Shield className="w-5 h-5 text-muted-foreground mt-0.5" />
          <div className="text-sm">
            <p className="font-medium">Admin access required</p>
            <p className="text-muted-foreground mt-1">
              Your roles: {currentRoles.length ? currentRoles.map((r) => ROLE_LABELS[r]).join(", ") : "none"}.
            </p>
          </div>
        </div>
        <div className="border-t pt-4">
          <p className="text-sm text-muted-foreground mb-3">
            If no admin has been set up yet, you can claim the Admin role for this workspace. This only works once and is disabled as soon as any admin exists.
          </p>
          <Button onClick={claimAdmin} disabled={claiming || !currentUserId}>
            {claiming ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
            Claim Admin role
          </Button>
          {!loading && !noAdminAnywhere && (
            <p className="text-xs text-muted-foreground mt-2">An admin already exists — ask them to grant you access.</p>
          )}
        </div>
      </Card>
    );
  }

  const filtered = profiles.filter((p) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (p.email ?? "").toLowerCase().includes(q) || (p.display_name ?? "").toLowerCase().includes(q);
  });

  return (
    <Card>
      <div className="p-4 border-b flex items-center justify-between gap-3">
        <Input placeholder="Search by email or name…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-sm" />
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            {ALL_ROLES.map((r) => (
              <TableHead key={r} className="text-center">{ROLE_LABELS[r]}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((p) => {
            const userRoles = rolesByUser[p.id] ?? [];
            const isSelf = p.id === currentUserId;
            return (
              <TableRow key={p.id}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-medium">{p.display_name || p.email}</span>
                    <span className="text-xs text-muted-foreground">{p.email}</span>
                    {isSelf && <Badge variant="outline" className="mt-1 w-fit text-[10px]">you</Badge>}
                  </div>
                </TableCell>
                {ALL_ROLES.map((r) => {
                  const checked = userRoles.includes(r);
                  const key = `${p.id}:${r}`;
                  const disabled = savingKey === key || (isSelf && r === "admin" && checked);
                  return (
                    <TableCell key={r} className="text-center">
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={(v) => toggleRole(p.id, r, !!v)}
                        aria-label={`${ROLE_LABELS[r]} for ${p.email}`}
                      />
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
          {!filtered.length && (
            <TableRow><TableCell colSpan={ALL_ROLES.length + 1} className="text-center text-sm text-muted-foreground py-8">No users found.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <div className="p-3 text-xs text-muted-foreground border-t">
        Tip: You can't revoke your own Admin role from here — ask another admin to do it.
      </div>
    </Card>
  );
}
