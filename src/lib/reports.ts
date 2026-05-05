import { supabase } from "@/integrations/supabase/client";
import { startOfDay, subDays, startOfMonth, subMonths, endOfMonth, endOfDay, format } from "date-fns";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export type ReportType = "orders" | "ar_aging" | "spiff" | "fleet" | "damage";
export type DateRangePreset = "today" | "last_7_days" | "last_30_days" | "month_to_date" | "last_month" | "last_quarter" | "all_time";
export type ReportFormat = "csv" | "pdf";

export const REPORT_TYPES: { value: ReportType; label: string; roles: string[] }[] = [
  { value: "orders", label: "Orders", roles: ["ops_orders", "admin"] },
  { value: "ar_aging", label: "AR Aging", roles: ["ops_ar", "admin"] },
  { value: "spiff", label: "SPIFF Calculations", roles: ["ops_ar", "admin"] },
  { value: "fleet", label: "Fleet Loads", roles: ["ops_logistics", "admin"] },
  { value: "damage", label: "Damage Reports", roles: ["ops_logistics", "admin"] },
];

export const DATE_RANGES: { value: DateRangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "month_to_date", label: "Month to date" },
  { value: "last_month", label: "Last month" },
  { value: "last_quarter", label: "Last quarter (90d)" },
  { value: "all_time", label: "All time" },
];

export function resolveRange(preset: DateRangePreset): { from: Date | null; to: Date } {
  const now = new Date();
  switch (preset) {
    case "today": return { from: startOfDay(now), to: now };
    case "last_7_days": return { from: subDays(startOfDay(now), 7), to: now };
    case "last_30_days": return { from: subDays(startOfDay(now), 30), to: now };
    case "month_to_date": return { from: startOfMonth(now), to: now };
    case "last_month": { const lm = subMonths(now, 1); return { from: startOfMonth(lm), to: endOfMonth(lm) }; }
    case "last_quarter": return { from: subDays(startOfDay(now), 90), to: now };
    case "all_time": return { from: null, to: now };
  }
}

type DatasetSpec = { table: string; dateColumn: string; columns: { key: string; label: string }[] };

const SPECS: Record<ReportType, DatasetSpec> = {
  orders: { table: "orders", dateColumn: "created_at", columns: [
    { key: "created_at", label: "Created" },
    { key: "po_number", label: "PO #" },
    { key: "customer_name", label: "Customer" },
    { key: "status", label: "Status" },
    { key: "ai_confidence", label: "AI Conf." },
    { key: "p21_order_id", label: "P21 ID" },
  ]},
  ar_aging: { table: "ar_aging", dateColumn: "synced_at", columns: [
    { key: "invoice_number", label: "Invoice" },
    { key: "customer_name", label: "Customer" },
    { key: "amount_due", label: "Amount Due" },
    { key: "days_past_due", label: "Days Past Due" },
    { key: "bucket", label: "Bucket" },
    { key: "collection_status", label: "Status" },
  ]},
  spiff: { table: "spiff_calculations", dateColumn: "created_at", columns: [
    { key: "quarter", label: "Quarter" },
    { key: "customer_name", label: "Customer" },
    { key: "sales_rep", label: "Rep" },
    { key: "gross_sales", label: "Gross Sales" },
    { key: "spiff_amount", label: "SPIFF" },
    { key: "status", label: "Status" },
  ]},
  fleet: { table: "fleet_loads", dateColumn: "created_at", columns: [
    { key: "route_code", label: "Route" },
    { key: "truck_id", label: "Truck" },
    { key: "driver_name", label: "Driver" },
    { key: "departure_date", label: "Departs" },
    { key: "capacity_pct", label: "Capacity %" },
    { key: "status", label: "Status" },
  ]},
  damage: { table: "damage_reports", dateColumn: "created_at", columns: [
    { key: "created_at", label: "Reported" },
    { key: "p21_order_id", label: "P21 ID" },
    { key: "stage", label: "Stage" },
    { key: "severity", label: "Severity" },
    { key: "driver_name", label: "Driver" },
    { key: "status", label: "Status" },
  ]},
};

export async function fetchReportRows(type: ReportType, preset: DateRangePreset, filters: Record<string, any> = {}) {
  const spec = SPECS[type];
  const { from, to } = resolveRange(preset);
  let q: any = supabase.from(spec.table as any).select("*").order(spec.dateColumn, { ascending: false }).limit(5000);
  if (from) q = q.gte(spec.dateColumn, from.toISOString());
  q = q.lte(spec.dateColumn, to.toISOString());
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.bucket && type === "ar_aging") q = q.eq("bucket", filters.bucket);
  const { data, error } = await q;
  if (error) throw error;
  return { rows: (data ?? []) as any[], spec, from, to };
}

function fmtCell(v: any) {
  if (v == null) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return format(new Date(v), "yyyy-MM-dd HH:mm");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function downloadCsv(filename: string, columns: { key: string; label: string }[], rows: any[]) {
  const header = columns.map((c) => `"${c.label}"`).join(",");
  const body = rows.map((r) => columns.map((c) => `"${fmtCell(r[c.key]).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([header + "\n" + body], { type: "text/csv" });
  triggerDownload(blob, filename);
}

export function downloadPdf(title: string, subtitle: string, columns: { key: string; label: string }[], rows: any[]) {
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(16); doc.text(title, 14, 16);
  doc.setFontSize(10); doc.setTextColor(100); doc.text(subtitle, 14, 22);
  autoTable(doc, {
    startY: 28,
    head: [columns.map((c) => c.label)],
    body: rows.map((r) => columns.map((c) => fmtCell(r[c.key]))),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 58, 95] },
  });
  doc.save(`${title.replace(/\s+/g, "_")}_${format(new Date(), "yyyyMMdd_HHmm")}.pdf`);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export async function generateAndExport(opts: {
  name: string;
  type: ReportType;
  preset: DateRangePreset;
  format: ReportFormat;
  filters?: Record<string, any>;
}) {
  const { rows, spec, from, to } = await fetchReportRows(opts.type, opts.preset, opts.filters ?? {});
  const range = `${from ? format(from, "yyyy-MM-dd") : "all"} → ${format(to, "yyyy-MM-dd")}`;
  const subtitle = `${REPORT_TYPES.find((t) => t.value === opts.type)?.label} · ${range} · ${rows.length} rows`;
  const fname = `${opts.name.replace(/\s+/g, "_")}_${format(new Date(), "yyyyMMdd_HHmm")}.${opts.format}`;
  if (opts.format === "pdf") downloadPdf(opts.name, subtitle, spec.columns, rows);
  else downloadCsv(fname, spec.columns, rows);
  return { rowCount: rows.length, range };
}
