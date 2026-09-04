import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Play, RefreshCw, Server } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useModuleView } from "@/lib/usage-log";
import {
  useWebsiteExportStatus,
  useSaveWebsiteExportConfig,
  useRunWebsiteExport,
  useProbeWebsiteExportDelivery,
} from "@/hooks/useWebsiteExport";

export const Route = createFileRoute("/_app/website-export")({
  head: () => ({
    meta: [
      { title: "Website Export — Nelson AI for NDI" },
      {
        name: "description",
        content:
          "Nightly Charlston Office Furniture website data export: stored-procedure run, CSV render, and SFTP delivery with run history.",
      },
      { property: "og:title", content: "Website Export — Nelson AI for NDI" },
      {
        property: "og:description",
        content:
          "Nightly Charlston Office Furniture website data export: stored-procedure run, CSV render, and SFTP delivery with run history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WebsiteExportPage,
});

const bytes = (n?: number | null) =>
  n == null ? "—" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");

function WebsiteExportPage() {
  useModuleView("website-export");
  const { hasRole } = useAuth();
  const canView = hasRole("admin") || hasRole("ops_logistics_admin");
  const isAdmin = hasRole("admin");

  const status = useWebsiteExportStatus(canView);
  const saveConfig = useSaveWebsiteExportConfig();
  const runExport = useRunWebsiteExport();
  const probe = useProbeWebsiteExportDelivery();

  const [form, setForm] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    if (status.data?.settings && !form) setForm({ ...status.data.settings });
  }, [status.data, form]);

  if (!canView) {
    return (
      <div className="p-6">
        <ModuleHeader title="Website Export" description="Charlston Office Furniture nightly SFTP delivery" />
        <Card className="p-6 text-sm text-muted-foreground">
          You need the admin or logistics-admin role to view this module.
        </Card>
      </div>
    );
  }

  const runs = (status.data?.runs ?? []) as any[];
  const last = runs.find((r) => !r.dry_run) ?? runs[0];
  const settings = status.data?.settings as any;
  const agents = (status.data?.agents ?? []) as any[];

  const doRun = (dryRun: boolean) => {
    runExport.mutate(
      { dryRun },
      {
        onSuccess: (res: any) => {
          if (res?.ok) {
            toast.success(
              dryRun
                ? `Dry run OK — ${res.rowCount ?? 0} rows, ${bytes(res.byteSize)}, no file delivered`
                : `Delivered ${res.filename} (${res.rowCount ?? 0} rows, ${bytes(res.byteSize)})`,
            );
          } else {
            toast.error(res?.error ?? "Export failed");
          }
        },
        onError: (e: any) => toast.error(e?.message ?? "Export failed"),
      },
    );
  };

  return (
    <div className="p-6">
      <ModuleHeader
        title="Website Export"
        description="Runs the analytics stored procedure, renders CSV, and delivers it to the Charlston Office Furniture SFTP folder."
        actions={
          <>
            <Button variant="outline" onClick={() => status.refetch()} disabled={status.isFetching}>
              {status.isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
            <Button variant="outline" onClick={() => doRun(true)} disabled={runExport.isPending}>
              {runExport.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Dry run
            </Button>
            <Button onClick={() => doRun(false)} disabled={runExport.isPending}>
              {runExport.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
              Run now
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <KpiCard label="Last delivery" value={last?.status === "done" ? when(last?.finished_at) : "—"} icon={<CheckCircle2 className="w-5 h-5" />} />
        <KpiCard label="Rows" value={last?.row_count != null ? String(last.row_count) : "—"} icon={<Server className="w-5 h-5" />} />
        <KpiCard label="File size" value={bytes(last?.byte_size)} icon={<FileUp className="w-5 h-5" />} />
        <KpiCard
          label="Nightly schedule"
          value={settings?.enabled ? `${String(settings.cronHourUtc).padStart(2, "0")}:00 UTC` : "Off"}
          icon={<RefreshCw className="w-5 h-5" />}
        />

      </div>

      {last?.status === "error" && (
        <Card className="p-4 mb-6 border-destructive/40">
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Last run failed</div>
              <div className="text-muted-foreground break-words">{last.error}</div>
            </div>
          </div>
        </Card>
      )}

      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Run history</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="runs" className="mt-4">
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-sm text-muted-foreground">
                      No runs yet. Start with a dry run — it executes the procedure and renders the CSV without
                      delivering anything.
                    </TableCell>
                  </TableRow>
                )}
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{when(r.started_at)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.dry_run ? "dry run" : r.trigger}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === "done" ? "default" : r.status === "error" ? "destructive" : "secondary"}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.remote_filename ?? "—"}</TableCell>
                    <TableCell className="text-right">{r.row_count ?? "—"}</TableCell>
                    <TableCell className="text-right">{bytes(r.byte_size)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[28rem]">
                      {r.error ? (
                        <span className="text-destructive break-words">{r.error}</span>
                      ) : Array.isArray(r.preview) && r.preview.length ? (
                        <pre className="whitespace-pre-wrap break-all">{r.preview.slice(0, 2).join("\n")}</pre>
                      ) : Array.isArray(r.columns) && r.columns.length ? (
                        `${r.columns.length} columns`
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="mt-4 space-y-4">
          <Card className="p-4">
            <div className="text-sm font-medium mb-3">Source & delivery</div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                ["database", "Database"],
                ["procedure", "Stored procedure"],
                ["filenamePattern", "Filename pattern (%Y %m %d)"],
                ["remoteFolder", "Remote folder"],
                ["timezone", "Filename timezone (IANA)"],
                ["delimiter", "Delimiter"],
              ].map(([key, label]) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={key}>{label}</Label>
                  <Input
                    id={key}
                    value={form?.[key] ?? ""}
                    disabled={!isAdmin}
                    onChange={(e) => setForm((f) => ({ ...(f ?? {}), [key]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="space-y-1.5">
                <Label htmlFor="cronHourUtc">Nightly hour (UTC)</Label>
                <Input
                  id="cronHourUtc"
                  type="number"
                  min={0}
                  max={23}
                  value={form?.cronHourUtc ?? 9}
                  disabled={!isAdmin}
                  onChange={(e) => setForm((f) => ({ ...(f ?? {}), cronHourUtc: Number(e.target.value) }))}
                />
              </div>
              <div className="flex items-center gap-6 pt-6">
                <div className="flex items-center gap-2">
                  <Switch
                    id="header"
                    checked={!!form?.header}
                    disabled={!isAdmin}
                    onCheckedChange={(v) => setForm((f) => ({ ...(f ?? {}), header: v }))}
                  />
                  <Label htmlFor="header">Header row</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="enabled"
                    checked={!!form?.enabled}
                    disabled={!isAdmin}
                    onCheckedChange={(v) => setForm((f) => ({ ...(f ?? {}), enabled: v }))}
                  />
                  <Label htmlFor="enabled">Nightly schedule enabled</Label>
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Button
                disabled={!isAdmin || saveConfig.isPending || !form}
                onClick={() =>
                  saveConfig.mutate(form ?? {}, {
                    onSuccess: () => toast.success("Settings saved"),
                    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
                  })
                }
              >
                {saveConfig.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Save settings
              </Button>
              <span className="text-xs text-muted-foreground">
                Next filename: <span className="font-mono">{status.data?.nextFilename ?? "—"}</span>
              </span>
            </div>
          </Card>

          <Card className="p-4 text-sm space-y-2">
            <div className="font-medium">On-prem agent</div>
            <p className="text-muted-foreground">
              SFTP runs on the NDI bridge agent — the cloud app has no SSH capability. Host, port, username and the
              path to the <span className="font-mono">NDI-Charlston-Automation</span> private key live in that
              server's <span className="font-mono">.env</span>; the key is never uploaded here. The partner must
              allow-list that server's public egress IP (expected{" "}
              <span className="font-mono">142.190.99.117</span>).
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {agents.length === 0 && <span className="text-muted-foreground">No agent has checked in.</span>}
              {agents.map((a) => (
                <Badge key={a.name} variant={String(a.version ?? "").startsWith("1.2") ? "default" : "destructive"}>
                  {a.name} v{a.version ?? "?"} · {when(a.last_seen_at)}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              This export needs agent v1.2.0 or newer. Older builds will fail the job with “Unknown job kind:
              website.export.sftp”.
            </p>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
