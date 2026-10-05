// Admin-only: prepare warehouse-manager invites. Saving a draft grants nothing.
// The separate "Invite branch manager" confirmation is the only action that creates
// an account or sends email.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, Send, X, RotateCcw } from "lucide-react";
import { cancelBranchInvite, confirmBranchInvite, listBranchInvites, saveBranchInviteDraft } from "@/lib/branch-invite.functions";
import { WAREHOUSES, type Warehouse } from "@/lib/warehouse-scope";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type Invite = { id: string; email_normalized: string; display_name: string | null; warehouse: Warehouse; status: string; attempt_count: number; last_error: string | null; sent_at: string | null };

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft — no access", claimed: "Sending…", staged: "Sending…", sent: "Invited", failed: "Failed — no access",
  cancelled: "Cancelled", revoked: "Revoked",
};
const ERROR_LABEL: Record<string, string> = {
  unknown_outcome: "Email outcome unknown. Retry is safe: the provider will not send a duplicate.",
  link_failed: "Could not create the invitation link.", user_mismatch: "Account did not match this email.",
  existing_account: "This email already has a Nelson login; it was not changed.",
  existing_privileged_account: "This email belongs to an account with other roles; it was not changed.",
  user_mapped_elsewhere: "Account already linked to another warehouse invite.", send_failed: "The email provider rejected the message.",
  stage_failed: "Setup did not complete.", failed: "Failed.",
};

export function WarehouseManagersPanel() {
  const qc = useQueryClient();
  const list = useServerFn(listBranchInvites);
  const save = useServerFn(saveBranchInviteDraft);
  const cancel = useServerFn(cancelBranchInvite);
  const invite = useServerFn(confirmBranchInvite);
  const q = useQuery({ queryKey: ["branch-invites"], queryFn: () => list() });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [warehouse, setWarehouse] = useState<Warehouse | "">("");
  const [confirming, setConfirming] = useState<{ inv: Invite; requestKey: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["branch-invites"] });

  const saveM = useMutation({
    mutationFn: () => save({ data: { email, displayName: name || undefined, warehouse: warehouse as Warehouse } }),
    onSuccess: () => { toast.success("Draft saved. No account or access was created."); setEmail(""); setName(""); setWarehouse(""); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Could not save draft"),
  });
  const cancelM = useMutation({
    mutationFn: (id: string) => cancel({ data: { id } }),
    onSuccess: (r: any) => { toast.success(r.status === "revoked" ? "Access revoked. The login itself was not deleted." : "Draft cancelled."); refresh(); },
    onError: (e: any) => toast.error(e?.message ?? "Could not cancel"),
  });
  const inviteM = useMutation({
    mutationFn: (c: { inv: Invite; requestKey: string }) =>
      invite({ data: { id: c.inv.id, requestKey: c.requestKey, email: c.inv.email_normalized, warehouse: c.inv.warehouse, confirm: true } }),
    onSuccess: (r: any) => {
      if (r.status === "sent") toast.success(r.duplicate ? "Already invited — no second email sent." : "Invitation sent.");
      else if (r.status === "in_progress") toast.message("This invite is already being sent.");
      else toast.error(ERROR_LABEL[r.code] ?? "Invite failed. No access was granted.");
      setConfirming(null); refresh();
    },
    onError: (e: any) => { toast.error(e?.message ?? "Invite failed. No access was granted."); setConfirming(null); refresh(); },
  });

  const rows = (q.data ?? []) as Invite[];
  return (
    <Card className="p-4 space-y-4">
      <div>
        <h2 className="font-semibold">Warehouse managers</h2>
        <p className="text-sm text-muted-foreground">Read-only Driver Time, Truck Capacity and Dispatch for one warehouse. Saving a draft does not create an account, grant access or send email.</p>
      </div>
      <form className="grid gap-3 sm:grid-cols-4 items-end" onSubmit={(e) => { e.preventDefault(); if (!warehouse) return toast.error("Choose one warehouse."); saveM.mutate(); }}>
        <div><Label htmlFor="bm-email">Email</Label><Input id="bm-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><Label htmlFor="bm-name">Display name</Label><Input id="bm-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div>
          <Label htmlFor="bm-wh">Warehouse</Label>
          <select id="bm-wh" className="w-full h-9 border rounded-md px-2 bg-background text-sm" value={warehouse} onChange={(e) => setWarehouse(e.target.value as Warehouse)} required>
            <option value="">Choose…</option>
            {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
        <Button type="submit" variant="secondary" disabled={saveM.isPending}>{saveM.isPending && <Loader2 className="w-4 h-4 animate-spin" />}Save draft</Button>
      </form>

      {q.isError ? <p role="alert" className="text-sm text-destructive">Could not load warehouse-manager invites.</p> : (
        <Table>
          <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Warehouse</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 && <TableRow><TableCell colSpan={5} className="text-sm text-muted-foreground">No warehouse-manager drafts.</TableCell></TableRow>}
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.email_normalized}</TableCell>
                <TableCell>{r.display_name ?? "—"}</TableCell>
                <TableCell>{r.warehouse}</TableCell>
                <TableCell>
                  <Badge variant={r.status === "sent" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                  {r.status === "failed" && r.last_error && <p className="text-xs text-muted-foreground mt-1">{ERROR_LABEL[r.last_error] ?? r.last_error}</p>}
                </TableCell>
                <TableCell className="text-right space-x-2">
                  {(r.status === "draft" || r.status === "failed") && (
                    <Button size="sm" onClick={() => setConfirming({ inv: r, requestKey: crypto.randomUUID() })}>
                      {r.status === "failed" ? <><RotateCcw className="w-4 h-4" />Retry invite</> : <><Send className="w-4 h-4" />Invite branch manager</>}
                    </Button>
                  )}
                  {["draft", "failed", "sent"].includes(r.status) && (
                    <Button size="sm" variant="outline" disabled={cancelM.isPending} onClick={() => cancelM.mutate(r.id)}>
                      <X className="w-4 h-4" />{r.status === "draft" ? "Cancel draft" : "Revoke access"}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AlertDialog open={!!confirming} onOpenChange={(o) => { if (!o && !inviteM.isPending) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Invite branch manager?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>This creates a Nelson login for <strong>{confirming?.inv.email_normalized}</strong> and emails an invitation.</p>
                <p>Role: <strong>Warehouse manager</strong> · Warehouse: <strong>{confirming?.inv.warehouse}</strong></p>
                <ul className="list-disc pl-5">
                  <li>Read-only Driver Time, Truck Capacity and Dispatch for {confirming?.inv.warehouse} only.</li>
                  <li>No pay, rates or paid hours; no edits, sweeps, exports, P21 refreshes or Ask Nelson.</li>
                  <li>Access turns on only after the email is sent successfully.</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={inviteM.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={inviteM.isPending} onClick={(e) => { e.preventDefault(); if (confirming && !inviteM.isPending) inviteM.mutate(confirming); }}>
              {inviteM.isPending && <Loader2 className="w-4 h-4 animate-spin" />}Invite branch manager
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
