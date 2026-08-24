import { describe, expect, it } from "vitest";
import { diffRun, routeNameFor, type SamsaraRoute } from "../diff";
import type { DispatchPlanRun, DispatchPlanStop } from "../build";

const RUN_DATE = "2026-08-26";

function stop(over: Partial<DispatchPlanStop> = {}): DispatchPlanStop {
  return {
    position: 1,
    runDay: RUN_DATE,
    pickTicketNo: "PT1",
    orderNo: "O1",
    customerId: "C1",
    customerName: "Springfield Supply",
    p21ShipToId: "ST1",
    samsaraAddressId: "addr_1",
    scheduledArrival: "2026-08-26T12:20:00.000Z",
    stopNotes: null,
    estPallets: 1,
    estCubeFt: 10,
    estWeightLbs: 100,
    hold: false,
    holdReason: null,
    state: "MO",
    unslotted: false,
    ...over,
  };
}

function run(over: Partial<DispatchPlanRun> = {}): DispatchPlanRun {
  const stops = over.stops ?? [
    stop(),
    stop({ position: 2, orderNo: "O2", p21ShipToId: "ST2", samsaraAddressId: "addr_2", scheduledArrival: "2026-08-26T12:40:00.000Z" }),
  ];
  const base: DispatchPlanRun = {
    routeCode: "MSL01",
    runDate: RUN_DATE,
    runSeq: 1,
    externalId: `nelsonDispatch:MSL01:${RUN_DATE}:1`,
    cutoffAtIso: "2026-08-25T21:00:00.000Z",
    lockAtIso: null,
    stops,
    holds: [],
    totals: {
      ordersTotal: stops.length,
      stopsTotal: stops.length,
      stopsHeld: 0,
      estPallets: 0,
      estCubeFt: 0,
      estWeightLbs: 0,
    },
  };
  return { ...base, ...over, stops };
}


const NOW = new Date("2026-08-26T11:00:00.000Z");

function stopKeyOf(r: DispatchPlanRun, orderNo: string, shipTo: string) {
  return `${r.externalId}:${orderNo}:${shipTo}`;
}

describe("routeNameFor", () => {
  it("names the route by code and date, marking extra runs", () => {
    expect(routeNameFor(run())).toBe(`NDI MSL01 ${RUN_DATE}`);
    expect(routeNameFor(run({ runSeq: 2 }))).toBe(`NDI MSL01 ${RUN_DATE} #2`);
  });
});

describe("diffRun — create", () => {
  it("creates when Samsara has no route for the externalId", () => {
    const d = diffRun(run(), null, NOW);
    expect(d.action).toBe("create");
    if (d.action !== "create") return;
    expect(d.payload.externalIds).toEqual({ nelsonDispatch: run().externalId });
    expect(d.payload.stops).toHaveLength(2);
    // Create payload must not invent stop ids.
    expect(d.payload.stops!.every((s) => s.id === undefined)).toBe(true);
  });

  it("refuses to create a one-stop route (Samsara requires two)", () => {
    const d = diffRun(run({ stops: [stop()] }), null, NOW);
    expect(d).toEqual({ action: "noop", reason: "insufficient_stops", payload: null });
  });

  it("sets driverId when the plan supplies one, never both ids", () => {
    const d = diffRun(run(), null, NOW, { driverId: "drv_1", vehicleId: "veh_1" });
    if (d.action !== "create") throw new Error("expected create");
    expect(d.payload.driverId).toBe("drv_1");
    expect(d.payload.vehicleId).toBeUndefined();
  });
});

describe("diffRun — patch", () => {
  it("echoes the Samsara stop id of every retained stop", () => {
    const r = run();
    const existing: SamsaraRoute = {
      id: "route_1",
      name: routeNameFor(r),
      stops: [
        {
          id: "stop_a",
          scheduledArrivalTime: "2026-08-26T13:00:00.000Z",
          externalIds: { nelsonStop: stopKeyOf(r, "O1", "ST1") },
        },
        {
          id: "stop_b",
          scheduledArrivalTime: "2026-08-26T13:20:00.000Z",
          externalIds: { nelsonStop: stopKeyOf(r, "O2", "ST2") },
        },
      ],
    };
    const d = diffRun(r, existing, NOW);
    expect(d.action).toBe("patch");
    if (d.action !== "patch") return;
    expect(d.routeId).toBe("route_1");
    expect(d.payload.stops!.map((s) => s.id)).toEqual(["stop_a", "stop_b"]);
    // Proof of the failure mode this guards: a payload lacking ids would delete
    // the retained stops. Ours never emits one for a stop Samsara already has.
    expect(d.payload.stops!.some((s) => s.id === undefined)).toBe(false);
  });

  it("passes past-time stops through byte-identical and never modifies them", () => {
    const r = run();
    const pastStop = {
      id: "stop_past",
      name: "Already delivered",
      scheduledArrivalTime: "2026-08-26T09:00:00.000Z",
      addressId: "addr_old",
      notes: "left at dock",
      externalIds: { nelsonStop: "some:other:key" },
      arrivalState: "departed",
    };
    const existing: SamsaraRoute = {
      id: "route_1",
      stops: [
        pastStop,
        {
          id: "stop_b",
          scheduledArrivalTime: "2026-08-26T13:20:00.000Z",
          externalIds: { nelsonStop: stopKeyOf(r, "O2", "ST2") },
        },
      ],
    };
    const d = diffRun(r, existing, NOW);
    if (d.action !== "patch") throw new Error("expected patch");
    const emittedPast = d.payload.stops!.find((s) => s.id === "stop_past");
    expect(JSON.stringify(emittedPast)).toBe(JSON.stringify(pastStop));
    // and it is still present — never dropped
    expect(d.payload.stops![0]!.id).toBe("stop_past");
  });

  it("does not re-emit a plan stop whose key already happened", () => {
    const r = run();
    const existing: SamsaraRoute = {
      id: "route_1",
      stops: [
        {
          id: "stop_a",
          scheduledArrivalTime: "2026-08-26T09:00:00.000Z",
          externalIds: { nelsonStop: stopKeyOf(r, "O1", "ST1") },
        },
        {
          id: "stop_b",
          scheduledArrivalTime: "2026-08-26T13:20:00.000Z",
          externalIds: { nelsonStop: stopKeyOf(r, "O2", "ST2") },
        },
      ],
    };
    const d = diffRun(r, existing, NOW);
    if (d.action !== "patch") throw new Error("expected patch");
    const keys = d.payload.stops!.map((s) => s.externalIds?.["nelsonStop"]);
    expect(keys.filter((k) => k === stopKeyOf(r, "O1", "ST1"))).toHaveLength(1);
    // The one that survived is Samsara's original past record, not a rewrite.
    expect(d.payload.stops![0]!.scheduledArrivalTime).toBe("2026-08-26T09:00:00.000Z");
  });

  it("echoes a Samsara-owned driver assignment the plan does not know about", () => {
    const r = run();
    const existing: SamsaraRoute = { id: "route_1", driverId: "drv_dispatcher", stops: [] };
    const d = diffRun(r, existing, NOW);
    if (d.action !== "patch") throw new Error("expected patch");
    expect(d.payload.driverId).toBe("drv_dispatcher");
  });

  it("echoes a Samsara-owned vehicle assignment too", () => {
    const existing: SamsaraRoute = { id: "route_1", vehicleId: "veh_9", stops: [] };
    const d = diffRun(run(), existing, NOW);
    if (d.action !== "patch") throw new Error("expected patch");
    expect(d.payload.vehicleId).toBe("veh_9");
    expect(d.payload.driverId).toBeUndefined();
  });

  it("lets the plan's driver override Samsara's", () => {
    const existing: SamsaraRoute = { id: "route_1", driverId: "drv_old", stops: [] };
    const d = diffRun(run(), existing, NOW, { driverId: "drv_new" });
    if (d.action !== "patch") throw new Error("expected patch");
    expect(d.payload.driverId).toBe("drv_new");
  });
});

describe("diffRun — noop", () => {
  it("returns noop with reason 'locked' once now is at or past lock_at", () => {
    const r = run({ lockAtIso: "2026-08-26T10:00:00.000Z" });
    expect(diffRun(r, null, NOW)).toEqual({ action: "noop", reason: "locked", payload: null });
    // Exactly at the lock instant is already locked.
    expect(diffRun(r, null, new Date("2026-08-26T10:00:00.000Z")).action).toBe("noop");
    // Before it, work proceeds.
    expect(diffRun(r, null, new Date("2026-08-26T09:59:59.000Z")).action).toBe("create");
  });

  it("returns noop when the route is already in sync", () => {
    const r = run();
    const first = diffRun(r, null, NOW);
    if (first.action !== "create") throw new Error("expected create");
    const existing: SamsaraRoute = {
      id: "route_1",
      name: first.payload.name,
      stops: first.payload.stops,
    };
    expect(diffRun(r, existing, NOW)).toEqual({ action: "noop", reason: "in_sync", payload: null });
  });
});
