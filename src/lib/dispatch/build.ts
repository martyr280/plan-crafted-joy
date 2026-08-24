// Pure dispatch plan builder: P21 view rows -> DispatchPlan.
//
// Holds ride ON the plan. A stop we cannot dispatch (unmapped address, partial
// allocation) is never silently dropped — it is emitted with hold=true and a
// hold_reason so a human sees it in the review surface (build 2's UI).
//
// No I/O; deterministic. Identical inputs must produce a byte-identical plan.

import { isGeocodable, normalizeAddress, type RawAddress } from "./address-match";
import {
  sequenceStops,
  type SequenceConfig,
  type SequenceTemplateRow,
  type SequencedStop,
} from "./sequence";

/** Contract of p21_analytics_play.dbo.vw_route_dispatch. */
export type P21DispatchRow = {
  pick_ticket_no: string | null;
  order_no: string | null;
  route_code: string | null;
  ship_date: string | null;
  customer_id: string | null;
  customer_name: string | null;
  ship_to_id: string | null;
  ship2_name: string | null;
  ship2_addr1: string | null;
  ship2_addr2: string | null;
  ship2_city: string | null;
  ship2_state: string | null;
  ship2_zip: string | null;
  delivery_instructions: string | null;
  est_weight_lbs: number | null;
  est_cube_ft: number | null;
  est_pallets: number | null;
  line_count: number | null;
  total_lines_allocated: number | null;
  /** Not in the documented contract; honored when the view supplies it. */
  cancel_flag?: string | null;
};

export type AddressMapEntry = {
  p21_ship_to_id: string;
  samsara_address_id: string | null;
  verified: boolean;
};

export type CutoffWindow = {
  routeCode: string;
  /** Ship dates fed by the cutoff (from cutoffs.ts runDatesFor). */
  runDates: string[];
  /** ISO instant the cutoff fires. */
  cutoffAtIso: string;
  /** ISO instant after which the plan must not be modified. */
  lockAtIso: string | null;
};

export type DispatchPlanStop = {
  position: number;
  runDay: string;
  pickTicketNo: string | null;
  orderNo: string | null;
  customerId: string | null;
  customerName: string | null;
  p21ShipToId: string | null;
  samsaraAddressId: string | null;
  scheduledArrival: string;
  stopNotes: string | null;
  estPallets: number;
  estCubeFt: number;
  estWeightLbs: number;
  hold: boolean;
  holdReason: string | null;
  state: string | null;
  unslotted: boolean;
};

export type DispatchPlanRun = {
  routeCode: string;
  runDate: string;
  runSeq: number;
  externalId: string;
  cutoffAtIso: string;
  lockAtIso: string | null;
  stops: DispatchPlanStop[];
  holds: DispatchPlanStop[];
  totals: {
    ordersTotal: number;
    stopsTotal: number;
    stopsHeld: number;
    estPallets: number;
    estCubeFt: number;
    estWeightLbs: number;
  };
};

export type DispatchPlan = { runs: DispatchPlanRun[] };

export type BuildConfig = SequenceConfig & { runSeq?: number };

export function externalIdFor(routeCode: string, runDate: string, runSeq: number): string {
  return `nelsonDispatch:${routeCode}:${runDate}:${runSeq}`;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isCancelled(row: P21DispatchRow): boolean {
  const f = String(row.cancel_flag ?? "").trim().toUpperCase();
  return f === "Y" || f === "1" || f === "TRUE";
}

function rawAddressOf(row: P21DispatchRow): RawAddress {
  return {
    addr1: row.ship2_addr1,
    addr2: row.ship2_addr2,
    city: row.ship2_city,
    state: row.ship2_state,
    zip: row.ship2_zip,
  };
}

function rawAddressText(row: P21DispatchRow): string {
  const n = normalizeAddress(rawAddressOf(row));
  return [row.ship2_name, row.ship2_addr1, row.ship2_addr2, `${n.city} ${n.state} ${n.zip}`.trim()]
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

type Candidate = {
  id: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  customerName: string | null;
  row: P21DispatchRow;
  samsaraAddressId: string | null;
  hold: boolean;
  holdReason: string | null;
  stopNotes: string | null;
};

/**
 * Build a plan directly from rows. This is the entry point used by tests and by
 * a future fixtures-preview mode; the server wrapper adds the bridge fetch.
 */
export function buildDispatchPlanFromRows(
  rows: P21DispatchRow[],
  addressMap: AddressMapEntry[],
  template: SequenceTemplateRow[],
  cutoff: CutoffWindow,
  config: BuildConfig,
): DispatchPlan {
  const mapByShipTo = new Map(addressMap.map((m) => [String(m.p21_ship_to_id), m]));
  const runSeq = config.runSeq ?? 1;

  const candidates: Candidate[] = [];
  for (const row of rows) {
    if (isCancelled(row)) continue;
    if (num(row.line_count) <= 0) continue;

    const shipTo = row.ship_to_id != null ? String(row.ship_to_id) : "";
    const mapped = shipTo ? mapByShipTo.get(shipTo) ?? null : null;
    const usableAddressId = mapped?.verified && mapped.samsara_address_id ? mapped.samsara_address_id : null;

    let hold = false;
    let holdReason: string | null = null;
    const notes: string[] = [];

    if (num(row.total_lines_allocated) < num(row.line_count)) {
      hold = true;
      holdReason = "partial_allocation";
      notes.push(
        `Partial allocation: ${num(row.total_lines_allocated)} of ${num(row.line_count)} lines allocated`,
      );
    }

    if (!usableAddressId) {
      // Unmapped beats partial allocation: without an address there is nothing
      // to dispatch at all. The raw address text is preserved so the reviewer
      // can map it without going back to P21.
      hold = true;
      holdReason = "unmapped_address";
      notes.push(`Unmapped address: ${rawAddressText(row)}`);
      if (!isGeocodable(rawAddressOf(row))) notes.push("Address lacks enough detail to geocode");
    }

    if (row.delivery_instructions) notes.push(String(row.delivery_instructions).trim());

    candidates.push({
      id: `${row.order_no ?? ""}|${shipTo}|${row.pick_ticket_no ?? ""}`,
      city: row.ship2_city,
      state: row.ship2_state,
      zip: row.ship2_zip,
      customerName: row.customer_name,
      row,
      samsaraAddressId: usableAddressId,
      hold,
      holdReason,
      stopNotes: notes.length ? notes.join(" | ") : null,
    });
  }

  const days = sequenceStops(candidates, template, cutoff.runDates, {
    tz: config.tz,
    depotDepartLocal: config.depotDepartLocal,
    stopIncrementMin: config.stopIncrementMin,
  });

  const runs: DispatchPlanRun[] = days.map((day) => {
    const all: DispatchPlanStop[] = day.stops.map((s: SequencedStop<Candidate>) => ({
      position: s.position,
      runDay: s.runDay,
      pickTicketNo: s.row.pick_ticket_no ?? null,
      orderNo: s.row.order_no ?? null,
      customerId: s.row.customer_id ?? null,
      customerName: s.row.customer_name ?? null,
      p21ShipToId: s.row.ship_to_id != null ? String(s.row.ship_to_id) : null,
      samsaraAddressId: s.samsaraAddressId,
      scheduledArrival: s.scheduledArrival,
      stopNotes: s.stopNotes,
      estPallets: num(s.row.est_pallets),
      estCubeFt: num(s.row.est_cube_ft),
      estWeightLbs: num(s.row.est_weight_lbs),
      hold: s.hold,
      holdReason: s.holdReason,
      state: s.row.ship2_state ?? null,
      unslotted: s.unslotted,
    }));

    const holds = all.filter((s) => s.hold);
    const live = all.filter((s) => !s.hold);
    const sum = (pick: (s: DispatchPlanStop) => number) => all.reduce((n, s) => n + pick(s), 0);

    return {
      routeCode: cutoff.routeCode,
      runDate: day.runDate,
      runSeq,
      externalId: externalIdFor(cutoff.routeCode, day.runDate, runSeq),
      cutoffAtIso: cutoff.cutoffAtIso,
      lockAtIso: cutoff.lockAtIso,
      stops: live,
      holds,
      totals: {
        ordersTotal: all.length,
        stopsTotal: live.length,
        stopsHeld: holds.length,
        estPallets: sum((s) => s.estPallets),
        estCubeFt: sum((s) => s.estCubeFt),
        estWeightLbs: sum((s) => s.estWeightLbs),
      },
    };
  });

  return { runs };
}
