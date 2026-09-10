import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, RefreshCw, CloudDownload, AlertTriangle } from "lucide-react";
import {
  getWorkbookSyncStatus, syncWorkbookNow, uploadWorkbookSync,
} from "@/lib/truck-capacity-sync.functions";

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
}

export function SharePointSyncCard() {
  const statusFn = useServerFn(getWorkbookSyncStatus);
  const syncFn = useServerFn(syncWorkbookNow);
  const uploadFn = useServerFn(uploadWorkbookSync);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "sync" | "upload">(null);
  const [result, setResult] = useState<any>(null);

  const q = useQuery({ queryKey: ["tc-sharepoint-sync"], queryFn: () => statusFn() });
  const data = q.data;
  const lastLog = data?.logs?.[0] as any | undefined;

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["tc-sharepoint-sync"] });
    await qc.invalidateQueries({ queryKey: ["tc-overview"] });
  }

  async function onSync() {
    setBusy("sync"); setResult(null);
    try {
      const res: any = await syncFn({ data: { force: true } });
      setResult(res);
      if (res?.ok) toast.success(`Sync ${res.status}: ${res.counts?.inserted ?? 0} new, ${res.counts?.updated ?? 0} updated`);
      else toast.error(res?.error ?? res?.reason ?? "Sync failed");
      await refresh();
    } catch (e: any) { toast.error(e?.message ?? "Sync failed"); }
    finally { setBusy(null); }
  }

  async function onUpload(file: File) {
    setBusy("upload"); setResult(null);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const res: any = await uploadFn({ data: { fileBase64: b64 } });
      setResult(res);
      if (res?.ok) toast.success(`Workbook read: ${res.counts?.inserted ?? 0} new, ${res.counts?.updated ?? 0} updated`);
      else toast.error(res?.error ?? "Upload failed");
      await refresh();
    } catch (e: any) { toast.error(e?.message ?? "Upload failed"); }
    finally { setBusy(null); }
  }

  const connected = !!data?.connector?.connected;

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">SharePoint sync — Primary Truck Capacity.xlsx</div>
          <div className="text-xs text-muted-foreground">
            Reads the Warehouse Management Team workbook every 30 minutes. Pull only — Nelson never writes to the file.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={connected ? "default" : "outline"}>
            {connected ? `Connected (${data?.connector?.connector})` : "Not connected"}
          </Badge>
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`w-3.5 h-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {!connected && (
        <div className="flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
          <span>
            The Microsoft SharePoint connection is not linked yet, so automatic sync is idle. Use
            “Upload workbook” below in the meantime — it runs the exact same reader and upsert.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Last sync" value={fmt(data?.state?.last_synced_at)} />
        <Stat label="Last status" value={data?.state?.last_status ?? "—"} />
        <Stat label="File modified" value={fmt(data?.state?.file_modified_at)} />
        <Stat label="Flagged missing" value={String(data?.missingFromSheetCount ?? 0)} />
      </div>

      {lastLog && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <Stat label="Source" value={lastLog.source} />
          <Stat label="Sheets" value={String(lastLog.sheets_seen)} />
          <Stat label="Inserted" value={String(lastLog.rows_inserted)} />
          <Stat label="Updated" value={String(lastLog.rows_updated)} />
          <Stat label="Skipped" value={String(lastLog.rows_skipped)} />
        </div>
      )}

      {Array.isArray(lastLog?.unmatched_sheets) && lastLog.unmatched_sheets.length > 0 && (
        <div className="text-xs">
          <span className="text-muted-foreground">Unmatched tabs: </span>
          {lastLog.unmatched_sheets.join(", ")}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={onSync} disabled={busy !== null || !connected}>
          {busy === "sync" ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CloudDownload className="w-4 h-4 mr-1" />}
          Sync now
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Upload workbook (.xlsx)</span>
          <Input
            type="file" accept=".xlsx" className="h-8 w-64 text-xs"
            disabled={busy !== null}
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
          />
        </div>
      </div>

      {result?.perSheet && (
        <div className="max-h-72 overflow-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Sheet</TableHead><TableHead>Status</TableHead><TableHead>Rows</TableHead>
              <TableHead>No-run</TableHead><TableHead>Rejected</TableHead><TableHead>No date</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {result.perSheet.map((s: any) => (
                <TableRow key={s.sheet}>
                  <TableCell className="text-xs">{s.sheet}</TableCell>
                  <TableCell className="text-xs">
                    <Badge variant={s.status === "ok" ? "default" : "outline"}>{s.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{s.rows}</TableCell>
                  <TableCell className="text-xs">{s.no_run_rows}</TableCell>
                  <TableCell className="text-xs">{s.rejected_capacity}</TableCell>
                  <TableCell className="text-xs">{s.skipped_no_date}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-2">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="text-xs font-medium break-words">{value}</div>
    </div>
  );
}
