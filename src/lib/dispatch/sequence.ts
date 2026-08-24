// Pure stop sequencing for Samsara Route Dispatch.
//
// Samsara ignores the order of the stops array and sequences a route by
// scheduledArrivalTime. So the ONLY way we control stop order is by generating
// monotonically increasing synthetic arrival times. This module does that:
//
//   1. partition stops into run days using the route_stop_sequences template's
//      delivery_dow_label (a multi-day run like MSL01 Wed+Thu yields TWO routes)
//   2. order within a day by template position, then zip, then customer name;
//      cities absent from the template go LAST in their day group, flagged
//      { unslotted: true } so a missing template row is visible, not silent
//   3. stamp arrival times: depotDepartLocal in the hub's IANA zone plus
//      stopIncrementMin per stop, converted to UTC (DST-correct)
//
// Timezone math is reused from truck-capacity/cutoffs.ts — not reimplemented.

import { DOW_SHORT, addDaysISO, dowOfISO, zonedWallToUtc } from "@/lib/truck-capacity/cutoffs";
import { normalizeCity, normalizeState } from "./address-match";

export type SequenceTemplateRow = {
  city_norm: string;
  state: string | null;
  position: number;
  delivery_dow_label: string | null;
  is_pickup?: boolean;
};

export type SequenceStopInput = {
  /** Stable identity for the stop; used only for deterministic tie-breaks. */
  id: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  customerName: string | null;
};

export type SequencedStop<T extends SequenceStopInput> = T & {
  position: number;
  runDay: string;
  scheduledArrival: string;
  unslotted: boolean;
  isPickup: boolean;
  templatePosition: number | null;
};

export type SequencedDay<T extends SequenceStopInput> = {
  runDate: string;
  tz: string;
  stops: Array<SequencedStop<T>>;
};

export type SequenceConfig = {
  tz: string;
  /** "HH:MM" wall clock in `tz`. */
  depotDepartLocal: string;
  stopIncrementMin: number;
};

const UNSLOTTED_POSITION = 1_000_000;

function templateKey(city: string | null | undefined, state: string | null | undefined): string {
  return `${normalizeCity(city)}|${normalizeState(state)}`;
}

/** Index the template by city+state, and by city alone as a fallback. */
export function indexTemplate(rows: SequenceTemplateRow[]) {
  const byCityState = new Map<string, SequenceTemplateRow>();
  const byCity = new Map<string, SequenceTemplateRow>();
  for (const r of rows) {
    byCityState.set(templateKey(r.city_norm, r.state), r);
    const c = normalizeCity(r.city_norm);
    if (!byCity.has(c)) byCity.set(c, r);
  }
  return {
    lookup(city: string | null, state: string | null): SequenceTemplateRow | null {
      return byCityState.get(templateKey(city, state)) ?? byCity.get(normalizeCity(city)) ?? null;
    },
  };
}

/** "Wed", "wednesday", "WED" -> 3. Null when unparseable. */
export function dowFromLabel(label: string | null | undefined): number | null {
  const raw = String(label ?? "").trim().toLowerCase();
  if (!raw) return null;
  const three = raw.slice(0, 3);
  const idx = DOW_SHORT.findIndex((d) => d.toLowerCase() === three);
  return idx >= 0 ? idx : null;
}

/**
 * Choose the run date a stop belongs to. A template label that matches one of
 * the run dates wins; otherwise the stop lands on the first run date.
 */
export function runDateForStop(
  template: SequenceTemplateRow | null,
  runDates: string[],
): string {
  const first = runDates[0]!;
  const dow = dowFromLabel(template?.delivery_dow_label);
  if (dow === null) return first;
  const hit = runDates.find((d) => dowOfISO(d) === dow);
  return hit ?? first;
}

/** Wall clock "HH:MM" for depart + n increments, plus how many days it rolled. */
export function wallTimeFor(depotDepartLocal: string, incrementMin: number, index: number) {
  const [hh, mm] = depotDepartLocal.split(":").map(Number);
  const total = (hh ?? 0) * 60 + (mm ?? 0) + Math.max(0, incrementMin) * index;
  const dayOffset = Math.floor(total / 1440);
  const inDay = total - dayOffset * 1440;
  const h = Math.floor(inDay / 60);
  const m = inDay % 60;
  return { time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, dayOffset };
}

/**
 * Partition + order + time-stamp. One SequencedDay per run date, and every run
 * date is represented even when it received no stops (so callers can decide
 * whether an empty route is a hold or a no-op).
 */
export function sequenceStops<T extends SequenceStopInput>(
  stops: T[],
  template: SequenceTemplateRow[],
  runDates: string[],
  config: SequenceConfig,
): Array<SequencedDay<T>> {
  const dates = [...new Set(runDates)].sort();
  if (!dates.length) return [];
  const idx = indexTemplate(template);

  type Decorated = { stop: T; tpl: SequenceTemplateRow | null; runDay: string };
  const decorated: Decorated[] = stops.map((s) => {
    const tpl = idx.lookup(s.city, s.state);
    return { stop: s, tpl, runDay: runDateForStop(tpl, dates) };
  });

  const out: Array<SequencedDay<T>> = [];
  for (const runDate of dates) {
    const group = decorated.filter((d) => d.runDay === runDate);
    group.sort((a, b) => {
      const pa = a.tpl ? a.tpl.position : UNSLOTTED_POSITION;
      const pb = b.tpl ? b.tpl.position : UNSLOTTED_POSITION;
      if (pa !== pb) return pa - pb;
      const za = String(a.stop.zip ?? "");
      const zb = String(b.stop.zip ?? "");
      if (za !== zb) return za < zb ? -1 : 1;
      const na = String(a.stop.customerName ?? "").toUpperCase();
      const nb = String(b.stop.customerName ?? "").toUpperCase();
      if (na !== nb) return na < nb ? -1 : 1;
      return a.stop.id < b.stop.id ? -1 : a.stop.id > b.stop.id ? 1 : 0;
    });

    let lastMs = -Infinity;
    const seq: Array<SequencedStop<T>> = group.map((d, i) => {
      const { time, dayOffset } = wallTimeFor(config.depotDepartLocal, config.stopIncrementMin, i + 1);
      const date = dayOffset ? addDaysISO(runDate, dayOffset) : runDate;
      let at = zonedWallToUtc(date, time, config.tz);
      // Strict monotonicity is a hard requirement (Samsara orders by this
      // value). A DST fall-back repeat can otherwise tie or regress.
      if (at.getTime() <= lastMs) at = new Date(lastMs + 60_000);
      lastMs = at.getTime();
      return {
        ...d.stop,
        position: i + 1,
        runDay: runDate,
        scheduledArrival: at.toISOString(),
        unslotted: !d.tpl,
        isPickup: Boolean(d.tpl?.is_pickup),
        templatePosition: d.tpl ? d.tpl.position : null,
      };
    });

    out.push({ runDate, tz: config.tz, stops: seq });
  }
  return out;
}
