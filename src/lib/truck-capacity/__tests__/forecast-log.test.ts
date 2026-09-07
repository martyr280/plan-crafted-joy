import { describe, it, expect } from "vitest";
import { forecastLogRowsFromDays, dedupeLogRows } from "../forecast-log";

const day = (p: Partial<any> = {}) => ({
  date: "2026-09-10", blend: null, forecast: 0.5, p21: null, final: 0.5,
  method: "baseline" as const, ...p,
});

describe("forecastLogRowsFromDays", () => {
  it("logs a baseline-served day with null model_version_id", () => {
    const rows = forecastLogRowsFromDays("r1", [day()], "2026-09-07", null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route_id: "r1", forecast_date: "2026-09-10", made_on: "2026-09-07",
      predicted: 0.5, served: 0.5, p21_guard_applied: false,
      method: "baseline", model_version_id: null,
    });
  });

  it("prefers blend over forecast as the pre-guard predicted value", () => {
    const rows = forecastLogRowsFromDays("r1", [day({ blend: 0.7, method: "blend" })], "2026-09-07", "v1");
    expect(rows[0]!.predicted).toBeCloseTo(0.7, 10);
    expect(rows[0]!.method).toBe("blend");
    expect(rows[0]!.model_version_id).toBe("v1");
  });

  it("flags a P21-guarded day and serves the P21 value", () => {
    const rows = forecastLogRowsFromDays("r1", [day({ blend: 0.4, p21: 0.9, final: 0.9, method: "blend" })], "2026-09-07", "v1");
    expect(rows[0]!.p21_guard_applied).toBe(true);
    expect(rows[0]!.served).toBeCloseTo(0.9, 10);
    expect(rows[0]!.predicted).toBeCloseTo(0.4, 10);
  });

  it("does not flag the guard when P21 is below the prediction", () => {
    const rows = forecastLogRowsFromDays("r1", [day({ blend: 0.8, p21: 0.3, final: 0.8, method: "blend" })], "2026-09-07", "v1");
    expect(rows[0]!.p21_guard_applied).toBe(false);
  });

  it("skips days with a null final", () => {
    expect(forecastLogRowsFromDays("r1", [day({ final: null })], "2026-09-07", null)).toEqual([]);
  });

  it("skips days with no pre-guard prediction at all", () => {
    expect(forecastLogRowsFromDays("r1", [day({ blend: null, forecast: null, final: 0.4 })], "2026-09-07", null)).toEqual([]);
  });
});

describe("dedupeLogRows", () => {
  const r = (method: string | null) => ({ route_id: "r1", forecast_date: "2026-09-10", made_on: "2026-09-07", method });

  it("prefers blend over model and baseline", () => {
    const out = dedupeLogRows([r("baseline"), r("model"), r("blend")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.method).toBe("blend");
  });

  it("prefers model over baseline when no blend row exists", () => {
    const out = dedupeLogRows([r("baseline"), r("model")]);
    expect(out[0]!.method).toBe("model");
  });

  it("ranks an unknown or null method last", () => {
    expect(dedupeLogRows([r(null), r("baseline")])[0]!.method).toBe("baseline");
    expect(dedupeLogRows([r("weird"), r("model")])[0]!.method).toBe("model");
  });

  it("keeps distinct keys separate", () => {
    const out = dedupeLogRows([
      r("blend"),
      { ...r("blend"), forecast_date: "2026-09-11" },
      { ...r("blend"), route_id: "r2" },
      { ...r("blend"), made_on: "2026-09-06" },
    ]);
    expect(out).toHaveLength(4);
  });
});
