/* eslint-disable @typescript-eslint/no-explicit-any -- Local fluent query mocks model dynamic database responses. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ParsedRow } from "../workbook-parse";
import ExcelJS from "exceljs";
const state = vi.hoisted(() => ({ rows: [] as any[], writes: [] as any[] }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      if (table === "app_settings")
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
      if (table === "truck_capacity_sheet_map")
        return {
          select: () => ({
            limit: async () => ({
              data: [{ sheet_name: "dallas-local", route_id: "r1", active: true }],
              error: null,
            }),
          }),
        };
      if (table === "truck_capacity_sync_log")
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "log" } }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      if (table === "truck_capacity_sync_state")
        return { update: () => ({ eq: async () => ({ error: null }) }) };
      if (table !== "truck_capacity_runs") throw Error(`Unexpected table ${table}`);
      let route = "";
      const query: any = {
        select: () => query,
        eq: (_: string, id: string) => {
          route = id;
          return query;
        },
        order: () => query,
        range: () =>
          Promise.resolve({ data: state.rows.filter((r) => r.route_id === route), error: null }),
        insert: (rows: any[]) => {
          state.writes.push({ op: "insert", rows });
          state.rows.push(...rows.map((r, i) => ({ ...r, id: `id${state.rows.length + i}` })));
          return Promise.resolve({ error: null });
        },
        upsert: (rows: any[]) => {
          state.writes.push({ op: "upsert", rows });
          for (const row of rows)
            Object.assign(
              state.rows.find((r) => r.id === row.id),
              row,
            );
          return Promise.resolve({ error: null });
        },
        update: (patch: any) => ({
          in: (_: string, ids: string[]) => {
            state.writes.push({ op: "update", ids });
            for (const row of state.rows) if (ids.includes(row.id)) Object.assign(row, patch);
            return Promise.resolve({ error: null });
          },
        }),
      };
      return query;
    },
  },
}));
import { applyWorkbookRows, runWorkbookSync } from "../workbook-sync.server";

const row = (seq = 1, cap: number | null = 0.5): ParsedRow => ({
  route_id: "r1",
  run_date: "2026-09-14",
  run_seq: seq,
  capacity_frac: cap,
  vendor_pickup_frac: null,
  driver: null,
  pallet_count: null,
  returned_pallets: null,
  notes: null,
  excel_row: seq + 1,
  provenance: {
    sheet: "Dallas-Local",
    excel_row: seq + 1,
    capacity: cap,
    capacity_format: "0%",
    vendor: null,
    vendor_format: "",
  },
});
beforeEach(() => {
  state.rows = [];
  state.writes = [];
});
describe("mocked persistence", () => {
  it.each([
    "missing",
    "renamed",
    "date-error",
    "date-error-empty",
    "date-uncached",
    "blank-date",
    "blank-date-zero",
    "blank-date-formula",
  ])("rejects %s before any actual writes or missing markers", async (shape) => {
    await applyWorkbookRows([row(1, 0.7)]);
    state.writes = [];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Dallas-Local");
    ws.addRow(
      shape === "missing" ? ["Date"] : ["Date", shape === "renamed" ? "Wrong heading" : "Capacity"],
    );
    if (shape === "missing" || shape === "renamed") ws.addRow(["9/14/2026", 0.6]);
    else {
      ws.addRow(["9/1/2026", 0.6]);
      ws.addRow([
        shape === "blank-date-formula"
          ? { formula: 'IF(1=0,TODAY(),"")', result: "" }
          : shape.startsWith("blank-date")
            ? null
            : shape.startsWith("date-error")
              ? { formula: "1/0", result: { error: "#VALUE!" } }
              : { formula: "TODAY()" },
        shape === "date-error-empty" ? null : shape === "blank-date-zero" ? 0 : 0.7,
      ]);
      ws.addRow(["9/30/2026", 0.8]);
    }
    const outcome = await runWorkbookSync({
      source: "upload",
      fileBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString("base64"),
    });
    expect(outcome).toMatchObject({ ok: false, status: "error" });
    expect(state.writes).toEqual([]);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ capacity_frac: 0.7, missing_from_sheet: false });
  });
  it.each(["sharepoint", "import"] as const)(
    "repeated %s import is idempotent and preserves separate loads, zero and null",
    async (source) => {
      const rows = [row(1), row(2, 0), row(3, null)];
      expect((await applyWorkbookRows(rows, { source, markMissing: false })).inserted).toBe(3);
      expect(state.rows.map((r) => r.capacity_frac)).toEqual([0.5, 0, null]);
      state.writes = [];
      expect((await applyWorkbookRows(rows, { source, markMissing: false })).unchanged).toBe(3);
      expect(state.writes).toHaveLength(0);
      expect(state.rows[0].prior_values[0].import_provenance.capacity_format).toBe("0%");
    },
  );
  it("blocks duplicate identities and ambiguous cells before any reads or writes", async () => {
    await expect(applyWorkbookRows([row(), row()])).rejects.toThrow("Duplicate departure");
    await expect(applyWorkbookRows([row(1, 1.4)])).rejects.toThrow("Ambiguous capacity");
    expect(state.writes).toHaveLength(0);
  });
  it("preserves the full prior actual history on a same-source correction", async () => {
    await applyWorkbookRows([row()]);
    state.rows[0].prior_values.push(...Array.from({ length: 30 }, (_, n) => ({ history: n })));
    await applyWorkbookRows([row(1, 0.6)]);
    expect(state.rows[0].prior_values).toHaveLength(32);
    expect(state.rows[0].prior_values[31].changed.capacity_frac).toBe(0.5);
  });
  it("does not overwrite another source or partially insert before detecting conflict", async () => {
    await applyWorkbookRows([row()], { source: "import" });
    state.writes = [];
    await expect(applyWorkbookRows([row(2), row(1, 0.8)])).rejects.toThrow(
      "conflicts with import history",
    );
    expect(state.rows).toHaveLength(1);
    expect(state.writes).toHaveLength(0);
  });
});
