// RMA Analytics :: pure aggregation layer.
//
// Everything here is deterministic and side-effect free so that (a) the server
// snapshot runner can persist monthly rollups with it, (b) the analytics
// server functions can compute live breakdowns with it, and (c) a future
// predictive layer (mirroring truck-capacity/train.ts) can consume the same
// feature shapes without re-deriving them.
//
// Deliberately NOT importing supabase or anything server-only.

import {
  bucketReason,
  emptyReasonMap,
  FAULT_BUCKETS,
  REASON_BUCKETS,
  type ReasonBucket,
} from "./reasons";

export type RmaRow = {
  rma_no?: string | null;
  rma_date?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  order_no?: string | null;
  invoice_no?: string | null;
  item_id?: string | null;
  item_desc?: string | null;
  qty?: number | string | null;
  value?: number | string | null;
  reason_code?: string | null;
  reason_desc?: string | null;
  reason_bucket?: string | null;
  route_code?: string | null;
  driver_name?: string | null;
  picker_name?: string | null;
  warehouse_id?: string | null;
};

export const DIMENSIONS = ["driver", "route", "picker", "customer", "warehouse"] as const;
export type DimensionType = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<DimensionType, string> = {
  driver: "Driver",
  route: "Route",
  picker: "Puller / picker",
  customer: "Dealer / customer",
  warehouse: "Warehouse",
};

export function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const cleaned = String(v).replace(/[$,\s]/g, "");
  const neg = /^\(.*\)$/.test(cleaned);
  const n = Number(cleaned.replace(/[()]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

export function rowBucket(r: RmaRow): ReasonBucket {
  const b = String(r.reason_bucket ?? "").trim();
  if ((REASON_BUCKETS as readonly string[]).includes(b)) return b as ReasonBucket;
  return bucketReason(r.reason_code, r.reason_desc);
}

/** Extract the raw dimension key for a row, or null when the row can't be attributed. */
export function dimensionKey(r: RmaRow, dim: DimensionType): string | null {
  const raw =
    dim === "driver" ? r.driver_name
    : dim === "route" ? r.route_code
    : dim === "picker" ? r.picker_name
    : dim === "warehouse" ? r.warehouse_id
    : r.customer_id ?? r.customer_name;
  const s = String(raw ?? "").trim();
  return s ? s : null;
}

export function dimensionLabel(r: RmaRow, dim: DimensionType, key: string): string {
  if (dim === "customer") {
    const name = String(r.customer_name ?? "").trim();
    return name ? `${name} (${key})` : key;
  }
  return key;
}

export type EntityAgg = {
  dimension: DimensionType;
  key: string;
  label: string;
  rmaCount: number;
  rmaValue: number;
  rmaQty: number;
  reasons: Record<ReasonBucket, number>;
  reasonValues: Record<ReasonBucket, number>;
  /** Shipment volume for this entity in the window, when a source exists. */
  volume: number | null;
  /** faultCount / volume — only when volume is known and > 0. */
  ratePerShipment: number | null;
  /** damaged + wrong_pick incidents. */
  faultCount: number;
  /** faultCount / rmaCount. */
  faultShare: number;
  outlier: boolean;
  outlierReason: string | null;
};

export type OutlierConfig = {
  /** Multiple of the fleet average that trips the flag. */
  multiple: number;
  /** Minimum fault incidents required before an entity can be flagged. */
  minIncidents: number;
};

export const DEFAULT_OUTLIER_CONFIG: OutlierConfig = { multiple: 2, minIncidents: 5 };

/**
 * Group rows by a dimension. `volumes` maps a normalized (lowercased) entity
 * key to that entity's shipment volume in the same window — pass an empty map
 * when no denominator is available and the UI will show "—" for rate.
 */
export function aggregateByDimension(
  rows: RmaRow[],
  dim: DimensionType,
  volumes?: Map<string, number>,
  config: OutlierConfig = DEFAULT_OUTLIER_CONFIG,
): { entities: EntityAgg[]; unattributed: number; fleetFaultShare: number; fleetRate: number | null } {
  const byKey = new Map<string, EntityAgg>();
  let unattributed = 0;

  for (const r of rows) {
    const key = dimensionKey(r, dim);
    if (!key) { unattributed++; continue; }
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        dimension: dim,
        key,
        label: dimensionLabel(r, dim, key),
        rmaCount: 0,
        rmaValue: 0,
        rmaQty: 0,
        reasons: emptyReasonMap(),
        reasonValues: emptyReasonMap(),
        volume: null,
        ratePerShipment: null,
        faultCount: 0,
        faultShare: 0,
        outlier: false,
        outlierReason: null,
      };
      byKey.set(key, agg);
    }
    const bucket = rowBucket(r);
    const value = num(r.value);
    agg.rmaCount += 1;
    agg.rmaValue += value;
    agg.rmaQty += num(r.qty);
    agg.reasons[bucket] += 1;
    agg.reasonValues[bucket] += value;
    if (FAULT_BUCKETS.includes(bucket)) agg.faultCount += 1;
  }

  const entities = Array.from(byKey.values());
  for (const e of entities) {
    e.faultShare = e.rmaCount > 0 ? e.faultCount / e.rmaCount : 0;
    const vol = volumes?.get(e.key.toLowerCase());
    e.volume = Number.isFinite(vol as number) && (vol as number) > 0 ? (vol as number) : null;
    e.ratePerShipment = e.volume ? e.faultCount / e.volume : null;
  }

  // Fleet baselines. Rate baseline is volume-weighted across entities that
  // actually have a denominator so a single low-volume route can't drag it.
  const totalCount = entities.reduce((s, e) => s + e.rmaCount, 0);
  const totalFault = entities.reduce((s, e) => s + e.faultCount, 0);
  const fleetFaultShare = totalCount > 0 ? totalFault / totalCount : 0;

  const withVol = entities.filter((e) => e.volume);
  const volSum = withVol.reduce((s, e) => s + (e.volume ?? 0), 0);
  const faultSumWithVol = withVol.reduce((s, e) => s + e.faultCount, 0);
  const fleetRate = volSum > 0 ? faultSumWithVol / volSum : null;

  for (const e of entities) {
    if (e.faultCount < config.minIncidents) continue;
    if (e.ratePerShipment !== null && fleetRate !== null && fleetRate > 0) {
      if (e.ratePerShipment >= config.multiple * fleetRate) {
        e.outlier = true;
        e.outlierReason =
          `${(e.ratePerShipment * 100).toFixed(1)}% fault rate per shipment vs ${(fleetRate * 100).toFixed(1)}% fleet average ` +
          `(${config.multiple}× threshold, ${e.faultCount} incidents)`;
      }
      continue;
    }
    if (fleetFaultShare > 0 && e.faultShare >= config.multiple * fleetFaultShare) {
      e.outlier = true;
      e.outlierReason =
        `${(e.faultShare * 100).toFixed(0)}% of its RMAs are damage/wrong-pick vs ${(fleetFaultShare * 100).toFixed(0)}% fleet average ` +
        `(${config.multiple}× threshold, ${e.faultCount} incidents; no shipment denominator available)`;
    }
  }

  entities.sort((a, b) => b.rmaValue - a.rmaValue || b.rmaCount - a.rmaCount);
  return { entities, unattributed, fleetFaultShare, fleetRate };
}

export function monthKey(dateish?: string | null): string | null {
  if (!dateish) return null;
  const s = String(dateish);
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-01`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export type MonthlyBucketRow = {
  month: string;
  rmaCount: number;
  rmaValue: number;
  reasons: Record<ReasonBucket, number>;
};

/** Overall month-over-month trend + reason mix (drives the OVERVIEW tab). */
export function monthlyTrend(rows: RmaRow[]): MonthlyBucketRow[] {
  const map = new Map<string, MonthlyBucketRow>();
  for (const r of rows) {
    const month = monthKey(r.rma_date);
    if (!month) continue;
    let e = map.get(month);
    if (!e) { e = { month, rmaCount: 0, rmaValue: 0, reasons: emptyReasonMap() }; map.set(month, e); }
    e.rmaCount += 1;
    e.rmaValue += num(r.value);
    e.reasons[rowBucket(r)] += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
}

export type EntityMonthlyAgg = {
  dimension_type: DimensionType;
  dimension_key: string;
  dimension_label: string;
  month: string;
  rma_count: number;
  rma_value: number;
  rma_qty: number;
  reason_counts: Record<ReasonBucket, number>;
  reason_values: Record<ReasonBucket, number>;
};

/**
 * Per-entity, per-month rollups persisted to `rma_entity_monthly`. This is the
 * FUTURE MODEL HOOK: a predictive layer trains on these rows, so keep the
 * shape stable and additive.
 */
export function entityMonthlyAggregates(rows: RmaRow[]): EntityMonthlyAgg[] {
  const map = new Map<string, EntityMonthlyAgg>();
  for (const r of rows) {
    const month = monthKey(r.rma_date);
    if (!month) continue;
    const bucket = rowBucket(r);
    const value = num(r.value);
    const qty = num(r.qty);
    for (const dim of DIMENSIONS) {
      const key = dimensionKey(r, dim);
      if (!key) continue;
      const id = `${dim}|${key.toLowerCase()}|${month}`;
      let e = map.get(id);
      if (!e) {
        e = {
          dimension_type: dim,
          dimension_key: key,
          dimension_label: dimensionLabel(r, dim, key),
          month,
          rma_count: 0,
          rma_value: 0,
          rma_qty: 0,
          reason_counts: emptyReasonMap(),
          reason_values: emptyReasonMap(),
        };
        map.set(id, e);
      }
      e.rma_count += 1;
      e.rma_value += value;
      e.rma_qty += qty;
      e.reason_counts[bucket] += 1;
      e.reason_values[bucket] += value;
    }
  }
  return Array.from(map.values());
}
