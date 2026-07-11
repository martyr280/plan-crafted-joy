import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Play, AlertTriangle, Loader2, Pencil, Download, Send, Mail } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import {
  generateSpiffRun,
  rebuildSpiffChecks,
  downloadSpiffWorkbook,
  sendSpiffForApproval,
  sendSpiffToAp,
} from "@/lib/spiff.functions";

export const Route = createFileRoute("/_app/spiff")({ component: SpiffPage });

type Program = {
  id: string;
  customer_id: string;
  customer_name: string;
  rep_org: string;
  rate: number;
  product_scope: "all" | "pl_ryker_jax" | "pl_ryker_jax_no_seating";
  exclude_special_orders: boolean;
  payout_mode: "per_writing_rep" | "single_check";
  payee_name: string | null;
  min_check_amount: number;
  notes: string | null;
  active: boolean;
};
type RunRow = {
  id: string;
  quarter_label: string;
  date_from: string;
  date_to: string;
  status: "draft" | "in_review" | "approved" | "sent_to_ap";
  totals: any;
  created_at: string;
};
type Line = {
  id: string;
  run_id: string;
  program_id: string;
  customer_id: string;
  order_date: string | null;
  first_invoice_date: string | null;
  last_invoice_date: string | null;
  invoice_date: string | null;
  order_no: string | null;
  po_no: string | null;
  item_id: string | null;
  item_desc: string | null;
  qty_ordered: number | null;
  unit_price: number | null;
  extended_price: number | null;
  product_group_id: string | null;
  spiff_amount: number;
  writing_rep: string | null;
  rep_parse_confidence: "parsed" | "unmatched" | "manual";
  included: boolean;
  exclusion_reason: string | null;
  flags: any;
};
type Check = {
  id: string;
  run_id: string;
  program_id: string;
  customer_id: string;
  payee: string;
  amount: number;
  line_count: number;
  below_minimum: boolean;
  status: "pending" | "approved" | "sent";
};

const QUARTERS: Array<{ label: string; from: string; toExclusive: string }> = (() => {
  const out: Array<{ label: string; from: string; toExclusive: string }> = [];
  const years = [2025, 2026];
  for (const y of years) {
    out.push({ label: `Q1-${y}`, from: `${y}-01-01`, toExclusive: `${y}-04-01` });
    out.push({ label: `Q2-${y}`, from: `${y}-04-01`, toExclusive: `${y}-07-01` });
    out.push({ label: `Q3-${y}`, from: `${y}-07-01`, toExclusive: `${y}-10-01` });
    out.push({ label: `Q4-${y}`, from: `${y}-10-01`, toExclusive: `${y + 1}-01-01` });
  }
  return out;
})();

function money(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function SpiffPage() {
  const { user } = useAuth();
  const generate = useServerFn(generateSpiffRun);
  const rebuild = useServerFn(rebuildSpiffChecks);
  const downloadFn = useServerFn(downloadSpiffWorkbook);
  const sendApprovalFn = useServerFn(sendSpiffForApproval);
  const sendApFn = useServerFn(sendSpiffToAp);

  const [programs, setPrograms] = useState<Program[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [quarterLabel, setQuarterLabel] = useState("Q2-2026");
  const [dateFrom, setDateFrom] = useState("2026-04-01");
  const [dateTo, setDateTo] = useState("2026-07-01");
  const [generating, setGenerating] = useState(false);

  async function loadProgramsAndRuns() {
    const [{ data: pr }, { data: rs }] = await Promise.all([
      supabase.from("spiff_programs").select("*").order("customer_name"),
      supabase
        .from("spiff_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    setPrograms((pr ?? []) as Program[]);
    setRuns((rs ?? []) as RunRow[]);
    if (!currentRunId && rs && rs.length > 0) setCurrentRunId(rs[0].id);
  }

  async function loadRunDetail(runId: string) {
    const [{ data: ls }, { data: cks }] = await Promise.all([
      supabase
        .from("spiff_run_lines")
        .select("*")
        .eq("run_id", runId)
        .order("customer_id")
        .order("order_date")
        .limit(50000),
      supabase.from("spiff_checks").select("*").eq("run_id", runId).limit(5000),
    ]);
    setLines((ls ?? []) as Line[]);
    setChecks((cks ?? []) as Check[]);
    if (!selectedCustomer && ls && ls.length > 0) {
      setSelectedCustomer((ls[0] as Line).customer_id);
    }
  }

  useEffect(() => {
    loadProgramsAndRuns();
  }, []);

  useEffect(() => {
    if (currentRunId) loadRunDetail(currentRunId);
  }, [currentRunId]);

  // Default quarter date range from picker
  useEffect(() => {
    const q = QUARTERS.find((q) => q.label === quarterLabel);
    if (q) {
      setDateFrom(q.from);
      setDateTo(q.toExclusive);
    }
  }, [quarterLabel]);

  const currentRun = runs.find((r) => r.id === currentRunId) ?? null;
  const isLocked =
    !!currentRun && (currentRun.status === "approved" || currentRun.status === "sent_to_ap");

  const customerSummary = useMemo(() => {
    const map = new Map<
      string,
      { rows: number; spiff: number; unmatched: number; errored: boolean; aging: number }
    >();
    for (const p of programs) {
      map.set(p.customer_id, {
        rows: 0,
        spiff: 0,
        unmatched: 0,
        errored: false,
        aging: 0,
      });
    }
    for (const l of lines) {
      const s = map.get(l.customer_id);
      if (!s) continue;
      s.rows++;
      if (l.included) s.spiff += Number(l.spiff_amount || 0);
      if (l.rep_parse_confidence === "unmatched" && l.included) s.unmatched++;
    }
    const totals = currentRun?.totals ?? {};
    const errs = (totals.errors ?? {}) as Record<string, string>;
    const aging = (totals.aging ?? {}) as Record<string, number> | { error: string };
    for (const p of programs) {
      const s = map.get(p.customer_id)!;
      if (errs[p.customer_id]) s.errored = true;
      if (aging && typeof aging === "object" && !("error" in aging)) {
        s.aging = Number((aging as Record<string, number>)[p.customer_id] ?? 0);
      }
    }
    return map;
  }, [lines, programs, currentRun]);

  const customerLines = useMemo(
    () => lines.filter((l) => l.customer_id === selectedCustomer),
    [lines, selectedCustomer]
  );

  const selectedProgram = useMemo(
    () => programs.find((p) => p.customer_id === selectedCustomer) ?? null,
    [programs, selectedCustomer]
  );

  const repsSeen = useMemo(() => {
    const s = new Set<string>();
    for (const l of lines) if (l.writing_rep) s.add(l.writing_rep);
    return Array.from(s).sort();
  }, [lines]);

  async function handleGenerate() {
    if (!user) return;
    setGenerating(true);
    try {
      const res = await generate({ data: { quarterLabel, dateFrom, dateTo } });
      toast.success(
        `Generated SPIFF run for ${quarterLabel}` +
          (Object.keys(res.errors).length ? ` (${Object.keys(res.errors).length} customer errors)` : "")
      );
      await loadProgramsAndRuns();
      setCurrentRunId(res.runId);
    } catch (e: any) {
      toast.error(e?.message ?? "Generate failed");
    } finally {
      setGenerating(false);
    }
  }

  // Debounced auto-rebuild of checks after line edits.
  const rebuildTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleRebuild() {
    if (!currentRunId || isLocked) return;
    if (rebuildTimer.current) clearTimeout(rebuildTimer.current);
    rebuildTimer.current = setTimeout(async () => {
      try {
        await rebuild({ data: { runId: currentRunId } });
        // Re-fetch just the checks (cheap) so the payee card updates.
        const { data: cks } = await supabase
          .from("spiff_checks")
          .select("*")
          .eq("run_id", currentRunId)
          .limit(5000);
        setChecks((cks ?? []) as Check[]);
      } catch (e: any) {
        toast.error(e?.message ?? "Auto-rebuild failed");
      }
    }, 400);
  }

  async function updateLine(lineId: string, patch: Partial<Line>) {
    if (isLocked || !currentRunId) return;
    const { error } = await supabase.from("spiff_run_lines").update(patch).eq("id", lineId);
    if (error) {
      toast.error(error.message);
      return;
    }
    setLines((ls) => ls.map((l) => (l.id === lineId ? { ...l, ...patch } : l)));
    scheduleRebuild();
  }

  async function reassignRep(line: Line, newRep: string) {
    const v = newRep.trim();
    await updateLine(line.id, {
      writing_rep: v || null,
      rep_parse_confidence: "manual",
    });
  }

  async function toggleIncluded(line: Line, reason?: string) {
    await updateLine(line.id, {
      included: !line.included,
      exclusion_reason: !line.included ? null : reason ?? "manual",
    });
  }

  async function handleRebuildChecks() {
    if (!currentRunId) return;
    try {
      const res = await rebuild({ data: { runId: currentRunId } });
      toast.success(`Checks rebuilt (${res.rebuilt} payees)`);
      await loadRunDetail(currentRunId);
    } catch (e: any) {
      toast.error(e?.message ?? "Rebuild failed");
    }
  }

  async function approveCheck(checkId: string) {
    if (isLocked) return;
    await supabase
      .from("spiff_checks")
      .update({ status: "approved", approved_by: user?.id, approved_at: new Date().toISOString() })
      .eq("id", checkId);
    if (currentRunId) loadRunDetail(currentRunId);
  }

  async function markRunApproved() {
    if (!currentRunId) return;
    const unassigned = checks.some((c) => c.payee === "(Unassigned)");
    if (unassigned) {
      toast.error("Resolve (Unassigned) payees before approving the run.");
      return;
    }
    const allApproved = checks.every((c) => c.status === "approved");
    if (!allApproved) {
      toast.error("Approve every check first.");
      return;
    }
    await supabase.from("spiff_runs").update({ status: "approved" }).eq("id", currentRunId);
    toast.success("Run approved");
    loadProgramsAndRuns();
  }

  async function handleDownload() {
    if (!currentRunId) return;
    try {
      const res = await downloadFn({ data: { runId: currentRunId } });
      const bin = atob(res.contentBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: res.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e?.message ?? "Download failed");
    }
  }

  async function handleSendApproval() {
    if (!currentRunId) return;
    if (!confirm(`Email approval requests to each rep org's contacts for ${currentRun?.quarter_label}?`)) return;
    try {
      const res = await sendApprovalFn({ data: { runId: currentRunId } });
      const skippedTxt = res.skipped.length
        ? ` · skipped: ${res.skipped.map((s) => `${s.rep_org} (${s.reason})`).join(", ")}`
        : "";
      toast.success(`Approval emails sent to ${res.sent.length} rep org${res.sent.length === 1 ? "" : "s"}${skippedTxt}`);
      loadProgramsAndRuns();
    } catch (e: any) {
      toast.error(e?.message ?? "Send failed");
    }
  }

  async function handleSendAp() {
    if (!currentRunId) return;
    if (!confirm(`Send the approved ${currentRun?.quarter_label} SPIFF run to AP?`)) return;
    try {
      const res = await sendApFn({ data: { runId: currentRunId } });
      toast.success(`Sent to AP (${res.to.length} recipient${res.to.length === 1 ? "" : "s"}, ${res.payeeCount} payees)`);
      loadProgramsAndRuns();
      if (currentRunId) loadRunDetail(currentRunId);
    } catch (e: any) {
      toast.error(e?.message ?? "Send failed");
    }
  }

  return (
    <div>
      <ModuleHeader
        title="SPIFF Management"
        description="Quarterly dealer SPIFF — pulled from P21, grouped by writing rep."
        actions={
          <>
            <select
              className="border rounded-md px-3 py-1.5 text-sm bg-card"
              value={quarterLabel}
              onChange={(e) => setQuarterLabel(e.target.value)}
            >
              {QUARTERS.map((q) => (
                <option key={q.label}>{q.label}</option>
              ))}
            </select>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-[150px]"
            />
            <span className="text-xs text-muted-foreground">→ &lt;</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-[150px]"
            />
            <Button onClick={handleGenerate} disabled={generating}>
              {generating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              Generate from P21
            </Button>
            <select
              className="border rounded-md px-3 py-1.5 text-sm bg-card"
              value={currentRunId ?? ""}
              onChange={(e) => setCurrentRunId(e.target.value || null)}
            >
              <option value="">— select run —</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.quarter_label} · {r.status} · {new Date(r.created_at).toLocaleDateString()}
                </option>
              ))}
            </select>
            {currentRun && (
              <>
                <Badge variant={isLocked ? "default" : "secondary"}>{currentRun.status}</Badge>
                <Button variant="outline" size="sm" onClick={handleDownload} title="Download workbook">
                  <Download className="w-4 h-4 mr-1" /> Workbook
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSendApproval}
                  disabled={currentRun.status === "approved" || currentRun.status === "sent_to_ap"}
                  title="Email each rep org their customer sheets"
                >
                  <Mail className="w-4 h-4 mr-1" /> Send for approval
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSendAp}
                  disabled={currentRun.status !== "approved"}
                  title="Email full workbook to AP (run must be approved)"
                >
                  <Send className="w-4 h-4 mr-1" /> Send to AP
                </Button>
              </>
            )}
          </>
        }
      />

      {!currentRun ? (
        <Card className="p-6 text-sm text-muted-foreground">
          No SPIFF runs yet. Pick a quarter and click <b>Generate from P21</b>.
        </Card>
      ) : (
        <>
        <ExclusionRulesCard totals={currentRun.totals} />

        <Tabs defaultValue="review">
          <TabsList>
            <TabsTrigger value="review">Review</TabsTrigger>
            <TabsTrigger value="checks">Checks</TabsTrigger>
            <TabsTrigger value="programs">Programs</TabsTrigger>
          </TabsList>

          <TabsContent value="review">
            <div className="grid grid-cols-[280px_1fr] gap-4">
              {/* Customer rail */}
              <Card className="p-2 max-h-[70vh] overflow-auto">
                <div className="text-xs text-muted-foreground px-2 py-1">
                  {programs.length} programs
                </div>
                {programs.map((p) => {
                  const s = customerSummary.get(p.customer_id);
                  const active = selectedCustomer === p.customer_id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedCustomer(p.customer_id)}
                      className={`w-full text-left px-2 py-2 rounded-md text-sm hover:bg-muted ${
                        active ? "bg-muted" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium truncate">{p.customer_name}</div>
                        {s?.errored && (
                          <Badge variant="destructive" className="text-[10px]">
                            err
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                        <span>{s?.rows ?? 0} rows</span>
                        <span>·</span>
                        <span className="font-mono">{money(s?.spiff ?? 0)}</span>
                        {!!s?.unmatched && (
                          <span className="text-amber-600">⚠ {s.unmatched}</span>
                        )}
                        {!!s?.aging && s.aging > 0 && (
                          <span className="text-amber-600" title="Past due > 30">
                            <AlertTriangle className="inline w-3 h-3" />
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </Card>

              {/* Detail */}
              <div className="space-y-3 min-w-0">
                {selectedProgram && (
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-lg font-semibold">
                          {selectedProgram.customer_name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {selectedProgram.rep_org} · {(selectedProgram.rate * 100).toFixed(2)}%
                          · scope: {selectedProgram.product_scope}
                          {selectedProgram.exclude_special_orders && " · excl. special"}
                          · payout: {selectedProgram.payout_mode}
                          {selectedProgram.payee_name && ` → ${selectedProgram.payee_name}`}
                        </div>
                        {selectedProgram.notes && (
                          <div className="text-xs italic mt-1">{selectedProgram.notes}</div>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Customer total</div>
                        <div className="text-xl font-bold font-mono">
                          {money(
                            customerLines
                              .filter((l) => l.included)
                              .reduce((s, l) => s + Number(l.spiff_amount || 0), 0)
                          )}
                        </div>
                      </div>
                    </div>
                    {(() => {
                      const aging = currentRun?.totals?.aging;
                      if (aging && typeof aging === "object" && "error" in aging) {
                        return (
                          <div className="mt-2 text-xs text-amber-600">
                            AR aging unavailable: {String((aging as any).error)}
                          </div>
                        );
                      }
                      const past = Number(
                        (aging as Record<string, number> | undefined)?.[
                          selectedProgram.customer_id
                        ] ?? 0
                      );
                      if (past > 0)
                        return (
                          <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-flex items-center gap-2">
                            <AlertTriangle className="w-3 h-3" />
                            Past due 30+: {money(past)} — confirm with Jimmy Green
                          </div>
                        );
                      return null;
                    })()}
                  </Card>
                )}

                <Card className="p-0 overflow-auto max-h-[60vh]">
                  <ReviewTable
                    lines={customerLines}
                    repsSeen={repsSeen}
                    isLocked={isLocked}
                    onReassign={reassignRep}
                    onToggle={toggleIncluded}
                  />
                </Card>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handleRebuildChecks} disabled={isLocked}>
                    Rebuild checks from edits
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="checks">
            <ChecksTab
              programs={programs}
              checks={checks}
              isLocked={isLocked}
              onApprove={approveCheck}
              onMarkRunApproved={markRunApproved}
            />
          </TabsContent>

          <TabsContent value="programs" className="space-y-4">
            <ProgramsEditor programs={programs} onChanged={loadProgramsAndRuns} />
            <ContactsEditor />
            <AutomationCard />
          </TabsContent>
        </Tabs>
        </>
      )}

    </div>
  );
}

function ReviewTable({
  lines,
  repsSeen,
  isLocked,
  onReassign,
  onToggle,
}: {
  lines: Line[];
  repsSeen: string[];
  isLocked: boolean;
  onReassign: (l: Line, v: string) => void;
  onToggle: (l: Line) => void;
}) {
  // Group by writing_rep (Unassigned at bottom).
  const groups = useMemo(() => {
    const m = new Map<string, Line[]>();
    for (const l of lines) {
      const key = l.writing_rep ?? "(Unassigned)";
      const arr = m.get(key) ?? [];
      arr.push(l);
      m.set(key, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => {
      if (a === "(Unassigned)") return 1;
      if (b === "(Unassigned)") return -1;
      return a.localeCompare(b);
    });
  }, [lines]);

  if (lines.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No lines for this customer.</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Order Date</TableHead>
          <TableHead>Invoice Date</TableHead>
          <TableHead>Order No</TableHead>
          <TableHead>PO Number</TableHead>
          <TableHead>Item</TableHead>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Unit</TableHead>
          <TableHead className="text-right">Extended</TableHead>
          <TableHead className="text-right">SPIFF</TableHead>
          <TableHead>Rep</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map(([rep, rows]) => {
          const subtotal = rows.filter((r) => r.included).reduce((s, r) => s + Number(r.spiff_amount || 0), 0);
          return (
            <ReviewGroup
              key={rep}
              rep={rep}
              rows={rows}
              subtotal={subtotal}
              repsSeen={repsSeen}
              isLocked={isLocked}
              onReassign={onReassign}
              onToggle={onToggle}
            />
          );
        })}
      </TableBody>
    </Table>
  );
}

function ReviewGroup({
  rep,
  rows,
  subtotal,
  repsSeen,
  isLocked,
  onReassign,
  onToggle,
}: {
  rep: string;
  rows: Line[];
  subtotal: number;
  repsSeen: string[];
  isLocked: boolean;
  onReassign: (l: Line, v: string) => void;
  onToggle: (l: Line) => void;
}) {
  return (
    <>
      <TableRow className="bg-muted/40">
        <TableCell colSpan={11} className="font-semibold">
          {rep} ({rows.length} lines)
        </TableCell>
      </TableRow>
      {rows.map((l) => (
        <TableRow
          key={l.id}
          className={!l.included ? "opacity-50 line-through" : ""}
        >
          <TableCell className="whitespace-nowrap text-xs">
            {l.order_date ? new Date(l.order_date).toLocaleDateString() : "—"}
          </TableCell>
          <TableCell className="text-xs">
            {l.order_no}
            {l.flags?.validation_warning && (
              <Badge variant="outline" className="ml-1 text-[10px] border-amber-500 text-amber-700" title={String(l.flags.validation_warning)}>
                ⚠ {String(l.flags.validation_warning).slice(0, 14)}
              </Badge>
            )}
          </TableCell>
          <TableCell className="text-xs max-w-[200px] truncate" title={l.po_no ?? ""}>
            {l.po_no}
          </TableCell>
          <TableCell className="text-xs">{l.item_id}</TableCell>
          <TableCell className="text-xs max-w-[260px] truncate" title={l.item_desc ?? ""}>
            {l.item_desc}
          </TableCell>
          <TableCell className="text-right text-xs">{Number(l.qty_ordered ?? 0)}</TableCell>
          <TableCell className="text-right text-xs">{money(l.unit_price)}</TableCell>
          <TableCell className="text-right text-xs font-mono">{money(l.extended_price)}</TableCell>
          <TableCell className="text-right text-xs font-mono">{money(l.spiff_amount)}</TableCell>
          <TableCell>
            <RepCombo
              value={l.writing_rep ?? ""}
              options={repsSeen}
              disabled={isLocked}
              onChange={(v) => onReassign(l, v)}
            />
          </TableCell>
          <TableCell>
            <Button
              size="sm"
              variant="ghost"
              disabled={isLocked}
              onClick={() => onToggle(l)}
              title={l.included ? "Exclude" : "Include"}
            >
              {l.included ? "Excl." : "Incl."}
            </Button>
          </TableCell>
        </TableRow>
      ))}
      <TableRow>
        <TableCell colSpan={8} className="text-right font-semibold">
          Subtotal — {rep}
        </TableCell>
        <TableCell className="text-right font-mono font-semibold">{money(subtotal)}</TableCell>
        <TableCell colSpan={2} />
      </TableRow>
    </>
  );
}

function RepCombo({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <button
        className="text-xs underline-offset-2 hover:underline disabled:no-underline disabled:opacity-60"
        disabled={disabled}
        onClick={() => setEditing(true)}
      >
        {value || <span className="italic text-amber-600">(unassigned)</span>}
        <Pencil className="inline w-3 h-3 ml-1 opacity-50" />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <input
        list="reps-datalist"
        autoFocus
        className="border rounded px-1 py-0.5 text-xs w-[140px]"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onChange(draft);
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
            setDraft(value);
          }
        }}
        onBlur={() => {
          onChange(draft);
          setEditing(false);
        }}
      />
      <datalist id="reps-datalist">
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}

function ChecksTab({
  programs,
  checks,
  isLocked,
  onApprove,
  onMarkRunApproved,
}: {
  programs: Program[];
  checks: Check[];
  isLocked: boolean;
  onApprove: (id: string) => void;
  onMarkRunApproved: () => void;
}) {
  const progById = new Map(programs.map((p) => [p.id, p]));
  const byOrg = new Map<string, Check[]>();
  for (const c of checks) {
    const p = progById.get(c.program_id);
    const org = p?.rep_org ?? "—";
    const arr = byOrg.get(org) ?? [];
    arr.push(c);
    byOrg.set(org, arr);
  }
  const orgs = Array.from(byOrg.entries()).sort();
  const allApproved = checks.length > 0 && checks.every((c) => c.status === "approved");
  const hasUnassigned = checks.some((c) => c.payee === "(Unassigned)");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          onClick={onMarkRunApproved}
          disabled={isLocked || !allApproved || hasUnassigned}
        >
          Mark run approved
        </Button>
      </div>
      {orgs.map(([org, list]) => (
        <Card key={org}>
          <div className="px-4 py-2 font-semibold border-b">{org}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Payee</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((c) => {
                const p = progById.get(c.program_id);
                return (
                  <TableRow
                    key={c.id}
                    className={c.below_minimum ? "text-muted-foreground" : ""}
                  >
                    <TableCell className="text-xs">{p?.customer_name}</TableCell>
                    <TableCell>
                      {c.payee}
                      {c.payee === "(Unassigned)" && (
                        <Badge variant="destructive" className="ml-2 text-[10px]">
                          fix
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{c.line_count}</TableCell>
                    <TableCell className="text-right font-mono">{money(c.amount)}</TableCell>
                    <TableCell>
                      <Badge variant={c.status === "approved" ? "default" : "secondary"}>
                        {c.status}
                      </Badge>
                      {c.below_minimum && (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          No check — under ${Number(p?.min_check_amount ?? 8)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {c.status !== "approved" && (
                        <Button
                          size="sm"
                          disabled={isLocked || c.payee === "(Unassigned)"}
                          onClick={() => onApprove(c.id)}
                        >
                          Approve
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      ))}
    </div>
  );
}

function ProgramsEditor({
  programs,
  onChanged,
}: {
  programs: Program[];
  onChanged: () => void;
}) {
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Program>>({});

  function startEdit(p: Program) {
    setEditId(p.id);
    setDraft(p);
  }
  async function save() {
    if (!editId) return;
    const payload = { ...draft };
    delete (payload as any).id;
    delete (payload as any).created_at;
    delete (payload as any).updated_at;
    const { error } = await supabase.from("spiff_programs").update(payload).eq("id", editId);
    if (error) return toast.error(error.message);
    toast.success("Saved");
    setEditId(null);
    onChanged();
  }
  async function toggleActive(p: Program) {
    await supabase.from("spiff_programs").update({ active: !p.active }).eq("id", p.id);
    onChanged();
  }

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer ID</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Rep Org</TableHead>
            <TableHead className="text-right">Rate</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Payout</TableHead>
            <TableHead>Payee</TableHead>
            <TableHead className="text-right">Min $</TableHead>
            <TableHead>Active</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {programs.map((p) =>
            editId === p.id ? (
              <TableRow key={p.id} className="bg-muted/30">
                <TableCell className="text-xs">{p.customer_id}</TableCell>
                <TableCell>
                  <Input
                    value={draft.customer_name ?? ""}
                    onChange={(e) => setDraft({ ...draft, customer_name: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    value={draft.rep_org ?? ""}
                    onChange={(e) => setDraft({ ...draft, rep_org: e.target.value })}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    step="0.001"
                    value={Number(draft.rate ?? 0)}
                    onChange={(e) => setDraft({ ...draft, rate: Number(e.target.value) })}
                  />
                </TableCell>
                <TableCell>
                  <select
                    className="border rounded px-2 py-1 text-sm bg-card"
                    value={draft.product_scope ?? "all"}
                    onChange={(e) =>
                      setDraft({ ...draft, product_scope: e.target.value as any })
                    }
                  >
                    <option value="all">all</option>
                    <option value="pl_ryker_jax">pl_ryker_jax</option>
                    <option value="pl_ryker_jax_no_seating">pl_ryker_jax_no_seating</option>
                  </select>
                </TableCell>
                <TableCell>
                  <select
                    className="border rounded px-2 py-1 text-sm bg-card"
                    value={draft.payout_mode ?? "per_writing_rep"}
                    onChange={(e) =>
                      setDraft({ ...draft, payout_mode: e.target.value as any })
                    }
                  >
                    <option value="per_writing_rep">per_writing_rep</option>
                    <option value="single_check">single_check</option>
                  </select>
                </TableCell>
                <TableCell>
                  <Input
                    value={draft.payee_name ?? ""}
                    onChange={(e) => setDraft({ ...draft, payee_name: e.target.value })}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    step="0.01"
                    value={Number(draft.min_check_amount ?? 8)}
                    onChange={(e) =>
                      setDraft({ ...draft, min_check_amount: Number(e.target.value) })
                    }
                  />
                </TableCell>
                <TableCell>
                  <input
                    type="checkbox"
                    checked={!!draft.active}
                    onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                  />
                </TableCell>
                <TableCell>
                  <Button size="sm" onClick={save}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditId(null)}>
                    Cancel
                  </Button>
                </TableCell>
              </TableRow>
            ) : (
              <TableRow key={p.id}>
                <TableCell className="text-xs">{p.customer_id}</TableCell>
                <TableCell>{p.customer_name}</TableCell>
                <TableCell>{p.rep_org}</TableCell>
                <TableCell className="text-right">{(p.rate * 100).toFixed(2)}%</TableCell>
                <TableCell className="text-xs">{p.product_scope}</TableCell>
                <TableCell className="text-xs">{p.payout_mode}</TableCell>
                <TableCell className="text-xs">{p.payee_name ?? "—"}</TableCell>
                <TableCell className="text-right">${Number(p.min_check_amount)}</TableCell>
                <TableCell>
                  <button onClick={() => toggleActive(p)}>
                    {p.active ? (
                      <Badge>Active</Badge>
                    ) : (
                      <Badge variant="outline">Off</Badge>
                    )}
                  </button>
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" onClick={() => startEdit(p)}>
                    <Pencil className="w-3 h-3" />
                  </Button>
                </TableCell>
              </TableRow>
            )
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

// ====== Contacts CRUD ======

type Contact = {
  id: string;
  kind: "salesrep_approver" | "ap";
  label: string;
  email: string;
  active: boolean;
};

function ContactsEditor() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [draft, setDraft] = useState<{ kind: Contact["kind"]; label: string; email: string }>({
    kind: "salesrep_approver",
    label: "",
    email: "",
  });

  async function load() {
    const { data } = await supabase.from("spiff_contacts").select("*").order("kind").order("label");
    setContacts((data ?? []) as Contact[]);
  }
  useEffect(() => {
    load();
  }, []);

  async function add() {
    if (!draft.email.trim()) return toast.error("Email is required");
    if (!draft.label.trim()) return toast.error("Label is required");
    const { error } = await supabase
      .from("spiff_contacts")
      .insert({ kind: draft.kind, label: draft.label.trim(), email: draft.email.trim(), active: true });
    if (error) return toast.error(error.message);
    setDraft({ kind: draft.kind, label: "", email: "" });
    load();
  }
  async function toggle(c: Contact) {
    await supabase.from("spiff_contacts").update({ active: !c.active }).eq("id", c.id);
    load();
  }
  async function remove(c: Contact) {
    if (!confirm(`Remove ${c.email}?`)) return;
    await supabase.from("spiff_contacts").delete().eq("id", c.id);
    load();
  }

  return (
    <Card>
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div>
          <div className="font-semibold">Distribution Contacts</div>
          <div className="text-xs text-muted-foreground">
            Salesrep approvers (label = rep_org, must match Programs exactly) and AP recipients.
          </div>
        </div>
      </div>
      <div className="p-4 flex flex-wrap items-end gap-2 border-b">
        <select
          className="border rounded-md px-2 py-1.5 text-sm bg-card"
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as any })}
        >
          <option value="salesrep_approver">salesrep_approver</option>
          <option value="ap">ap</option>
        </select>
        <Input
          placeholder={draft.kind === "ap" ? "AP" : "rep_org (e.g. IAI Joe Perry)"}
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          className="w-[240px]"
        />
        <Input
          type="email"
          placeholder="email@example.com"
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
          className="w-[260px]"
        />
        <Button size="sm" onClick={add}>
          Add contact
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Active</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {contacts.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="text-xs">{c.kind}</TableCell>
              <TableCell>{c.label}</TableCell>
              <TableCell className="text-xs">{c.email}</TableCell>
              <TableCell>
                <button onClick={() => toggle(c)}>
                  {c.active ? <Badge>Active</Badge> : <Badge variant="outline">Off</Badge>}
                </button>
              </TableCell>
              <TableCell>
                <Button size="sm" variant="ghost" onClick={() => remove(c)}>
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {contacts.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-4">
                No contacts yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

// ====== Automation ======

type Automation = {
  id: string;
  enabled: boolean;
  day_of_month: number;
  send_hour: number;
  timezone: string;
  send_approvals: boolean;
  last_auto_quarter: string | null;
  last_auto_run_at: string | null;
  last_auto_status: string | null;
  last_auto_error: string | null;
};

function AutomationCard() {
  const [cfg, setCfg] = useState<Automation | null>(null);

  async function load() {
    const { data } = await supabase.from("spiff_automation").select("*").limit(1).maybeSingle();
    setCfg((data as Automation) ?? null);
  }
  useEffect(() => {
    load();
  }, []);

  async function update(patch: Partial<Automation>) {
    if (!cfg) return;
    const { error } = await supabase.from("spiff_automation").update(patch).eq("id", cfg.id);
    if (error) return toast.error(error.message);
    setCfg({ ...cfg, ...patch } as Automation);
  }

  if (!cfg) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">Automation settings unavailable.</Card>
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">Automation</div>
          <div className="text-xs text-muted-foreground">
            Auto-generates the just-ended quarter's SPIFF and (optionally) emails approvals.
            Runs through the existing scheduler — fires when it's the configured day-of-month at the configured hour
            in the configured timezone, and skips if it already ran for that quarter. Never auto-sends to AP.
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Day of month</span>
          <Input
            type="number"
            min={1}
            max={28}
            className="w-[100px]"
            value={cfg.day_of_month}
            onChange={(e) => update({ day_of_month: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Hour (0-23)</span>
          <Input
            type="number"
            min={0}
            max={23}
            className="w-[100px]"
            value={cfg.send_hour}
            onChange={(e) => update({ send_hour: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Timezone</span>
          <Input
            className="w-[200px]"
            value={cfg.timezone}
            onChange={(e) => update({ timezone: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 mb-1">
          <input
            type="checkbox"
            checked={cfg.send_approvals}
            onChange={(e) => update({ send_approvals: e.target.checked })}
          />
          Also send approval emails
        </label>
      </div>
      <div className="text-xs text-muted-foreground">
        Last auto run:{" "}
        {cfg.last_auto_run_at
          ? `${new Date(cfg.last_auto_run_at).toLocaleString()} · ${cfg.last_auto_quarter ?? "?"} · ${cfg.last_auto_status ?? "?"}`
          : "never"}
        {cfg.last_auto_error && (
          <span className="text-red-600"> · {cfg.last_auto_error}</span>
        )}
      </div>
    </Card>
  );
}

function ExclusionRulesCard({ totals }: { totals: any }) {
  const rules: Array<{ code: string; label: string; where?: string }> = totals?.exclusion_rules ?? [];
  const counts: Record<string, number> = totals?.exclusion_counts ?? {};
  if (rules.length === 0) return null;
  const codeToCountKey = (code: string) =>
    code === "invoiced_only" ? "not_invoiced"
    : code === "no_quotes" ? "quote"
    : code === "no_cancelled" ? "cancelled"
    : code === "no_samples" ? "sample"
    : code === "no_catalogs" ? "catalog"
    : code;
  return (
    <Card className="p-4 mb-3">
      <div className="text-sm font-semibold mb-2">Exclusion rules applied to this run</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs">
        {rules.map((r) => {
          const key = codeToCountKey(r.code);
          const n = Number(counts[key] ?? 0);
          return (
            <div key={r.code} className="flex justify-between gap-4 border-b border-border/40 py-1">
              <span>{r.label}</span>
              <span className="font-mono text-muted-foreground">
                {n > 0 ? `${n.toLocaleString()} excluded` : "—"}
              </span>
            </div>
          );
        })}
      </div>
      <div className="text-[11px] text-muted-foreground mt-2">
        Quotes are hard-filtered in SQL (no per-line rows); other exclusions are stored as{" "}
        <code>spiff_run_lines</code> with <code>included=false</code> for auditability.
      </div>
    </Card>
  );
}


