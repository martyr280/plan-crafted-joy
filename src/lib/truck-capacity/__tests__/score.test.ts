import { describe, it, expect } from "vitest";
import {
  actualsByRouteDay, leadBucket, leadTimeDays, metricsOf, summarize, type ScoreInput,
} from "../score";

const row = (p: Partial<ScoreInput>): ScoreInput => ({
  routeId: "r1", forecastDate: "2026-07-20", madeOn: "2026-07-19",
  served: 0.5, predicted: 0.5, actual: 0.5, ...p,
});

describe("lead-time bucketing", () => {
  it("uses the documented boundaries", () => {
    expect(leadBucket(0)).toBe("0-2");
    expect(leadBucket(2)).toBe("0-2");
    expect(leadBucket(3)).toBe("3-7");
    expect(leadBucket(7)).toBe("3-7");
    expect(leadBucket(8)).toBe("8-14");
    expect(leadBucket(14)).toBe("8-14");
    expect(leadBucket(15)).toBe("15+");
    expect(leadBucket(90)).toBe("15+");
  });

  it("computes lead time in whole days across a DST boundary", () => {
    expect(leadTimeDays("2026-03-10", "2026-03-06")).toBe(4);
    expect(leadTimeDays("2026-07-20", "2026-07-20")).toBe(0);
  });
});

describe("error math", () => {
  it("treats over-forecast as positive bias", () => {
    const m = metricsOf([row({ served: 0.8, actual: 0.6 })]);
    expect(m.bias).toBeCloseTo(0.2, 10);
    expect(m.mae).toBeCloseTo(0.2, 10);
  });

  it("treats under-forecast as negative bias while MAE stays positive", () => {
    const m = metricsOf([row({ served: 0.4, actual: 0.9 })]);
    expect(m.bias).toBeCloseTo(-0.5, 10);
    expect(m.mae).toBeCloseTo(0.5, 10);
  });

  it("cancels opposite-signed errors in bias but not in MAE", () => {
    const m = metricsOf([row({ served: 0.8, actual: 0.6 }), row({ served: 0.4, actual: 0.6 })]);
    expect(m.bias).toBeCloseTo(0, 10);
    expect(m.mae).toBeCloseTo(0.2, 10);
  });

  it("scores predicted separately and ignores null predicted", () => {
    const m = metricsOf([
      row({ served: 0.5, predicted: 0.9, actual: 0.5 }),
      row({ served: 0.5, predicted: null, actual: 0.5 }),
    ]);
    expect(m.mae).toBeCloseTo(0, 10);
    expect(m.predictedMae).toBeCloseTo(0.4, 10);
  });

  it("returns nulls, not NaN, when n is 0", () => {
    const m = metricsOf([]);
    expect(m).toEqual({ n: 0, mae: null, bias: null, predictedMae: null });
    expect(Number.isNaN(m.mae as any)).toBe(false);
  });
});

describe("actual aggregation across run_seq", () => {
  it("averages multiple runs for the same route-day", () => {
    const m = actualsByRouteDay([
      { route_id: "r1", run_date: "2026-07-20", capacity_frac: 0.6 },
      { route_id: "r1", run_date: "2026-07-20", capacity_frac: 1.0 },
      { route_id: "r1", run_date: "2026-07-21", capacity_frac: 0.5 },
    ]);
    expect(m.get("r1|2026-07-20")).toBeCloseTo(0.8, 10);
    expect(m.get("r1|2026-07-21")).toBeCloseTo(0.5, 10);
  });

  it("ignores null capacity_frac rows without dropping the day", () => {
    const m = actualsByRouteDay([
      { route_id: "r1", run_date: "2026-07-20", capacity_frac: null },
      { route_id: "r1", run_date: "2026-07-20", capacity_frac: 0.4 },
    ]);
    expect(m.get("r1|2026-07-20")).toBeCloseTo(0.4, 10);
  });
});

describe("summarize", () => {
  it("keeps every made_on row and reports empty buckets as n=0 with null MAE", () => {
    const rows = [
      row({ forecastDate: "2026-07-20", madeOn: "2026-07-19", served: 0.7, actual: 0.5 }), // lead 1
      row({ forecastDate: "2026-07-20", madeOn: "2026-07-15", served: 0.6, actual: 0.5 }), // lead 5
      row({ forecastDate: "2026-07-20", madeOn: "2026-07-12", served: 0.9, actual: 0.5 }), // lead 8
    ];
    const s = summarize(rows);
    expect(s.overall.n).toBe(3);
    const b = new Map(s.byBucket.map((x) => [x.bucket, x]));
    expect(b.get("0-2")!.n).toBe(1);
    expect(b.get("3-7")!.n).toBe(1);
    expect(b.get("8-14")!.n).toBe(1);
    expect(b.get("15+")!.n).toBe(0);
    expect(b.get("15+")!.mae).toBeNull();
  });

  it("sorts routes by MAE descending", () => {
    const s = summarize([
      row({ routeId: "a", served: 0.55, actual: 0.5 }),
      row({ routeId: "b", served: 0.9, actual: 0.5 }),
    ]);
    expect(s.byRoute.map((r) => r.routeId)).toEqual(["b", "a"]);
  });
});
