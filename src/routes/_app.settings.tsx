import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, type AppRole } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { CheckCircle2, AlertCircle, Shield, ShieldCheck, Loader2, MoreHorizontal, UserPlus, Mail, Ban, RotateCcw, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { P21BridgePanel } from "@/components/shared/P21BridgePanel";
import {
  listManagedUsers,
  inviteUser,
  sendPasswordReset,
  revokeAllRoles,
  setUserDisabled,
  setUserRole,
  listAdminActivity,
} from "@/lib/user-admin.functions";

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

type ManagedUser = {
  id: string;
  email: string | null;
  display_name: string | null;
  roles: AppRole[];
  last_sign_in_at: string | null;
  banned_until: string | null;
  invited_at: string | null;
  email_confirmed_at: string | null;
};

type ActivityRow = {
  id: string;
  event_type: string;
  message: string;
  created_at: string;
  actor_id: string | null;
  metadata: any;
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function isDisabled(u: ManagedUser) {
  if (!u.banned_until) return false;
  const t = new Date(u.banned_until).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function UsersAndRoles({ isAdmin, currentUserId, currentRoles }: { isAdmin: boolean; currentUserId: string | null; currentRoles: AppRole[] }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoles, setInviteRoles] = useState<AppRole[]>(["ops_orders"]);
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; description: string; action: () => Promise<void> }>(null);

  const listFn = useServerFn(listManagedUsers);
  const inviteFn = useServerFn(inviteUser);
  const resetFn = useServerFn(sendPasswordReset);
  const revokeAllFn = useServerFn(revokeAllRoles);
  const disableFn = useServerFn(setUserDisabled);
  const setRoleFn = useServerFn(setUserRole);
  const activityFn = useServerFn(listAdminActivity);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, a] = await Promise.all([listFn(), activityFn()]);
      setUsers(u as ManagedUser[]);
      setActivity(a as ActivityRow[]);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [listFn, activityFn]);

  useEffect(() => {
    if (isAdmin) load();
    else setLoading(false);
  }, [isAdmin, load]);

  async function toggleRole(userId: string, role: AppRole, enable: boolean) {
    const key = `${userId}:${role}`;
    setSavingKey(key);
    try {
      await setRoleFn({ data: { userId, role, enable } });
      setUsers((arr) =>
        arr.map((u) =>
          u.id === userId
            ? { ...u, roles: enable ? Array.from(new Set([...u.roles, role])) : u.roles.filter((r) => r !== role) }
            : u
        )
      );
      toast.success(`${enable ? "Granted" : "Revoked"} ${ROLE_LABELS[role]}`);
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

  async function submitInvite() {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      await inviteFn({ data: { email: inviteEmail.trim(), roles: inviteRoles } });
      toast.success(`Invite sent to ${inviteEmail.trim()}`);
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRoles(["ops_orders"]);
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to send invite");
    } finally {
      setInviting(false);
    }
  }

  if (!isAdmin) {
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
            If no admin has been set up yet, you can claim the Admin role for this workspace. This only works once.
          </p>
          <Button onClick={claimAdmin} disabled={claiming || !currentUserId}>
            {claiming ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
            Claim Admin role
          </Button>
        </div>
      </Card>
    );
  }

  const filtered = users.filter((u) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (u.email ?? "").toLowerCase().includes(q) || (u.display_name ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6">
      <Card>
        <div className="p-4 border-b flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Input placeholder="Search by email or name…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-sm" />
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
            </Button>
          </div>
          <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><UserPlus className="w-4 h-4 mr-2" /> Invite user</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Invite a user</DialogTitle>
                <DialogDescription>They'll receive an email to set their password and join Nelson AI.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Email</Label>
                  <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@ndiof.com" />
                </div>
                <div>
                  <Label className="mb-2 block">Initial roles</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {ALL_ROLES.map((r) => (
                      <label key={r} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={inviteRoles.includes(r)}
                          onCheckedChange={(v) =>
                            setInviteRoles((rs) => (v ? Array.from(new Set([...rs, r])) : rs.filter((x) => x !== r)))
                          }
                        />
                        {ROLE_LABELS[r]}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={inviting}>Cancel</Button>
                <Button onClick={submitInvite} disabled={inviting || !inviteEmail.trim()}>
                  {inviting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Mail className="w-4 h-4 mr-2" />}
                  Send invite
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last sign-in</TableHead>
              {ALL_ROLES.map((r) => (
                <TableHead key={r} className="text-center">{ROLE_LABELS[r]}</TableHead>
              ))}
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((u) => {
              const isSelf = u.id === currentUserId;
              const disabled = isDisabled(u);
              const pending = !u.email_confirmed_at && !!u.invited_at;
              return (
                <TableRow key={u.id} className={disabled ? "opacity-60" : undefined}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{u.display_name || u.email}</span>
                      <span className="text-xs text-muted-foreground">{u.email}</span>
                      {isSelf && <Badge variant="outline" className="mt-1 w-fit text-[10px]">you</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    {disabled ? (
                      <Badge variant="destructive">Disabled</Badge>
                    ) : pending ? (
                      <Badge variant="secondary">Pending</Badge>
                    ) : (
                      <Badge className="bg-success text-success-foreground">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDate(u.last_sign_in_at)}</TableCell>
                  {ALL_ROLES.map((r) => {
                    const checked = u.roles.includes(r);
                    const key = `${u.id}:${r}`;
                    const isDis = savingKey === key || (isSelf && r === "admin" && checked) || disabled;
                    return (
                      <TableCell key={r} className="text-center">
                        <Checkbox
                          checked={checked}
                          disabled={isDis}
                          onCheckedChange={(v) => toggleRole(u.id, r, !!v)}
                          aria-label={`${ROLE_LABELS[r]} for ${u.email}`}
                        />
                      </TableCell>
                    );
                  })}
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuItem
                          disabled={!u.email}
                          onClick={async () => {
                            try {
                              await resetFn({ data: { email: u.email! } });
                              toast.success("Password reset email sent");
                            } catch (e: any) { toast.error(e.message ?? "Failed"); }
                          }}
                        >
                          <KeyRound className="w-4 h-4 mr-2" /> Send password reset
                        </DropdownMenuItem>
                        {pending && (
                          <DropdownMenuItem
                            disabled={!u.email}
                            onClick={async () => {
                              try {
                                await inviteFn({ data: { email: u.email!, roles: u.roles } });
                                toast.success("Invite resent");
                                load();
                              } catch (e: any) { toast.error(e.message ?? "Failed"); }
                            }}
                          >
                            <Mail className="w-4 h-4 mr-2" /> Resend invite
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={isSelf || u.roles.length === 0}
                          onClick={() =>
                            setConfirm({
                              title: `Revoke all roles from ${u.email}?`,
                              description: "They will lose access to every module until you grant a role again.",
                              action: async () => {
                                await revokeAllFn({ data: { userId: u.id } });
                                toast.success("All roles revoked");
                                load();
                              },
                            })
                          }
                        >
                          <RotateCcw className="w-4 h-4 mr-2" /> Revoke all roles
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={isSelf}
                          onClick={() =>
                            setConfirm({
                              title: disabled ? `Re-enable ${u.email}?` : `Disable ${u.email}?`,
                              description: disabled
                                ? "They will be able to sign in again."
                                : "Their account will be banned and they cannot sign in until re-enabled.",
                              action: async () => {
                                await disableFn({ data: { userId: u.id, disabled: !disabled } });
                                toast.success(disabled ? "User re-enabled" : "User disabled");
                                load();
                              },
                            })
                          }
                        >
                          <Ban className="w-4 h-4 mr-2" /> {disabled ? "Re-enable user" : "Disable user"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
            {!filtered.length && (
              <TableRow>
                <TableCell colSpan={ALL_ROLES.length + 4} className="text-center text-sm text-muted-foreground py-8">
                  {loading ? "Loading…" : "No users found."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="p-3 text-xs text-muted-foreground border-t">
          Tip: You can't revoke your own Admin role or disable your own account from here — ask another admin.
        </div>
      </Card>

      <Card>
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Recent admin actions</h3>
            <p className="text-xs text-muted-foreground">Last 50 invites, role changes, and account events.</p>
          </div>
        </div>
        <div className="divide-y max-h-80 overflow-auto">
          {activity.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">No admin actions yet.</div>
          )}
          {activity.map((a) => (
            <div key={a.id} className="px-4 py-2 flex items-center justify-between gap-4 text-sm">
              <div className="flex items-center gap-3 min-w-0">
                <Badge variant="outline" className="text-[10px] shrink-0">{a.event_type.replace("admin.", "")}</Badge>
                <span className="truncate">{a.message}</span>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">{fmtDate(a.created_at)}</span>
            </div>
          ))}
        </div>
      </Card>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const a = confirm?.action;
                setConfirm(null);
                if (a) {
                  try { await a(); } catch (e: any) { toast.error(e.message ?? "Failed"); }
                }
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
