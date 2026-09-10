import { describe, expect, it } from "vitest";
import { filterRoster, resolveReportDriverIdentity, DEFAULT_DRIVER_TIME_SETTINGS } from "@/lib/driver-time.server";

const base = {
  excludedDriverIds: DEFAULT_DRIVER_TIME_SETTINGS.excludedDriverIds,
  excludedDriverNamePatterns: DEFAULT_DRIVER_TIME_SETTINGS.excludedDriverNamePatterns,
  requireLicense: true,
  includeDeactivated: false,
};

const roster = [
  { id: "1", name: "Joseph Outler", licenseNumber: "O123", driverActivationStatus: "active" },
  { id: "2", name: "Ronald Fugate", licenseNumber: "F456", driverActivationStatus: "active" },
  { id: "3", name: "Nelson Roldan", licenseNumber: "R789", driverActivationStatus: "active" },
  { id: "4", name: "Dallas Warehouse", licenseNumber: null, driverActivationStatus: "active" },
  { id: "5", name: "Enyi Ukairo", licenseNumber: "U321", driverActivationStatus: "deactivated" },
];

describe("filterRoster", () => {
  it("drops shared logins without a license number", () => {
    const { roster: kept, counts } = filterRoster(roster, base);
    expect(kept.map((d) => d.id)).toEqual(["1", "2", "3"]);
    expect(counts.excludedNoLicense).toBe(0); // "Dallas Warehouse" is caught by the name pattern first
    expect(counts.excludedByPattern).toBe(1);
    expect(counts.excludedDeactivated).toBe(1);
    expect(counts.scanned).toBe(3);
  });

  it("drops an unpatterned login that has no license", () => {
    const { roster: kept, counts } = filterRoster(
      [{ id: "9", name: "Shop Tablet", licenseNumber: "", driverActivationStatus: "active" }],
      base,
    );
    expect(kept).toHaveLength(0);
    expect(counts.excludedNoLicense).toBe(1);
  });

  it("keeps deactivated drivers when the flag is on", () => {
    const { roster: kept } = filterRoster(roster, { ...base, includeDeactivated: true });
    expect(kept.map((d) => d.id)).toEqual(["1", "2", "3", "5"]);
  });

  it("keeps unlicensed drivers when the license requirement is off", () => {
    const { roster: kept } = filterRoster(
      [{ id: "9", name: "Shop Tablet", licenseNumber: null, driverActivationStatus: "active" }],
      { ...base, requireLicense: false },
    );
    expect(kept).toHaveLength(1);
  });
});

describe("resolveReportDriverIdentity", () => {
  it("resolves an exact roster name to the Samsara id", () => {
    const r = resolveReportDriverIdentity({ name: "Joseph Outler", hub: "Ocala", roster });
    expect(r).toMatchObject({ driverId: "1", matched: true });
  });

  it("resolves the report alias 'Ron Fugate' to Ronald Fugate", () => {
    expect(resolveReportDriverIdentity({ name: "Ron Fugate", hub: "Birmingham", roster }).driverId).toBe("2");
  });

  it("resolves the report alias 'Nelson Rolden' to Nelson Roldan", () => {
    expect(resolveReportDriverIdentity({ name: "Nelson Rolden*", hub: "Dallas", roster }).driverId).toBe("3");
  });

  it("never resolves a shared login with no license number", () => {
    const r = resolveReportDriverIdentity({ name: "Dallas Warehouse", hub: "Dallas", roster });
    expect(r.matched).toBe(false);
    expect(r.driverId).toBe("report:dallas:dallas-warehouse");
  });

  it("keeps the report identity when the name is absent from the roster", () => {
    const r = resolveReportDriverIdentity({ name: "Someone Else", hub: "Ocala", roster });
    expect(r).toMatchObject({ driverId: "report:ocala:someone-else", matched: false });
    expect(r.reason).toContain("no licensed Samsara driver");
  });

  it("keeps the report identity when two licensed drivers share a name", () => {
    const dupes = [
      { id: "7", name: "Chris Lee", licenseNumber: "A1", driverActivationStatus: "active" },
      { id: "8", name: "Chris Lee", licenseNumber: "A2", driverActivationStatus: "active" },
    ];
    const r = resolveReportDriverIdentity({ name: "Chris Lee", hub: "Dallas", roster: dupes });
    expect(r.matched).toBe(false);
    expect(r.reason).toContain("share the name");
  });
});
