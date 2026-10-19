import { lineKey, type LineIdentity } from "./line-key";

export interface CarryoverLine extends LineIdentity {
  id?: string;
  program_id?: string;
  order_date?: string | null;
  first_invoice_date?: string | null;
  unit_price?: number | string | null;
  product_group_id?: string | null;
  included: boolean;
  exclusion_reason: string | null;
  writing_rep: string | null;
  rep_parse_confidence: string | null;
  spiff_amount: number;
}
export type Override = "manual_exclude" | "re_include" | "rep";
export type CarriedCounts = Record<Override, number>;
export interface UnmatchedEdit {
  line_key: string;
  customer_id: string | null;
  order_no: string | null;
  item_id: string | null;
  override: Override;
}
export interface CarriedField {
  lineIndex: number;
  field: "included" | "exclusion_reason" | "writing_rep" | "rep_parse_confidence";
  old_value: string | null;
  new_value: string | null;
}

function overrides(line: CarryoverLine): Override[] {
  const out: Override[] = [];
  if (line.exclusion_reason === "manual") out.push("manual_exclude");
  else if (line.included) out.push("re_include");
  if (line.rep_parse_confidence === "manual") out.push("rep");
  return out;
}

// Within each exact key, sort BOTH sides by non-editable P21 attributes, then
// original input ordinal for indistinguishable ties. Never sort by random UUID,
// PO, description, rep, included state or amount. Non-overrides consume ordinals too.
function grouped(lines: CarryoverLine[]) {
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const key = lineKey(line);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const rank = (line: CarryoverLine) => JSON.stringify([
    line.program_id ?? "", line.order_date ?? "", line.first_invoice_date ?? "",
    line.unit_price == null ? "" : Number(line.unit_price), line.product_group_id ?? "",
  ]);
  for (const indices of groups.values()) indices.sort((a, b) => {
    const left = rank(lines[a]);
    const right = rank(lines[b]);
    return (left < right ? -1 : left > right ? 1 : 0) || a - b;
  });
  return groups;
}

export function applyCarryover<T extends CarryoverLine>(snapshot: CarryoverLine[], fresh: T[]) {
  const lines = fresh.map((line) => ({ ...line }));
  const carried: CarriedCounts = { manual_exclude: 0, re_include: 0, rep: 0 };
  const unmatched: UnmatchedEdit[] = [];
  const edits: CarriedField[] = [];
  let snapshot_overrides = 0;
  const newGroups = grouped(fresh);
  for (const [key, indices] of grouped(snapshot)) {
    indices.forEach((oldIndex, ordinal) => {
      const old = snapshot[oldIndex];
      const types = overrides(old);
      snapshot_overrides += types.length;
      const newIndex = newGroups.get(key)?.[ordinal];
      if (newIndex === undefined) {
        for (const override of types) unmatched.push({
          line_key: key, customer_id: old.customer_id ?? null,
          order_no: old.order_no == null ? null : String(old.order_no), item_id: old.item_id ?? null, override,
        });
        return;
      }
      const line = lines[newIndex];
      const record = (field: CarriedField["field"], value: string | boolean | null) => {
        edits.push({ lineIndex: newIndex, field, old_value: line[field] == null ? null : String(line[field]), new_value: value == null ? null : String(value) });
      };
      if (types.includes("manual_exclude")) {
        record("included", false); record("exclusion_reason", "manual");
        line.included = false; line.exclusion_reason = "manual"; carried.manual_exclude++;
      } else if (old.included && !line.included) {
        record("included", true); record("exclusion_reason", null);
        line.included = true; line.exclusion_reason = null; carried.re_include++;
      }
      if (types.includes("rep")) {
        record("writing_rep", old.writing_rep); record("rep_parse_confidence", "manual");
        line.writing_rep = old.writing_rep; line.rep_parse_confidence = "manual"; carried.rep++;
      }
    });
  }
  return { lines, carried, unmatched, edits, snapshot_overrides };
}