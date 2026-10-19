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
export type UnmatchedEdit = {
  line_key: string;
  customer_id: string | null;
  order_no: string | null;
  item_id: string | null;
  override: Override;
  ambiguous?: true;
}
export interface CarriedField {
  lineIndex: number;
  field: "included" | "exclusion_reason" | "writing_rep" | "rep_parse_confidence";
  old_value: string | null;
  new_value: string | null;
}

export interface IncludedEdit {
  id: string;
  line_id: string | null;
  source: string;
  field: string;
  new_value: string | null;
  changed_at: string;
}

function latestIncludeMarkers(history: IncludedEdit[]) {
  const latest = new Map<string, IncludedEdit>();
  for (const edit of history) {
    if (!edit.line_id || edit.source !== "app" || edit.field !== "included") continue;
    const previous = latest.get(edit.line_id);
    if (!previous || edit.changed_at > previous.changed_at || (edit.changed_at === previous.changed_at && edit.id > previous.id)) latest.set(edit.line_id, edit);
  }
  return new Set([...latest].filter(([, edit]) => edit.new_value === "true").map(([id]) => id));
}

function overrides(line: CarryoverLine, markers: Set<string>): Override[] {
  const out: Override[] = [];
  if (line.exclusion_reason === "manual") out.push("manual_exclude");
  else if (line.included && ((line.flags as Record<string, unknown> | null)?.manual_include === true || (line.id && markers.has(line.id)))) out.push("re_include");
  if (line.rep_parse_confidence === "manual") out.push("rep");
  return out;
}

// Within each exact key, sort BOTH sides by non-editable P21 attributes, then
// original input ordinal for indistinguishable ties. Never sort by random UUID,
// PO, description, rep, included state or amount. Non-overrides consume ordinals too.
function grouped(lines: CarryoverLine[], keyFor: (line: CarryoverLine) => string = lineKey, eligible: (index: number) => boolean = () => true) {
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (!eligible(index)) return;
    const key = keyFor(line);
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

export function applyCarryover<T extends CarryoverLine>(snapshot: CarryoverLine[], fresh: T[], history: IncludedEdit[] = []) {
  const lines = fresh.map((line) => ({ ...line }));
  const carried: CarriedCounts = { manual_exclude: 0, re_include: 0, rep: 0 };
  const unmatched: UnmatchedEdit[] = [];
  const edits: CarriedField[] = [];
  let snapshot_overrides = 0;
  const markers = latestIncludeMarkers(history);
  const ambiguous = new Set<number>();
  const legacyKey = (line: CarryoverLine) => lineKey({ ...line, flags: {} });
  const hasLineNumber = (line: CarryoverLine) => lineKey(line) !== legacyKey(line);
  const newGroups = grouped(fresh);
  const matches = new Map<number, number>();
  const consumed = new Set<number>();
  // Reserve ALL exact matches before legacy matching, including non-overrides.
  for (const [key, indices] of grouped(snapshot, lineKey, (i) => hasLineNumber(snapshot[i]))) {
    indices.forEach((oldIndex, ordinal) => {
      const newIndex = newGroups.get(key)?.[ordinal];
      if (newIndex === undefined) return;
      matches.set(oldIndex, newIndex);
      consumed.add(newIndex);
    });
  }
  const remainingFresh = grouped(fresh, legacyKey, (index) => !consumed.has(index));
  const legacySnapshots = grouped(snapshot, legacyKey, (index) => !matches.has(index) && !hasLineNumber(snapshot[index]));
  for (const [key, indices] of legacySnapshots) {
    const candidates = remainingFresh.get(key) ?? [];
    if (indices.length > 1 || candidates.length > 1) {
      const payload = (index: number) => {
        const line = snapshot[index];
        const types = overrides(line, markers);
        return JSON.stringify([types, types.includes("rep") ? line.writing_rep : null]);
      };
      if (indices.length !== candidates.length || !indices.every((i) => payload(i) === payload(indices[0]))) {
        indices.forEach((i) => ambiguous.add(i));
        continue;
      }
    }
    indices.forEach((oldIndex, ordinal) => {
      const newIndex = candidates[ordinal];
      if (newIndex === undefined) return;
      matches.set(oldIndex, newIndex);
      consumed.add(newIndex);
    });
  }
  for (const [key, indices] of grouped(snapshot)) {
    indices.forEach((oldIndex) => {
      const old = snapshot[oldIndex];
      const newIndex = matches.get(oldIndex);
      const types = overrides(old, markers);
      snapshot_overrides += types.length;
      if (newIndex === undefined) {
        for (const override of types) unmatched.push({
          line_key: key, customer_id: old.customer_id ?? null,
          order_no: old.order_no == null ? null : String(old.order_no), item_id: old.item_id ?? null, override,
          ...(ambiguous.has(oldIndex) ? { ambiguous: true as const } : {}),
        });
        return;
      }
      const line = lines[newIndex];
      const record = (field: CarriedField["field"], value: string | boolean | null) => {
        edits.push({ lineIndex: newIndex, field, old_value: line[field] == null ? null : String(line[field]), new_value: value == null ? null : String(value) });
      };
      if (types.includes("manual_exclude")) {
        record("included", false); record("exclusion_reason", "manual");
        line.included = false; line.exclusion_reason = "manual";
        const flags = { ...(line.flags as Record<string, unknown> ?? {}) };
        delete flags.manual_include;
        line.flags = flags; carried.manual_exclude++;
      } else if (types.includes("re_include")) {
        record("included", true); record("exclusion_reason", null);
        line.included = true; line.exclusion_reason = null;
        line.flags = { ...(line.flags as Record<string, unknown> ?? {}), manual_include: true };
        carried.re_include++;
      }
      if (types.includes("rep")) {
        record("writing_rep", old.writing_rep); record("rep_parse_confidence", "manual");
        line.writing_rep = old.writing_rep; line.rep_parse_confidence = "manual"; carried.rep++;
      }
    });
  }
  return { lines, carried, unmatched, edits, snapshot_overrides };
}