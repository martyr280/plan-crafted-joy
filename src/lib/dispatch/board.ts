// Pure: vw_route_dispatch rows -> Upcoming runs / Stale / Unrouted / Date check.
// Client-safe (no I/O) so the page and tests share it.

import { assignRun, daysBetween, DATE_BASES, DATE_BASIS_COLUMN, type AssignCutoff, type DateBasis, type ExceptionReason, type NoRunException, type RolledFrom } from "./assign";
import { shortHoldReason, type P21DispatchRow } from "./build";

export const ALWAYS_EXCLUDED = ["WCALL", "LTL01"];

export type BoardCutoff = AssignCutoff & { route_id: string };
export type DemandRow = { route_id: string; ship_date: string; order_count: number | null; total_cube_ft: number | null; projected_capacity_frac: number | null; snapshot_at: string | null };

export type RunException = { id: string; p21_code: string; run_date: string; kind: "no_run" | "reduced"; reason: ExceptionReason; note: string | null; created_by: string | null; created_by_name?: string | null; created_at?: string | null };

export type TicketView = {
  pick_ticket_no: string | null;
  order_no: string | null;
  route_code: string | null;
  customer_name: string | null;
  ship2_city: string | null;
  ship2_state: string | null;
  print_date: string | null;
  earliest_required: string | null;
  latest_required: string | null;
  requested: string | null;
  promise: string | null;
  original_promise: string | null;
  est_cube_ft: number | null;
  est_weight_lbs: number | null;
  held: boolean;
  hold_reason: string | null;
  /** Run each basis would pick (date, "stale:<date>", or null). */
  runByBasis: Record<DateBasis, string | null>;
  bases_disagree: boolean;
  /** Set when a no_run exception moved this ticket (current basis). */
  rolled_from: RolledFrom | null;
};

export type UpcomingRun = {
  route_code: string;
  route_id: string | null;
  run_date: string;
  tickets: number;
  orders: number;
  held: number;
  est_cube_ft: number;
  missing_cube: number;
  est_weight_lbs: number;
  missing_weight: number;
  demand: { order_count: number | null; total_cube_ft: number | null; projected_capacity_frac: number | null; snapshot_at: string | null } | null;
  ticketList: TicketView[];
  exception: RunException | null;
};

export type StaleTicket = TicketView & { run_date: string; age_days: number | null };

export type DispatchBoard = {
  basis: DateBasis;
  today: string;
  totalRows: number;
  excluded: number;
  held: number;
  upcoming: UpcomingRun[];
  stale: StaleTicket[];
  unrouted: TicketView[];
  noCutoff: TicketView[];
  dateCheck: TicketView[];
  exceptions: RunException[];
};

const d10 = (v: unknown) => (v == null || v === "" ? null : String(v).slice(0, 10));
const numOrNull = (v: unknown) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export function buildDispatchBoard(
  rows: P21DispatchRow[],
  cutoffs: BoardCutoff[],
  demand: DemandRow[],
  opts: { basis: DateBasis; today: string; excludedCodes?: string[]; exceptions?: RunException[] },
): DispatchBoard {
  const excluded = new Set([...ALWAYS_EXCLUDED, ...(opts.excludedCodes ?? [])].map((c) => c.trim().toUpperCase()));
  const byCode = new Map<string, BoardCutoff[]>();
  for (const c of cutoffs) {
    if (!c.p21_code || c.active === false) continue;
    const k = c.p21_code.trim().toUpperCase();
    byCode.set(k, [...(byCode.get(k) ?? []), c]);
  }
  const excList = (opts.exceptions ?? []).map((e) => ({ ...e, p21_code: e.p21_code.trim().toUpperCase(), run_date: String(e.run_date).slice(0, 10) }));
  const excByKey = new Map(excList.map((e) => [`${e.p21_code}|${e.run_date}`, e]));
  const noRunsByCode = new Map<string, NoRunException[]>();
  for (const e of excList) if (e.kind === "no_run") noRunsByCode.set(e.p21_code, [...(noRunsByCode.get(e.p21_code) ?? []), { run_date: e.run_date, reason: e.reason }]);
  // Latest demand snapshot per (route, date).
  const demandKey = new Map<string, DemandRow>();
  for (const d of demand) {
    const k = `${d.route_id}|${d10(d.ship_date)}`;
    const cur = demandKey.get(k);
    if (!cur || String(d.snapshot_at ?? "") > String(cur.snapshot_at ?? "")) demandKey.set(k, d);
  }

  let excludedN = 0, heldN = 0;
  const runs = new Map<string, UpcomingRun>();
  const stale: StaleTicket[] = [], unrouted: TicketView[] = [], noCutoff: TicketView[] = [], dateCheck: TicketView[] = [];

  const ensureRun = (code: string, runDate: string): UpcomingRun => {
    const key = `${code}|${runDate}`;
    let run = runs.get(key);
    if (!run) {
      const routeId = byCode.get(code)?.[0]?.route_id ?? null;
      const dm = routeId ? demandKey.get(`${routeId}|${runDate}`) : undefined;
      run = {
        route_code: code, route_id: routeId, run_date: runDate, tickets: 0, orders: 0, held: 0,
        est_cube_ft: 0, missing_cube: 0, est_weight_lbs: 0, missing_weight: 0,
        demand: dm ? { order_count: dm.order_count, total_cube_ft: numOrNull(dm.total_cube_ft), projected_capacity_frac: numOrNull(dm.projected_capacity_frac), snapshot_at: dm.snapshot_at } : null,
        ticketList: [],
        exception: excByKey.get(key) ?? null,
      };
      runs.set(key, run);
    }
    return run;
  };

  for (const r of rows) {
    const code = r.route_code ? String(r.route_code).trim().toUpperCase() : "";
    if (code && excluded.has(code)) { excludedN++; continue; }
    const cs = code ? byCode.get(code) ?? [] : [];
    const nr = code ? noRunsByCode.get(code) ?? [] : [];
    const runByBasis = {} as Record<DateBasis, string | null>;
    for (const b of DATE_BASES) {
      const a = code ? assignRun((r as any)[DATE_BASIS_COLUMN[b]], cs, opts.today, nr) : { status: "no_cutoff" as const };
      runByBasis[b] = a.status === "assigned" ? a.runDate : a.status === "stale" ? `stale:${a.runDate}` : null;
    }
    const distinct = new Set(Object.values(runByBasis).map((v) => v ?? "—"));
    const reason = shortHoldReason(r);
    const t: TicketView = {
      pick_ticket_no: r.pick_ticket_no != null ? String(r.pick_ticket_no) : null,
      order_no: r.order_no != null ? String(r.order_no) : null,
      route_code: code || null,
      customer_name: r.customer_name,
      ship2_city: r.ship2_city,
      ship2_state: r.ship2_state,
      print_date: d10(r.pick_ticket_print_date),
      earliest_required: d10(r.earliest_required_date),
      latest_required: d10(r.latest_required_date),
      requested: d10(r.requested_date),
      promise: d10(r.promise_date),
      original_promise: d10(r.original_promise_date),
      est_cube_ft: numOrNull(r.est_cube_ft),
      est_weight_lbs: numOrNull(r.est_weight_lbs),
      held: !!reason,
      hold_reason: reason,
      runByBasis,
      bases_disagree: distinct.size > 1,
      rolled_from: null,
    };
    if (t.held) heldN++;
    dateCheck.push(t);
    if (!code) { unrouted.push(t); continue; }
    const a = assignRun((r as any)[DATE_BASIS_COLUMN[opts.basis]], cs, opts.today, nr);
    if ((a.status === "assigned" || a.status === "stale") && a.rolledFrom) t.rolled_from = a.rolledFrom;
    if (a.status === "no_cutoff" || a.status === "no_date") { noCutoff.push(t); continue; }
    if (a.status === "stale") {
      const basisDate = d10((r as any)[DATE_BASIS_COLUMN[opts.basis]]);
      stale.push({ ...t, run_date: a.runDate, age_days: t.print_date ? daysBetween(t.print_date, opts.today) : basisDate ? daysBetween(basisDate, opts.today) : null });
      continue;
    }
    const key = `${code}|${a.runDate}`;
    const run = ensureRun(code, a.runDate);
    run.tickets++;
    if (t.held) run.held++;
    if (t.est_cube_ft == null) run.missing_cube++; else run.est_cube_ft += t.est_cube_ft;
    if (t.est_weight_lbs == null) run.missing_weight++; else run.est_weight_lbs += t.est_weight_lbs;
    run.ticketList.push(t);
  }
  // Every upcoming exception gets a row (a no_run shows 0 tickets so people see why).
  for (const e of excList) if (e.run_date >= opts.today && !excluded.has(e.p21_code)) ensureRun(e.p21_code, e.run_date);
  for (const run of runs.values()) run.orders = new Set(run.ticketList.map((t) => t.order_no)).size;

  return {
    basis: opts.basis,
    today: opts.today,
    totalRows: rows.length,
    excluded: excludedN,
    held: heldN,
    upcoming: [...runs.values()].sort((a, b) => a.run_date.localeCompare(b.run_date) || a.route_code.localeCompare(b.route_code)),
    stale: stale.sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0)),
    unrouted,
    noCutoff,
    dateCheck,
    exceptions: excList.filter((e) => e.run_date >= opts.today).sort((a, b) => a.run_date.localeCompare(b.run_date) || a.p21_code.localeCompare(b.p21_code)),
  };
}
